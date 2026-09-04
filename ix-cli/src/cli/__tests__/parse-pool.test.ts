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
   * the request, so `destroy()` waits out the full grace and then terminates --
   * which meant the test named "shuts down without hanging" was silently
   * exercising the TERMINATE FALLBACK rather than the clean path it claims,
   * and paying 2s to do it.
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

    // The hang: `destroy()` terminates every worker, each emits 'exit', and an
    // exit handler that respawns hands back a pool of live threads that nothing
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

  it("still terminates, and still returns, when a worker ignores the request", async () => {
    // The fallback is as load-bearing as the fix. A worker wedged in a long
    // native parse never reaches its message loop, and waiting on it forever is
    // the exact CLI hang the three tests above exist for. Bounded, then killed.
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

    const pool = new ParsePool(real, 2);
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

    // Well inside the grace: it answered rather than being terminated. If the
    // real worker stops understanding the message this becomes ~2s and fails.
    expect(elapsed).toBeLessThan(ParsePool.SHUTDOWN_GRACE_MS / 2);
    expect(pool.crashedTasks(), "a clean teardown is not a crash").toBe(0);
  }, 20000);
});
