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
  /** Does losing this one mean the RUN lost a file? See `parse`. */
  counts: boolean;
};

export class ParsePool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Task[] = [];
  private active = new Map<Worker, Task>();

  /**
   * @param graceMs How long an UNRESPONSIVE IDLE worker gets before it is
   *   terminated. Injectable only so the tests can pin the behaviour without
   *   spending the real grace period; `ingestFiles` uses the default.
   */
  constructor(
    private workerPath: string,
    private concurrency: number,
    private graceMs: number = ParsePool.SHUTDOWN_GRACE_MS,
  ) {}

  init(): void {
    for (let i = 0; i < this.concurrency; i++) {
      this.spawnWorker();
    }
  }

  /**
   * @param countLoss Whether losing this task means the run lost a file.
   *
   * False for the index prescan, which dispatches through this same pool and
   * whose caller drops nulls on the floor: those files are read and parsed
   * again in the streaming loop and land in the graph regardless. Counting them
   * made one transient prescan crash report `lost-parses`, refuse the stitch,
   * withhold the mtime baseline (so every later map re-read the whole repo) and
   * skip the post-migration delete -- for files that were all present. And
   * because most extensions are prescanned AND parsed, a dead pool could count
   * the same file twice and report more losses than the run discovered files.
   */
  parse(filePath: string, source: string, countLoss = true): Promise<unknown> {
    // A pool with no workers left cannot ever run this, so resolve it here
    // rather than enqueue it. Draining only the queue that existed at the
    // moment the last worker died left every LATER `parse()` waiting on a
    // `drain()` that is a no-op with an empty idle list -- the promise never
    // settled and the `Promise.all` over the next chunk hung the ingest, which
    // is the same failure this file has now produced three different ways.
    if (this.dead) {
      if (countLoss) this.crashed++;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.queue.push({ filePath, source, resolve, counts: countLoss });
      this.drain();
    });
  }

  async destroy(): Promise<void> {
    // Set FIRST. Shutting a worker down makes it emit 'exit' -- whether it is
    // asked or, in the fallback, terminated -- and the handler for that treats
    // an exit as a crash and spawns a replacement, so
    // shutting the pool down span up a fresh set of threads, `this.workers = []`
    // orphaned them, and because a worker thread refs the event loop and the
    // CLI has no `process.exit(0)` on its success path, `ix map` printed its
    // summary and then hung forever.
    this.destroyed = true;
    // ...and `dead`, so a `parse()` after teardown resolves instead of queueing
    // onto a pool with no workers left to run it. Not reachable from
    // `ingestFiles` today -- `destroy()` is in the outermost `finally` -- but it
    // is the identical hang this file has already produced three times, and one
    // line closes it.
    this.dead = true;
    // Resolve what is still QUEUED, the way the respawn-cap branch does.
    // `destroy()` left the queue untouched, and `onResult` still calls
    // `drain()`, so a worker finishing its last parse could be handed a queued
    // file behind the `__shutdown` it had already been sent: the worker closes
    // its port first, and that task's promise never settled. Worse, `onError`
    // early-returns once `destroyed` is set, so it was not counted either --
    // a silently lost file that `crashedTasks()` reported as zero, which is
    // exactly the input the stitch gate and the mtime baseline trust. Empty on
    // every path where `ingestFiles` completes; reachable when it throws with
    // parses still queued.
    const stranded = this.queue.splice(0, this.queue.length);
    this.crashed += stranded.filter(t => t.counts).length;
    for (const t of stranded) t.resolve(null);
    await Promise.all(this.workers.map(w => this.shutdown(w)));
    this.workers = [];
    this.idle = [];
  }

  /**
   * How long an IDLE worker gets to answer before it is terminated.
   *
   * Only ever paid by one whose JS event loop is wedged. A responsive worker
   * closes its port and emits 'exit' in about a millisecond, and `shutdown`
   * resolves on that event, so the common path does not wait. Public because
   * the test that pins the fallback derives its bound from this rather than
   * restating it: tuning the grace should not fail a test about
   * waiting-then-returning.
   *
   * It does NOT bound teardown for a worker that is mid-parse -- see
   * `shutdown`, which does not terminate a busy worker at all, because nothing
   * can cut a native call short.
   */
  static readonly SHUTDOWN_GRACE_MS = 2000;

  /**
   * The same, for a worker that has ALREADY faulted.
   *
   * Much shorter, because `onError` does not wait for it: the replacement is
   * spawned immediately, so a long grace leaves the pool running
   * `concurrency + 1` threads, and a faulted-then-wedged worker still refs the
   * event loop -- `ix map` would sit there after printing its summary until the
   * timer fired. A worker that is merely faulted and still responsive answers
   * in about a millisecond, so this costs it nothing.
   */
  static readonly FAULTED_GRACE_MS = 250;

  /**
   * End one worker by ASKING, and terminate it only if it will not go.
   *
   * `terminate()` tears a thread down from outside, and doing that to a thread
   * that has loaded the tree-sitter native bindings segfaults the process. The
   * thread does not have to be busy: an idle worker that has parsed a single
   * file is enough, because the crash is in disposing an isolate that still
   * holds the addon. Measured on Windows/Node 26, twenty pool teardowns per
   * process, six runs each:
   *
   *   terminate()                        5 of 6 runs died with SIGSEGV (139)
   *   worker closes its own port         0 of 6
   *   worker calls process.exit(0)       0 of 6
   *
   * `destroy()` runs in `ingestFiles`'s outermost `finally`, so this was one
   * `ix map` in roughly twelve exiting 139 with every patch committed and the
   * summary already printed -- invisible unless something reads the status.
   *
   * What the grace period bounds, precisely: the wait for a reply from a
   * worker that is IDLE and does not answer -- one whose JS event loop is
   * wedged. It does not bound teardown in general, and an earlier revision of
   * this comment claimed it did.
   *
   * A BUSY worker is never terminated, because terminating it buys nothing.
   * `terminate()` cannot cut short a native call: V8 raises a termination
   * interrupt that is only checked at JS boundaries, and a tree-sitter parse
   * does not reach one until it returns. Measured on Node 26 -- against
   * CPU-bound native work, `terminate()` resolved after 3981ms, i.e. when the
   * call finished on its own. So terminating a mid-parse worker would wait
   * exactly as long as asking does, and add back the segfault this whole
   * change exists to remove, on a thread that was about to answer anyway. The
   * queued `__shutdown` is handled the moment the parse returns.
   *
   * The consequence, stated rather than hidden: teardown is bounded by the
   * longest in-flight parse, and always was -- `main`'s bare `terminate()` had
   * the same floor. Nothing here can do better than the addon allows.
   *
   * One caveat, because the rule above is not universal: on the `onError`
   * path the caller has already removed the worker's `active` entry in order
   * to resolve its task, so the busy check cannot see it and a faulted worker
   * is terminated unconditionally after `FAULTED_GRACE_MS`. That is deliberate
   * rather than overlooked. A worker reaches `onError` by emitting 'error' --
   * V8 has already unwound its JS -- or 'exit', which the `threadId` check
   * settles without terminating anything. The residual window is a thread that
   * emitted 'error' while still inside a native call (an OOM during a large
   * parse), and closing it would mean tracking busy-ness separately from
   * `active` and never terminating a faulted worker, which trades a rare crash
   * for a hang whenever a faulted thread does not exit on its own.
   */
  private shutdown(w: Worker, graceMs = this.graceMs): Promise<void> {
    // A worker that has already gone: settle NOW, synchronously.
    //
    // Checked rather than inferred from a failed post. An earlier revision
    // relied on `postMessage()` throwing once the thread was gone; it does not
    // -- on Node 26 it is a silent no-op -- so for every worker that had
    // already exited (`process.exit()` inside it, the respawn loop, a crash)
    // this held a live timer and a listener for an 'exit' that had already
    // fired and would never fire again, then terminated a corpse. `threadId`
    // is -1 once the thread is gone, which is the only signal here that is
    // actually true.
    if (w.threadId === -1) return Promise.resolve();
    return new Promise<void>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const arm = (): void => {
        timer = setTimeout(() => {
          if (this.active.has(w)) {
            // Mid-parse, so it has simply not reached its message loop yet.
            // Keep waiting: it will handle the queued `__shutdown` as soon as
            // the parse returns, and terminating it now would cost the same
            // time while risking the crash.
            //
            // RE-ARMED, not abandoned. An earlier revision `return`ed here,
            // which permanently disarmed the fallback: a worker that happened
            // to be busy at the one moment this fired, and then refused to
            // answer once idle, could never be terminated and `destroy()`
            // never resolved. Reproduced -- a fixture that busy-loops 400ms,
            // replies, then ignores `__shutdown` left `destroy()` still
            // pending at a 5s cutoff. That is the unbounded CLI hang this file
            // already has three tests for, reintroduced while fixing
            // something else.
            arm();
            return;
          }
          // Idle and still not answering: its event loop is wedged, and only
          // `terminate()` will free it. That can still crash the process, but a
          // hung CLI is certain and this is not.
          w.terminate()
            .catch(() => {})
            .finally(done);
        }, graceMs);
        // `unref` so a pool that is torn down early cannot hold the process
        // open for a grace period after everything else has finished.
        timer.unref?.();
      };
      arm();
      w.once('exit', done);
      // No try/catch: the post cannot throw for a live thread, and the dead
      // case is handled above. Wrapping it here is what disguised the bug.
      w.postMessage({ __shutdown: true });
    });
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
    // A successful round trip clears the respawn budget. The cap exists to
    // stop a worker that dies deterministically from spinning spawn -> die ->
    // spawn; it is not meant to be a lifetime quota. As a per-run total it made
    // ~23 transient deaths on a long run kill the pool for good, and on `main`
    // those cost 23 files rather than the remainder of the ingest.
    this.respawns = 0;
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
      if (task.counts) this.crashed++;
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
    // Asked, not terminated, for the same reason `destroy()` asks: this fires
    // on 'exit' AND on 'error', and a worker that merely emitted 'error' is
    // still a live thread holding the tree-sitter addon. Fire-and-forget, as
    // the `terminate()` here always was -- the pool does not wait on a worker
    // it has already given up on, and `shutdown` kills it after the grace
    // period if it will not go. On the 'exit' arm the thread is already gone,
    // which `shutdown` detects from `threadId` and settles at once, so that
    // path costs nothing and holds no timer.
    this.shutdown(w, ParsePool.FAULTED_GRACE_MS).catch(() => {});
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
      this.crashed += stranded.filter(t => t.counts).length;
      for (const t of stranded) t.resolve(null);
      return;
    }
    this.drain();
  }
}
