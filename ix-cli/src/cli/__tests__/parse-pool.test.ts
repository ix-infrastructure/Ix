import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  const ECHO = `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', ({ filePath }) => {
      parentPort.postMessage({ ok: true, result: { filePath } });
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
    parentPort.on('message', ({ filePath }) => {
      parentPort.postMessage({ ok: true, result: { filePath } });
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
    await new Promise(resolve => setTimeout(resolve, 120));

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
    expect(first.every(r => r === null)).toBe(true);

    // The regression: these arrive after the pool is dead.
    await expect(pool.parse("later.ts", "x")).resolves.toBeNull();
    await expect(
      Promise.all([pool.parse("l1.ts", "x"), pool.parse("l2.ts", "x")]),
    ).resolves.toEqual([null, null]);

    // And every one of them is counted, so the stitch gate sees the loss.
    expect(pool.crashedTasks()).toBeGreaterThanOrEqual(23);

    await pool.destroy();
  });
});
