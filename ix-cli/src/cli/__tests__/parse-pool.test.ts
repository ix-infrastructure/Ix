import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  /**
   * Faults ONCE per pool, not once per worker.
   *
   * `let served = 0` was per-thread, so the replacement armed its own fault
   * shortly after serving `a2.ts` -- and `b2.ts` is only posted once the
   * parent has received a2's result and re-drained. Miss that window on a
   * busy machine and the replacement dies with `b2.ts` in flight, which
   * `onError`
   * resolves to null: the exact Ix#567 signature, from the harness rather
   * than the pool. Fixing only the first wait would have left this half of
   * the race in place.
   *
   * The marker is a file because the arming has to be visible to the NEXT
   * thread, and these fixtures share nothing else.
   */
  const IDLE_FAULT_ONCE = (marker: string): string => `
    import { parentPort, threadId } from 'node:worker_threads';
    import { writeFileSync } from 'node:fs';
    const marker = ${JSON.stringify(marker)};

    // Claim at MODULE SCOPE, once per thread, before any message is
    // served. The previous revision claimed inside the message handler,
    // which put a filesystem write on the path of every parse: the
    // replacement re-attempted it while serving \`b2.ts\`, and a transient
    // EPERM there faulted a worker with a task in flight -- producing
    // \`b2.ts -> null\`, which is the Ix#567 signature this whole test exists
    // to tell apart from a harness problem. The old fixture did no I/O at
    // all, so that was exposure this PR introduced. Here the write happens
    // once, before the pool can dispatch anything, and the handler touches
    // no filesystem at all.
    //
    // \`wx\` because it is one atomic syscall: \`existsSync\` then write is two,
    // and two threads can both pass the check. That cannot happen at this
    // pool's concurrency of 1, but the guarantee is stated
    // unconditionally, and this is what makes it true at any size.
    let isFaulter = false;
    try {
      writeFileSync(marker, threadId + '\\n', { flag: 'wx' });
      isFaulter = true;
    } catch (err) {
      // EEXIST is the expected answer: another thread holds the claim.
      // Anything else means THIS thread failed to claim for an unrelated
      // reason, and the two cases differ:
      //
      //   the FIRST thread fails  -- at concurrency 1 it is the only worker,
      //     so isFaulter stays false, nothing ever throws, nothing dies
      //     and nothing respawns. The run is NOT green; it fails in
      //     waitUntil, which reads this file to say so.
      //   a REPLACEMENT fails     -- the fault already happened, so the test
      //     reaches its assertions, and the .failed check below is what
      //     catches it.
      //
      // Recorded rather than rethrown for both. A previous revision rethrew
      // and claimed that surfaced the problem; it does not -- it only moves
      // which thread faults. Best-effort: if this write fails too there is
      // nothing left to say with.
      if (err.code !== 'EEXIST') {
        try {
          writeFileSync(marker + '.failed', threadId + ' ' + err.code + '\\n', { flag: 'a' });
        } catch {}
      }
    }

    let armed = false;
    parentPort.on('message', (msg) => {
      if (msg && msg.__shutdown) { parentPort.close(); return; }
      parentPort.postMessage({ ok: true, result: { filePath: msg.filePath } });
      // The delay exists so the parent has consumed this reply before the
      // fault lands: 'message' and 'error' reach it on different channels,
      // so a parent descheduled across both can process the 'error' first,
      // find the task still in \`active\`, and resolve it null -- failing the
      // first.ts assertion with the very signature this test is meant to
      // distinguish. It was 20ms, the same order as the scheduling delays
      // that caused the original flake; it is 250ms now.
      //
      // What this does NOT do is remove the ordering dependency, and it
      // cannot: the worker has no way to learn that its reply was consumed,
      // and a fault raised while a task IS in flight never leaves a stale
      // entry in \`idle\`, which is the whole bug. So the premise needs an
      // idle fault, an idle fault needs a delay, and this only makes the
      // required parent stall implausible rather than merely unlikely.
      if (isFaulter && !armed) {
        armed = true;
        setTimeout(() => { throw new Error('idle fault'); }, 250);
      }
    });
  `;

  /**
   * Poll until `cond` holds. Deliberately not a fixed sleep: every wait in
   * this file that is really "wait for the pool to observe something" should
   * be bounded by the observation, so it costs a few ms when idle and still
   * passes on a runner that is thrashing. The timeout only decides how long
   * to wait before calling it a failure, so it can be generous.
   */
  const waitUntil = async (
    cond: () => boolean,
    // A thunk, not just a string, so the message can be built when the wait
    // FAILS. A caller waiting on something the fixture arranges needs to say
    // "the fixture never armed" rather than "the pool never reacted", and it
    // can only tell them apart at that moment.
    what: string | (() => string),
    timeoutMs = 10000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) {
        throw new Error(`waitUntil timed out: ${typeof what === "string" ? what : what()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

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
    const marker = join(dir, "idle-fault-armed");
    const pool = new ParsePool(worker("idlefault", IDLE_FAULT_ONCE(marker)), 1);
    pool.init();

    expect(await pool.parse("first.ts", "x")).toEqual({ filePath: "first.ts" });
    // Wait for the fault to LAND, not for a duration. The fixture throws
    // 250ms after serving, and this was `setTimeout(120)` -- ample when the
    // machine is idle (0 failures in 10 runs) and is not when it is busy: 1 of
    // 8 runs under saturating CPU load, where the 'error' event had not been
    // delivered before the two parses below went out. The test then failed on
    // `b2.ts` coming back null, which looks exactly like the bug it guards.
    //
    // `workerDeaths()` is the pool's own signal that `onError` has REACTED to
    // a death -- it advances before `spawnWorker()` and `drain()`, so it means
    // begun, not finished. That is enough here, and not because of the poll
    // interval: `waitUntil` evaluates its condition once SYNCHRONOUSLY before
    // any timer, so a 5ms tick guarantees nothing. What guarantees it is that
    // this test body is async and so cannot be running inside `onError` --
    // the handler has always returned before any line here executes. The
    // distinction matters to anyone copying the `workerDeaths() > before`
    // pattern into a synchronous callback, which the accessor's own doc
    // warns against.
    // `> 0` is only correct because this is the FIRST death of the run. The
    // counter is monotonic and never resets, so a second wait written this
    // way returns immediately -- a silent no-op, which is the same class of
    // bug this test was fixed for. A later fault must capture a baseline
    // first: `const before = pool.workerDeaths()` then
    // `() => pool.workerDeaths() > before`.
    await waitUntil(
      () => pool.workerDeaths() > 0,
      // Ask the fixture first. If its claim failed there is no fault to wait
      // for, and reporting that the pool never reacted would blame the pool
      // for a harness problem -- the misdiagnosis this whole test exists to
      // prevent. At concurrency 1 that is the ONLY worker, so nothing
      // respawns and this wait is where it surfaces; the `.failed` assertion
      // below never gets to run.
      () =>
        existsSync(`${marker}.failed`)
          ? `the fixture could not claim the fault: ${readFileSync(`${marker}.failed`, "utf8").trim()}`
          : "the idle fault never reached the pool",
    );

    // TWO at once, deliberately. `drain()` pops the free list, so a single
    // parse takes the replacement worker that `onError` just pushed and never
    // touches the dead entry underneath it -- the bug hides completely at
    // depth 1. The second parse is the one that reaches the terminated thread,
    // posts to nothing, and never settles.
    const both = await Promise.all([pool.parse("a2.ts", "x"), pool.parse("b2.ts", "x")]);
    expect(both).toEqual([{ filePath: "a2.ts" }, { filePath: "b2.ts" }]);
    // The once-per-pool contract is ENFORCED by the fixture's `wx` flag, which
    // makes a second arming impossible rather than detectable. This asserts
    // that the enforcement is still there and did its job: exactly one thread
    // armed, so `b2.ts` was never racing a replacement's timer.
    //
    // Be precise about what it can and cannot fail on, because two earlier
    // revisions got this wrong in opposite directions. It fails if the `wx`
    // claim is weakened to an append, and if the marker mechanism is replaced
    // by per-thread counting (both verified by mutation, 3 of 3). It does NOT
    // independently detect "a replacement armed too" -- with `wx` in place
    // that cannot happen, so adding a redundant per-thread guard leaves this
    // green, which is correct and not a gap.
    //
    // What it replaced was an assertion on `workerDeaths()`, which pinned
    // nothing: the replacement's fault is a 250ms timer and the parses above
    // take a few ms, so the count still reads 1 either way. Reverting the
    // fixture passed that one 5 runs out of 5.
    // Read through `existsSync`, so a marker that was never written fails as
    // "arm exactly one fault" rather than as a raw ENOENT. `waitUntil` above
    // only proves SOME respawn happened -- a fixture that died during module
    // evaluation would satisfy it and never arm -- and the ENOENT would then
    // point at this line instead of at the contract.
    // No thread failed to claim for an unrelated reason. This catches a
    // REPLACEMENT's claim failing -- it does not catch the first thread's,
    // because at concurrency 1 that is the only worker, nothing respawns, and
    // the `waitUntil` thunk above reports it before execution ever reaches
    // here. The two checks cover different threads; neither covers both.
    expect(
      existsSync(`${marker}.failed`) ? readFileSync(`${marker}.failed`, "utf8") : "",
      "a worker failed to claim the fault for a reason other than EEXIST",
    ).toBe("");
    const armings = (existsSync(marker) ? readFileSync(marker, "utf8") : "")
      .split("\n")
      // `.filter(Boolean)`, not `.trim()`: an empty file trims to "" and then
      // splits to [""], so ZERO armings would satisfy `toHaveLength(1)` and
      // this check would be inert. Unreachable today only because the fault
      // demonstrably landed above -- but the obvious future fix for the
      // ENOENT path is to pre-create the marker, which would walk straight
      // into it.
      .filter(Boolean);
    expect(armings, "the fixture must arm exactly one fault for the whole pool").toHaveLength(1);

    // Kept, but for what it is: a cheap check that no EXTRA fault landed
    // during the two parses. It is not the guard for the line above.
    expect(pool.workerDeaths(), "no further worker died during the parses").toBe(1);

    await pool.destroy();
  });

  it("does not queue forever once the respawn cap has emptied the pool", async () => {
    // A worker that dies deterministically on construction burns through the
    // cap. Draining only the queue that existed at that instant left every
    // LATER parse waiting on a `drain()` that is a no-op with no idle workers.
    // Named, because the death count below is derived from it as well as from
    // the cap -- see there.
    const concurrency = 1;
    const pool = new ParsePool(worker("dead", BORN_DEAD), concurrency);
    pool.init();

    // Enough calls to outlast the cap, DERIVED from it. A hard-coded depth
    // makes the derivation below one-directional: lowering `MAX_RESPAWNS`
    // still works, but raising it past that depth means the queue drains
    // before the pool reaches the latch, and the death assertion then fails
    // with a message accusing the counter -- which is the exact failure the
    // derivation exists to prevent. `MAX_RESPAWNS` is documented as tunable,
    // so that is a reachable edit, not a hypothetical one.
    const postLatch = 3; // the parses issued below, after the pool is dead
    // Headroom, so the queue is still non-empty when `dead` latches. Unrelated
    // to `postLatch` above; they are equal by coincidence, and unifying them
    // would invent a coupling that does not exist.
    //
    // This is the constant that makes this test exercise the branch it is
    // named for, and it is worth knowing that no other assertion here
    // protects it: both of the ones below hold at `headroom = 0` too, because
    // then every queued task is consumed by a death and none is stranded.
    // Mutation-checked -- deleting the strand-and-resolve body from the cap
    // branch in `parse-pool.ts` SURVIVES at 0 and is killed at 3, where the
    // three stranded parses never settle and this hangs to the timeout. So
    // trimming it silently turns a queue-stranding test into one that only
    // covers in-flight losses.
    const headroom = 3;
    const queued = ParsePool.MAX_RESPAWNS + concurrency + headroom;
    expect(
      headroom,
      "headroom is this test's coverage of the stranded-queue path, not slack",
    ).toBeGreaterThan(0);
    const first = await Promise.all(
      Array.from({ length: queued }, (_, i) => pool.parse(`f${i}.ts`, "x")),
    );
    expect(first.every((r) => r === null)).toBe(true);

    // The regression: these arrive after the pool is dead.
    await expect(pool.parse("later.ts", "x")).resolves.toBeNull();
    await expect(
      Promise.all([pool.parse("l1.ts", "x"), pool.parse("l2.ts", "x")]),
    ).resolves.toEqual([null, null]);

    // And every one of them is counted, so the stitch gate sees the loss: the
    // whole queued batch plus every parse issued after the latch. EXACT, not
    // a floor -- this was the last loose assertion in a test tightened
    // everywhere else, and a floor cannot see an over-count. A regression
    // that counted the stranded queue twice (the `else if` branch's
    // `crashed += stranded` plus `parse()`'s own `if (this.dead)`) raises the
    // number and slides under a `>=`.
    expect(pool.crashedTasks()).toBe(queued + postLatch);

    // The death that hits the cap still counts. This is the only place that
    // pins it: every other use of `workerDeaths()` watches the FIRST death of
    // a healthy pool, where a counter incremented inside the respawn branch
    // and one incremented outside it both read 1, so neither placement is
    // distinguishable there. Here they are not equal -- `MAX_RESPAWNS` is 16,
    // so the pool takes `MAX_RESPAWNS + concurrency` deaths: every worker it
    // ever starts dies, and it starts `concurrency` up front plus one per
    // respawn until the budget is gone. The last `concurrency` of them fall
    // outside the branch -- one only when the pool is size 1, which is what
    // it is here. Derived from BOTH constants, because at concurrency N the
    // initial N-1 extra workers also die before `workers.length === 0` can
    // latch `dead` -- so a bare `MAX_RESPAWNS + 1` silently means "and the
    // pool is size 1", and raising the size here would fail this assertion
    // with a message accusing the death counter.
    //
    // Asserted EXACTLY, and DERIVED from the constant rather than restated.
    // A loose `>` form pins the placement only by accident of the cap's
    // value: an increment moved back inside the branch yields exactly
    // `MAX_RESPAWNS`, so `> MAX_RESPAWNS` happens to catch it, but any
    // "more than roughly the cap" shape stops discriminating the moment
    // someone reaches for a rounder number. And a hard-coded 17 fails a cap
    // change with a message about the counter, where the tempting repair is
    // to loosen the assertion into one that no longer catches the bug.
    // `MAX_RESPAWNS` is public for exactly this, the way
    // `SHUTDOWN_GRACE_MS` already is for the teardown-bound test below.
    //
    // Without this the increment can be tidied back into the branch with the
    // suite green, and the `const before = ...` / `> before` wait that
    // `workerDeaths()`'s own doc prescribes then hangs forever past the cap.
    expect(
      pool.workerDeaths(),
      "expected MAX_RESPAWNS + concurrency deaths: every worker the pool " +
        "starts dies. The shortfall is the deaths PAST the cap -- the ones " +
        "that exhaust the budget are still counted either way, so a count of " +
        "exactly MAX_RESPAWNS means the post-cap deaths stopped being counted",
    ).toBe(ParsePool.MAX_RESPAWNS + concurrency);

    await pool.destroy();
  });

  it("asks a worker to end itself rather than terminating it", async () => {
    // The fourth way this file has gone wrong, and the only one that was not a
    // hang. `Worker.terminate()` tears a thread down from outside, and doing
    // that to one that has loaded the tree-sitter native bindings segfaults the
    // PROCESS -- an idle worker that parsed a single file is enough, because
    // the crash is in disposing an isolate that still holds the addon. The
    // comparison that settles it is on `ParsePool.shutdown` in
    // `../commands/parse-pool.ts`; rates and populations are in
    // `docs/parse-pool-teardown.md`, not restated here. What matters
    // for this file: a pool built on one of the inline `.mjs` fixtures never
    // imports `core-ingestion`, so its teardown cannot crash, and only a pool
    // pointed at the real built worker can. Stated as a property of the
    // fixture rather than as "only the test at the bottom", which is true
    // today and goes stale silently the first time a second real-worker test
    // is added -- and goes stale in the dangerous direction, telling whoever
    // added it that their teardown cannot crash. Deliberately no tally
    // either, for the same reason: a count goes stale with the suite green.
    //
    // And on the shipped build nothing here calls `terminate()` at all --
    // Ix#598 removed it. A worker that will not
    // answer `__shutdown` is left alive and `unref()`'d, and process exit
    // does NOT run the shutdown path that `terminate()` drives. Probed three
    // times, in a standalone script rather than through this pool: the parent
    // never receives an 'exit' event for such a worker, and the worker's own
    // `process.on('exit')` never runs -- the process leaves at code 0 with the
    // thread still live.
    //
    // Standalone matters. The give-up path calls `removeAllListeners('exit')`
    // before it unrefs, so measured through `ParsePool` the missing event
    // would be guaranteed by construction and would show nothing. It is the
    // worker-side handler that carries this.
    //
    // The give-up branch of `shutdown` in `../commands/parse-pool.ts` says the
    // same thing -- "nobody disposes an isolate that still holds the addon" --
    // though that is in the branch body, not in `shutdown`'s doc header, which
    // only covers how long a wedged worker survives. An earlier revision of
    // THIS comment said the opposite ("its isolate is still disposed when the
    // process exits"), which would have told a reader the give-up path is
    // exposed to the crash. It was the one claim in this PR that two files
    // answered differently.
    //
    // The arm behind it is weak on its own -- four addon-loaded threads
    // unref'd across exit, 0 failures in 10 runs, which at the per-isolate
    // hazard is the expected result either way -- so the mechanism is what
    // carries it, not the count.
    //
    // Nor is the repo clear: `core-ingestion`'s own suite runs on vitest's
    // threads pool, which does terminate threads that have loaded the addon.
    // The doc covers both.
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
    // Parse first so the worker is idle-after-work, which is the state
    // `destroy()` meets in a real run. Note this fixture is an inline .mjs that
    // never imports `core-ingestion`, so no addon is loaded here and the crash
    // itself cannot occur -- what is pinned is the MECHANISM, that the pool
    // asks rather than terminates. The real-worker test lower down is the one
    // that runs against the addon.
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
    // Destroy while it is mid-parse, so the first expiry lands on a BUSY
    // worker.
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
    // answer. Under the old `terminate()` this was the segfault itself; the
    // pool unrefs now, so the cost is a lost parse result rather than the
    // process, and it is still wrong.
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

    // It returned by letting go once the 500ms ceiling passed, WELL before the
    // 2s spin finishes -- and the margin is the whole gate. An earlier revision
    // paired a 3000ms bound with this shortened fixture, which quietly made the
    // test vacuous: with the deadline removed, `destroy()` simply waits out the
    // spin and returns at ~2.05s, still under 3000. Measured pass time here is
    // ~600ms, so this bound separates "let go at the ceiling" from "waited for
    // the worker" instead of accepting both.
    expect(Date.now() - started).toBeLessThan(1500);
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
    // Parse for real, because having PARSED is what was observed to arm the
    // crash. Not because parsing loads the addon: `index.ts` resolves
    // its grammars at module scope -- some by static import, the rest eagerly
    // through helpers -- so these threads hold the core and the static ones
    // within moments of spawn, well before that module finishes evaluating.
    // The helper-loaded ones return null wherever a platform has no prebuild,
    // so the guaranteed floor is the core plus the statically imported
    // grammars, which is all this test needs. (Being a REQUIRED dependency
    // does not put a grammar in that floor: `tree-sitter-powershell` is
    // required and still loads through a helper.) The counts are in
    // `docs/parse-pool-teardown.md` rather than here.
    //
    // Workers that had parsed were the ones observed to crash under
    // `terminate()`, and spawn-then-destroy was not -- but the mechanism was
    // never isolated, and the addon is held either way, so that does not
    // establish an undispatched worker is safe to terminate. Parse here
    // because the real run does.
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
