import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ParsePool } from "../commands/parse-pool.js";

/**
 * These exist because this file has produced a HANG three separate ways, and
 * every one of them was found by a reviewer or by timing a real `ix ingest`
 * rather than by the suite:
 *
 *   - a worker that emitted 'error' while idle was spliced out of `workers` but
 *     left in `idle`, so a later `drain()` posted to a dead thread;
 *   - an 'exit' listener added to close that hole treated `destroy()`'s own
 *     `terminate()` as a crash and respawned the pool it was closing, and a
 *     worker thread refs the event loop, so the CLI hung after printing its
 *     summary;
 *   - the respawn cap that bounded THAT could empty the pool, and only the
 *     queue existing at that instant was resolved -- every later `parse()`
 *     waited forever.
 *
 * Each test below is one of those. They use real worker threads, because every
 * one of these bugs is in the interaction with the thread lifecycle and a fake
 * would have reproduced none of them.
 */
describe("ParsePool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ix-parse-pool-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a worker and return its path. */
  function worker(name: string, body: string): string {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, body, "utf8");
    return path;
  }

  /**
   * Answers parses, and honours the shutdown request like the real worker.
   *
   * The `__shutdown` branch is not decoration. Without it this fixture ignores
   * the request, so `destroy()` waits out the full grace and then gives up on
   * the worker -- which meant the test named "shuts down without hanging" was
   * silently exercising the FALLBACK rather than the clean path it claims, and
   * paying 2s to do it.
   */
  const ECHO = `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', (msg) => {
      if (msg && msg.__shutdown) { parentPort.close(); return; }
      parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
    });
  `;

  /** Exits on the first message, without ever emitting 'error'. */
  const QUIET_DEATH = `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', () => { process.exit(1); });
  `;

  /** Dies on construction, deterministically — the spawn-loop shape. */
  const BORN_DEAD = `
    process.exit(1);
  `;

  /** Answers its first message, then faults while IDLE. */
  const IDLE_FAULT = `
    import { parentPort } from 'node:worker_threads';
    let served = 0;
    parentPort.on('message', (msg) => {
      if (msg && msg.__shutdown) { parentPort.close(); return; }
      parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
      if (++served === 1) setTimeout(() => { throw new Error('idle fault'); }, 20);
    });
  `;

  it("parses through the pool and shuts down without hanging", async () => {
    const pool = new ParsePool(worker("echo", ECHO), 2);
    pool.init();

    const results = await Promise.all([pool.parse("a.ts", "x"), pool.parse("b.ts", "y")]);

    expect(results).toEqual([{ filePath: "a.ts" }, { filePath: "b.ts" }]);
    expect(pool.crashedTasks()).toBe(0);

    // The hang: shutting a worker down makes it emit 'exit', and an exit
    // handler that respawns hands back a pool of live threads that nothing
    // owns. If that happens this test still passes -- the process is what hangs
    // -- so `crashedTasks()` is asserted as the observable proxy: a deliberate
    // teardown must not be recorded as a crash.
    await pool.destroy();
    expect(pool.crashedTasks(), "destroy() must not read as a crash").toBe(0);
  });

  it("resolves the in-flight task of a worker that dies without an error", async () => {
    // `parseFile` catches its own exceptions, so a worker that goes quiet --
    // `process.exit()`, or the thread killed under the runtime -- emits no
    // 'error' at all. Before the 'exit' listener its task never settled and the
    // `Promise.all` over the parse batch waited forever.
    const pool = new ParsePool(worker("quiet", QUIET_DEATH), 1);
    pool.init();

    await expect(pool.parse("a.ts", "x")).resolves.toBeNull();
    expect(pool.crashedTasks()).toBeGreaterThan(0);

    await pool.destroy();
  });

  it("takes a worker that faults while IDLE out of the free list", async () => {
    // The first of the three hangs. A worker can emit 'error' with no task in
    // flight -- an uncaught async throw, ERR_WORKER_OUT_OF_MEMORY between
    // tasks -- and it was spliced out of `workers` but left in `idle`, so the
    // next `drain()` popped the terminated thread and posted to nothing: that
    // task's promise never settled.
    const pool = new ParsePool(worker("idlefault", IDLE_FAULT), 1);
    pool.init();

    expect(await pool.parse("first.ts", "x")).toEqual({ filePath: "first.ts" });
    // Let the fault land while the pool is idle.
    await new Promise((resolve) => setTimeout(resolve, 120));

    // TWO at once, deliberately. `drain()` pops the free list, so a single
    // parse takes the replacement worker that `onError` just pushed and never
    // touches the dead entry underneath it -- the bug hides completely at
    // depth 1. The second parse is the one that reaches the terminated thread,
    // posts to nothing, and never settles.
    const both = await Promise.all([pool.parse("a2.ts", "x"), pool.parse("b2.ts", "x")]);
    expect(both).toEqual([{ filePath: "a2.ts" }, { filePath: "b2.ts" }]);

    await pool.destroy();
  });

  it("does not queue forever once the respawn cap has emptied the pool", async () => {
    // A worker that dies deterministically on construction burns through the
    // cap. Draining only the queue that existed at that instant left every
    // LATER parse waiting on a `drain()` that is a no-op with no idle workers.
    const pool = new ParsePool(worker("dead", BORN_DEAD), 1);
    pool.init();

    // Enough calls to outlast the cap, then more after it.
    const first = await Promise.all(
      Array.from({ length: 20 }, (_, i) => pool.parse(`f${i}.ts`, "x")),
    );
    expect(first.every((r) => r === null)).toBe(true);

    // The regression: these arrive after the pool is dead.
    await expect(pool.parse("later.ts", "x")).resolves.toBeNull();
    await expect(
      Promise.all([pool.parse("l1.ts", "x"), pool.parse("l2.ts", "x")]),
    ).resolves.toEqual([null, null]);

    // And every one of them is counted, so the stitch gate sees the loss.
    expect(pool.crashedTasks()).toBeGreaterThanOrEqual(23);

    await pool.destroy();
  });

  it("asks a worker to end itself rather than terminating it", async () => {
    // The fourth way this file has gone wrong, and the only one that was not a
    // hang. `Worker.terminate()` tears a thread down from outside, and doing
    // that to one that has loaded the tree-sitter native bindings segfaults the
    // PROCESS -- an idle worker that parsed a single file is enough, because
    // the crash is in disposing an isolate that still holds the addon. Twenty
    // teardowns per process, six runs each, on Windows/Node 26:
    //
    //   terminate()                    5 of 6 runs died with SIGSEGV (139)
    //   worker closes its own port     0 of 6
    //
    // `destroy()` runs in `ingestFiles`'s outermost `finally`, so this was one
    // `ix map` in roughly twelve exiting 139 with every patch committed and the
    // summary printed -- which is why nobody reported it.
    //
    // Asserted through a marker the worker writes when ASKED to go, because the
    // crash itself is probabilistic: a test that just tore pools down would
    // pass against the bug most of the time. This one pins the mechanism.
    const marker = join(dir, "asked-to-go");
    const path = worker(
      "polite",
      `
      import { parentPort } from 'node:worker_threads';
      import { writeFileSync } from 'node:fs';
      parentPort.on('message', (msg) => {
        if (msg && msg.__shutdown) {
          writeFileSync(${JSON.stringify(marker)}, 'bye', 'utf8');
          parentPort.close();
          return;
        }
        parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
      });
    `,
    );

    const pool = new ParsePool(path, 2);
    pool.init();
    // Parse first: an untouched worker has not loaded the addon, and it is the
    // loaded-then-idle thread that crashes.
    await Promise.all([pool.parse("a.ts", "x"), pool.parse("b.ts", "x")]);
    await pool.destroy();

    expect(existsSync(marker), "destroy() must ask, not terminate").toBe(true);
  });

  it("returns, rather than waiting forever, when an IDLE worker ignores the request", async () => {
    // The fallback, for the case it is actually for: a worker sitting in its
    // event loop that simply will not answer. Waiting on it forever is the CLI
    // hang the three tests above exist for, so the pool stops waiting and
    // unrefs it. The busy case is a later test, and is deliberately different.
    const path = worker(
      "stubborn",
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', () => { /* answers nothing, leaves nothing */ });
      setInterval(() => {}, 1000);
    `,
    );

    const pool = new ParsePool(path, 1);
    pool.init();

    const started = Date.now();
    await pool.destroy();
    const elapsed = Date.now() - started;

    // Derived from the constant, not restated as a magic number. Tuning the
    // grace down is a legitimate change and must not fail a test about
    // waiting-then-returning.
    expect(elapsed).toBeGreaterThanOrEqual(ParsePool.SHUTDOWN_GRACE_MS * 0.75);
    // ...and it did NOT wait forever. Without the timeout this never resolves
    // and the failure is a suite timeout with no explanation attached.
    expect(elapsed).toBeLessThan(ParsePool.SHUTDOWN_GRACE_MS * 4);
  }, 15000);

  it("still gives up on a worker that was busy when the grace expired, once it goes idle", async () => {
    // The hang I introduced while fixing the previous finding. The busy branch
    // `return`ed instead of re-arming, so a worker that happened to be busy at
    // the ONE moment the timer fired permanently disarmed the fallback: it
    // finished its parse, went idle, refused the shutdown, and nothing was left
    // to terminate it. `destroy()` never resolved.
    //
    // Reproduced against the broken version at a 5s cutoff before writing this.
    const path = worker(
      "busy-then-stubborn",
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.__shutdown) return;          // refuses, once idle
        const end = Date.now() + 400; while (Date.now() < end);
        parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
      });
      setInterval(() => {}, 1000);                  // and stays alive
    `,
    );

    const pool = new ParsePool(path, 1, 100);
    pool.init();
    const parsing = pool.parse("slow.ts", "x");
    // Destroy while it is mid-parse, so the first expiry lands on a BUSY worker.
    await new Promise(resolve => setTimeout(resolve, 50));

    const started = Date.now();
    await pool.destroy();

    // It returned at all -- that is the regression. And it waited for the parse
    // rather than killing it, which is the rule the previous test pins.
    expect(Date.now() - started).toBeGreaterThan(300);
    await expect(parsing).resolves.toEqual({ filePath: "slow.ts" });
  }, 20000);

  it("gives a worker that has just gone idle a full grace before giving up", async () => {
    // Idleness has to be OBSERVED for a grace period, not read as an instant.
    // The worker posts its result, the main thread deletes its `active` entry,
    // and only then does the worker reach the queued `__shutdown` and start
    // unwinding its isolate. An expiry landing in that window sees a worker
    // that looks idle and unresponsive and abandons it -- one that was about to
    // answer. Under the old `terminate()` this was the ~8% per-teardown
    // segfault itself; the pool unrefs now, so the cost is a lost parse result
    // rather than the process, and it is still wrong.
    //
    // The timings are chosen so the two rules give different answers, which is
    // the only way to catch this. Grace 300ms, so ticks land at 300/600/900. A
    // 580ms parse puts the result 20ms before a tick, and the worker then
    // spends 150ms in its shutdown handler:
    //
    //   instantaneous idleness -> abandons at 600, mid-handler, no marker
    //   observed idleness      -> first idle tick at 600 starts the clock, so
    //                             giving up would be 900; the worker finishes
    //                             at 730 and exits on its own, marker written
    const marker = join(dir, "unwound-cleanly");
    const path = worker(
      "slow-to-unwind",
      `
      import { parentPort } from 'node:worker_threads';
      import { writeFileSync } from 'node:fs';
      const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
      parentPort.on('message', (msg) => {
        if (msg && msg.__shutdown) {
          spin(150);                       // stands in for isolate teardown
          writeFileSync(${JSON.stringify(marker)}, 'clean', 'utf8');
          parentPort.close();
          return;
        }
        spin(580);
        parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
      });
    `,
    );

    const pool = new ParsePool(path, 1, 300);
    pool.init();
    const parsing = pool.parse("slow.ts", "x");
    await pool.destroy();

    await expect(parsing).resolves.toEqual({ filePath: "slow.ts" });
    expect(
      existsSync(marker),
      "a worker that just went idle must not be killed mid-teardown",
    ).toBe(true);
  }, 20000);

  it("gives up on a worker that stays busy past the hard deadline", async () => {
    // The bound on the busy branch. Waiting while a worker is mid-parse is
    // right -- it is about to answer -- but waiting FOREVER is a hang, and
    // `destroy()` is the first statement of `ingestFiles`'s outermost
    // `finally`, so it stops the run before it can print anything at all.
    //
    // An earlier revision did wait forever, reasoning that killing a busy
    // worker "buys nothing". True, but the conclusion did not follow: the pool
    // does not have to kill it to stop waiting on it. This fixture is a worker
    // that never reaches its message loop, and the assertion is simply that
    // `destroy()` still returns.
    const path = worker(
      "never-finishes",
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', () => {
        // Busy well past the 500ms ceiling, then gone. Bounded on purpose, and
        // kept short: the pool unrefs rather than terminates now, so this burns
        // a core until it returns, overlapping the tests that follow.
        const end = Date.now() + 2000; while (Date.now() < end);
        process.exit(0);
      });
    `,
    );

    // A 500ms ceiling rather than the real 10s: what is being asserted is that
    // a ceiling EXISTS and is honoured, which is precisely what the unbounded
    // version lacked. Spending the production value here would add ten seconds
    // to every leg of the matrix and prove nothing extra.
    const pool = new ParsePool(path, 1, 100, 500);
    pool.init();
    const wedged = pool.parse("spin.ts", "x");
    await new Promise(resolve => setTimeout(resolve, 50));

    const started = Date.now();
    await Promise.race([
      pool.destroy(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("destroy() never returned")), 10000),
      ),
    ]);

    // It returned, by letting go of the worker once the deadline passed --
    // long before that 5s spin finishes, which is the point.
    expect(Date.now() - started).toBeLessThan(3000);
    // And the task that worker was holding still settles, so the `Promise.all`
    // over the parse batch cannot hang either.
    await expect(wedged).resolves.toBeNull();
  }, 20000);

  it("survives an abandoned worker that throws after the pool let go", async () => {
    // Letting go means the thread is still ALIVE, so its listeners matter.
    // Dropping them all -- which is the obvious way to stop an abandoned worker
    // pinning the whole `ParsePool` object graph -- leaves a live Worker with
    // no 'error' listener, and an unhandled 'error' event is a process-level
    // crash. A wedged parse that eventually throws would take an `ix mcp`
    // server down with it.
    //
    // So the give-up path drops the pool's listeners and attaches a no-op
    // 'error' handler that closes over nothing. Measured both ways with a
    // worker that throws 900ms after being abandoned: without the handler 3 of
    // 3 runs died, with it 0 of 3.
    //
    // The assertion below is not what guards this: survival is. Measured, so
    // that the next reader does not have to guess at the failure shape -- with
    // the handler removed the run exits 1 with an "Unhandled Errors: late boom"
    // section while still printing "Tests 13 passed". Reading the Tests line
    // alone would call that green.
    const path = worker(
      "late-thrower",
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', () => { /* never answers */ });
      setTimeout(() => { throw new Error('late boom from an abandoned worker'); }, 400);
    `,
    );

    const pool = new ParsePool(path, 1, 100, 300);
    pool.init();
    await pool.destroy();

    // Outlive the throw, which lands after the pool has already let go.
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(pool.crashedTasks(), "nothing was dispatched to it").toBe(0);
  }, 20000);

  it("resolves parses still queued when the pool is destroyed", async () => {
    // `destroy()` left `this.queue` untouched while `onResult` still called
    // `drain()`, so a worker finishing its last parse could be handed a queued
    // file BEHIND the `__shutdown` already sitting in its port. It closed
    // first, and that task's promise never settled -- and `onError`
    // early-returns once `destroyed` is set, so it was not counted either. A
    // silently lost file that `crashedTasks()` reported as zero, which is the
    // number the stitch gate and the mtime baseline trust.
    const path = worker(
      "slowecho",
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.__shutdown) { parentPort.close(); return; }
        const end = Date.now() + 300; while (Date.now() < end);
        parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
      });
    `,
    );

    // One worker: the first parse is dispatched, the second stays queued.
    const pool = new ParsePool(path, 1, 200);
    pool.init();
    const dispatched = pool.parse("a.ts", "x");
    const queued = pool.parse("b.ts", "x");
    await new Promise(resolve => setTimeout(resolve, 50));

    await pool.destroy();

    await expect(dispatched).resolves.toEqual({ filePath: "a.ts" });
    // Settles rather than hanging forever...
    await expect(queued).resolves.toBeNull();
    // ...and is NOT counted. Every gate that reads `crashedParses()` -- the
    // mtime baseline, the pre-migration delete guard, both stitch gates -- runs
    // inside `ingestFiles`'s `try`, strictly before the `finally` that calls
    // `destroy()`. Counting here could only move the printed summary, making it
    // disagree with the baseline decision already taken.
    expect(pool.crashedTasks(), "too late for any gate to see it").toBe(0);
  }, 20000);

  it("waits for a worker that is mid-parse instead of terminating it", async () => {
    // The rule the previous test cannot check, because its fixture wedges in
    // JAVASCRIPT and `terminate()` kills that instantly. A real parse blocks
    // inside the addon, where a V8 termination interrupt has no JS boundary to
    // fire at, so `terminate()` waits for the call to return anyway -- measured
    // at 3981ms against 4s of CPU-bound native work on Node 26. Terminating a
    // busy worker therefore costs exactly as much as asking does and adds back
    // the segfault, on a thread that was about to answer.
    //
    // `pbkdf2Sync` stands in for a long parse: same shape, no tree-sitter
    // needed. The grace is 200ms and the work is ~1.3s, so the margin holds
    // even on a machine several times faster than this one.
    const marker = join(dir, "finished-its-parse");
    const path = worker(
      "busy",
      `
      import { parentPort } from 'node:worker_threads';
      import { writeFileSync } from 'node:fs';
      import { pbkdf2Sync } from 'node:crypto';
      parentPort.on('message', (msg) => {
        if (msg && msg.__shutdown) {
          writeFileSync(${JSON.stringify(marker)}, 'graceful', 'utf8');
          parentPort.close();
          return;
        }
        pbkdf2Sync('p', 's', 4000000, 64, 'sha512');
        parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
      });
    `,
    );

    // An explicit, huge ceiling. Without it this test rides the production 10s
    // `SHUTDOWN_MAX_WAIT_MS`, and the KDF -- ~1.5s alone, measured at 2.5s when
    // an abandoned fixture from an earlier test is still spinning -- only has
    // to be a few times slower again --
    // an instrumented coverage leg, a loaded macos-14 runner -- for the pool to
    // give up first and the marker never to be written. It would then fail as
    // "a busy worker must be asked", reading as a real regression rather than a
    // timing miss.
    const pool = new ParsePool(path, 1, 200, 120000);
    pool.init();

    // Do NOT await: destroy() has to run while the parse is still in flight.
    const parsing = pool.parse("slow.ts", "x");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const started = Date.now();
    await pool.destroy();
    const elapsed = Date.now() - started;

    // It outlasted the grace rather than terminating at it...
    expect(elapsed).toBeGreaterThan(250);
    // ...the parse it was in the middle of still returned its result...
    await expect(parsing).resolves.toEqual({ filePath: "slow.ts" });
    // ...and the worker went by ANSWERING, which is the whole point: under the
    // old rule it was terminated mid-native-call, which is the segfault.
    expect(existsSync(marker), "a busy worker must be asked, never terminated").toBe(true);
    expect(pool.crashedTasks(), "waiting for a parse is not a crash").toBe(0);
  }, 20000);

  it("shuts the REAL parse worker down through the same protocol", async () => {
    // The one test that binds the two packages. `ix-cli` does not depend on
    // `@ix/core-ingestion` as a package -- it loads the built worker by
    // relative path -- so `__shutdown` is a bare literal in three unlinked
    // places: here, `parse-pool.ts`, and `core-ingestion/src/parse-worker.ts`.
    // Every other test in this file uses an inline fixture that hardcodes the
    // literal itself, so renaming or dropping the handler in the real worker
    // would leave the whole suite green while every `ix map` teardown quietly
    // reverted to grace-then-terminate: the exact segfault this is all for.
    const real = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../core-ingestion/dist/parse-worker.js",
    );
    expect(existsSync(real), `build core-ingestion first: ${real}`).toBe(true);

    // A deliberately huge grace, so this cannot pass or fail on how fast the
    // machine is. If the real worker still understands `__shutdown` it exits in
    // milliseconds; if it does not, teardown waits the full 10s and misses the
    // bound by a factor of three, on any runner.
    const pool = new ParsePool(real, 2, 10000);
    pool.init();
    // Parse for real, so the threads have the tree-sitter addon loaded -- an
    // untouched worker does not, and it is the loaded-then-idle thread that
    // crashes under `terminate()`.
    const results = await Promise.all([
      pool.parse("a.ts", "export function a(): number { return 1; }"),
      pool.parse("b.ts", "export function b(): number { return 2; }"),
    ]);
    expect(
      results.every((r) => r !== null),
      "the real worker should parse these",
    ).toBe(true);

    const started = Date.now();
    await pool.destroy();
    const elapsed = Date.now() - started;

    // It answered rather than being terminated.
    expect(elapsed).toBeLessThan(3000);
    expect(pool.crashedTasks(), "a clean teardown is not a crash").toBe(0);
  }, 20000);
});
