/**
 * Bounded worker-thread pool for parallel file parsing.
 * Uses the core-ingestion parse-worker entry compiled to dist/.
 *
 * - Bounded to `concurrency` simultaneous workers.
 * - One crashed worker is replaced; its in-flight task resolves as null (treated as parse failure).
 * - parse() returns a Promise that resolves to FileParseResult | null.
 * - Results collected via Promise.all preserve input ordering.
 */
import { Worker } from 'node:worker_threads';

type Task = {
  filePath: string;
  source: string;
  resolve: (result: unknown) => void;
};

export class ParsePool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Task[] = [];
  private active = new Map<Worker, Task>();

  constructor(private workerPath: string, private concurrency: number) {}

  init(): void {
    for (let i = 0; i < this.concurrency; i++) {
      this.spawnWorker();
    }
  }

  parse(filePath: string, source: string): Promise<unknown> {
    // A pool with no workers left cannot ever run this, so resolve it here
    // rather than enqueue it. Draining only the queue that existed at the
    // moment the last worker died left every LATER `parse()` waiting on a
    // `drain()` that is a no-op with an empty idle list -- the promise never
    // settled and the `Promise.all` over the next chunk hung the ingest, which
    // is the same failure this file has now produced three different ways.
    if (this.dead) {
      this.crashed++;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.queue.push({ filePath, source, resolve });
      this.drain();
    });
  }

  async destroy(): Promise<void> {
    // Set FIRST. `terminate()` makes every worker emit 'exit', and the handler
    // for that treats an exit as a crash and spawns a replacement -- so
    // shutting the pool down span up a fresh set of threads, `this.workers = []`
    // orphaned them, and because a worker thread refs the event loop and the
    // CLI has no `process.exit(0)` on its success path, `ix map` printed its
    // summary and then hung forever.
    this.destroyed = true;
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    this.idle = [];
  }

  private spawnWorker(): Worker {
    const w = new Worker(this.workerPath);
    w.on('message', (msg: { ok: boolean; result: unknown }) => this.onResult(w, msg));
    w.on('error', (err) => this.onError(w, err));
    // 'exit' as well as 'error'. A worker can go without ever emitting 'error'
    // -- `process.exit()` inside it, or the thread killed out from under the
    // runtime -- and then its in-flight task never resolves, the `Promise.all`
    // over the parse batch never settles, and the ingest hangs before it can
    // even reach `destroy()`. `onError` already covers the crash path; this
    // covers the quiet one, and both feed `crashedTasks()` so the stitch gate
    // sees a run that lost a file either way.
    w.on('exit', () => this.onError(w, new Error('parse worker exited')));
    this.workers.push(w);
    this.idle.push(w);
    return w;
  }

  private drain(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const task = this.queue.shift()!;
      this.active.set(w, task);
      w.postMessage({ filePath: task.filePath, source: task.source });
    }
  }

  /**
   * In-flight tasks lost to a crashed worker.
   *
   * `parse()` resolves `null` for two very different things, and collapsing
   * them hid a real difference (Ix#568): a worker that CRASHED lost a file it
   * would otherwise have parsed, which is transient and makes the run's results
   * incomplete -- while `parseFile` returning null is deterministic and says
   * this file has nothing to give, most often because its grammar is an
   * unavailable optional dependency (`tree-sitter-sas` has no win32 prebuild,
   * for one). Callers that need "did we miss anything we would have indexed?"
   * must ask this and not count nulls.
   */
  crashedTasks(): number {
    return this.crashed;
  }

  private onResult(w: Worker, msg: { ok: boolean; result: unknown }): void {
    const task = this.active.get(w);
    if (!task) return;
    this.active.delete(w);
    task.resolve(msg.ok ? msg.result : null);
    this.idle.push(w);
    this.drain();
  }

  private crashed = 0;

  /** True once `destroy()` has begun, so a deliberate exit is not read as a crash. */
  private destroyed = false;

  /** Replacements spawned for crashed workers. Capped -- see `onError`. */
  private respawns = 0;

  /**
   * True once the pool is out of workers AND out of replacements.
   *
   * Latched, because the condition is permanent: nothing spawns a worker after
   * the cap, so every later `parse()` would queue forever.
   */
  private dead = false;

  /** Generous enough for real flakiness, small enough to stop a spawn loop. */
  private static readonly MAX_RESPAWNS = 16;

  private onError(w: Worker, _err: Error): void {
    // Not during shutdown. `destroy()` terminates every worker on purpose, and
    // treating that as a crash respawns the pool it is trying to close: the
    // replacements outlive `this.workers = []`, a worker thread refs the event
    // loop, and the CLI prints its summary and then hangs forever. The guard
    // lives HERE rather than on the 'exit' listener because 'error' reaches the
    // same code: a worker that faults while `destroy()` is awaiting
    // `terminate()` took the identical path.
    if (this.destroyed) return;
    const task = this.active.get(w);
    if (task) {
      this.active.delete(w);
      this.crashed++;
      task.resolve(null); // isolate: failed file = null parse result
    }
    // Replace the crashed worker -- but not forever. A worker that dies
    // deterministically and without an 'error' (a native module that calls
    // `process.exit(1)` on load, say) would otherwise spin spawn -> exit ->
    // spawn for the rest of the run. That loop is newly reachable, because
    // before the 'exit' listener a silent death was simply ignored. Past the
    // cap the pool runs smaller, which the queue drains through fine, and every
    // lost task is still counted for the stitch gate.
    const idx = this.workers.indexOf(w);
    if (idx === -1) return;
    w.terminate().catch(() => {});
    this.workers.splice(idx, 1);
    // ...and out of `idle` too, ALWAYS, cap or no cap. A worker can emit 'error'
    // while it is IDLE -- an uncaught async throw, or ERR_WORKER_OUT_OF_MEMORY
    // between tasks -- and leaving the terminated thread in the free list means
    // a later `drain()` pops it and posts to nothing: the task's promise never
    // settles and the `Promise.all` over the parse batch hangs the ingest.
    const idleIdx = this.idle.indexOf(w);
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1);

    if (this.respawns < ParsePool.MAX_RESPAWNS) {
      this.respawns++;
      this.spawnWorker();
    } else if (this.workers.length === 0) {
      // Out of workers and out of replacements. Nothing queued can ever be
      // parsed, so resolve it rather than leave `Promise.all` waiting on a pool
      // that no longer exists -- and LATCH it, because `parse()` must answer the
      // same way for every call after this, not just for what happened to be
      // queued at this instant. Counted as crashed, which is what it is, so the
      // stitch gate knows this run lost files.
      this.dead = true;
      const stranded = this.queue.splice(0, this.queue.length);
      this.crashed += stranded.length;
      for (const t of stranded) t.resolve(null);
      return;
    }
    this.drain();
  }
}
