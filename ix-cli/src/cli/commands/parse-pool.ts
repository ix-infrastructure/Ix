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

/**
 * The 'error' listener left on a worker the pool has let go of.
 *
 * Module level on purpose. See `shutdown`: a handler defined inside that
 * method would capture its scope and keep the whole pool alive, defeating the
 * listener removal it accompanies.
 */
const SWALLOW_ERROR = (): void => {};

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
   * @param graceMs How long an UNRESPONSIVE IDLE worker gets before the pool
   *   stops waiting for it.
   * @param maxWaitMs The ceiling on waiting for a BUSY one.
   *
   * Both injectable only so the tests can pin the behaviour without spending
   * the real periods -- the ceiling test would otherwise cost ten seconds on
   * every leg of the matrix. `ingestFiles` passes neither.
   */
  constructor(
    private workerPath: string,
    private concurrency: number,
    private graceMs: number = ParsePool.SHUTDOWN_GRACE_MS,
    private maxWaitMs: number = ParsePool.SHUTDOWN_MAX_WAIT_MS,
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
    // Set FIRST. A worker that answers `__shutdown` emits 'exit', and the
    // handler for that treats an exit as a crash and spawns a replacement. So
    // closing the pool spun up a fresh set of threads, `this.workers = []`
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
    // Resolve what is still QUEUED. `destroy()` left the queue untouched while
    // `onResult` still calls `drain()`, so a worker finishing its last parse
    // could be handed a queued file behind the `__shutdown` already sitting in
    // its port: the worker closes first, and that task's promise never settled.
    // Empty on every path where `ingestFiles` completes; reachable when it
    // throws with parses still queued.
    //
    // Resolved but deliberately NOT counted as crashed. An earlier revision
    // incremented `crashed` here and justified it as "the input the stitch gate
    // and the mtime baseline trust" -- which is wrong: `destroy()` runs in the
    // outermost `finally`, while the baseline, the pre-migration delete guard
    // and both stitch gates read `crashedParses()` inside the `try`, strictly
    // earlier. They cannot observe this. The only readers left are the summary
    // fields, so counting it there made the printed `parseErrors` disagree with
    // the baseline decision already taken, on the one path that reaches it --
    // a run that is throwing anyway, where the exception is the story.
    const stranded = this.queue.splice(0, this.queue.length);
    for (const t of stranded) t.resolve(null);
    await Promise.all(this.workers.map(w => this.shutdown(w)));
    // ...and resolve whatever was still IN FLIGHT when the last worker went.
    //
    // `onError` early-returns once `destroyed` is set -- deliberately, so a
    // deliberate teardown is not counted as a crash and does not respawn the
    // pool it is closing -- which means the in-flight task of a worker that
    // `shutdown` gave up on was never settled by anything. Its promise stayed
    // pending for the life of the process, and the `Promise.all` over the parse
    // batch with it. Found by a test asserting that such a worker's parse still
    // settles: `destroy()` returned on schedule and the test then hung on the
    // task.
    //
    // Not counted, for the same reason the stranded queue is not: every gate
    // that reads `crashedParses()` has already run by the time `destroy()` is
    // called from the outermost `finally`.
    for (const task of this.active.values()) task.resolve(null);
    this.active.clear();
    this.workers = [];
    this.idle = [];
  }

  /**
   * How long an IDLE worker gets to answer before the pool gives up on it.
   *
   * Only ever paid by one whose JS event loop is wedged. A responsive worker
   * closes its port and emits 'exit' in about a millisecond, and `shutdown`
   * resolves on that event, so the common path does not wait. Public because
   * the test that pins the fallback derives its bound from this rather than
   * restating it: tuning the grace should not fail a test about
   * waiting-then-returning.
   *
   * A worker that is mid-parse keeps being given more time instead, up to
   * `SHUTDOWN_MAX_WAIT_MS`. Note this is checked on tick boundaries, so one
   * that goes idle just after a tick can wait up to twice this.
   */
  static readonly SHUTDOWN_GRACE_MS = 2000;

  /**
   * The same, for a worker that has ALREADY faulted.
   *
   * Shorter than the ordinary grace, though what it buys is now modest and
   * worth stating exactly: since nothing is terminated, the faulted thread
   * survives regardless of this value. All it controls is how long the pool
   * holds a timer and an 'exit' listener for a worker it has already replaced.
   * An earlier revision justified it as keeping the pool from running
   * `concurrency + 1` threads, which was true only while the fallback killed
   * things. Do not tune it on that reasoning.
   */
  static readonly FAULTED_GRACE_MS = 250;

  /**
   * The ceiling on waiting for a BUSY worker, after which the pool lets go.
   *
   * Generous, because the common reason a worker is still busy at teardown is
   * a genuine parse that will finish on its own and answer. Finite, because
   * the alternative is an unbounded wait, and `destroy()` is the first
   * statement of `ingestFiles`'s outermost `finally` -- a hang there stops the
   * run before it can even print its summary. Only reached on the path where
   * `ingestFiles` throws with parses still in flight; on every completing path
   * the batch is awaited long before `destroy()`.
   */
  static readonly SHUTDOWN_MAX_WAIT_MS = 10000;

  /**
   * End one worker by ASKING, and let go of it if it will not answer.
   *
   * `terminate()` tears a thread down from outside, and doing that to a thread
   * that has loaded the tree-sitter native bindings segfaults the process. The
   * thread does not have to be busy: an idle worker that has parsed a single
   * file is enough, because the crash is in disposing an isolate that still
   * holds the addon.
   *
   * DO NOT add a `terminate()` fast path for workers that have never been
   * dispatched. They hold the addon too: `core-ingestion/src/index.ts`
   * resolves grammars at module scope, and `tree-sitter` plus the statically
   * imported grammars sit near the top of its dependency graph -- so a worker
   * holds them within moments of `new Worker()`, without ever being
   * dispatched, and long before `index.ts`'s own body or its top-level
   * `await`s run. Note which end that pins: the addon-free window CLOSES when
   * those static imports evaluate, not when evaluation finishes. A worker
   * suspended at one of those awaits already holds every one of them, and is
   * not safe to terminate.
   *
   * Not every grammar: most go through null-returning helpers and can be
   * absent, but the core and the statically imported ones are always there,
   * which is the PRECONDITION the crash needs. Counts in
   * `docs/parse-pool-teardown.md` rather than here -- the same reason the
   * rates live there, and #595 is the worked example of what restating them
   * costs: it added a required grammar and left a tally in
   * `core-ingestion/src/index.ts` stale, with nothing red. Whether it is also
   * sufficient has never been measured: the one experiment that looked --
   * spawn-then-destroy, 0 of 120 -- destroyed its pool with no wait for an
   * ack or an `'online'` event. So it very probably tore threads down inside
   * that window, before they had finished loading -- a different population,
   * saying nothing about undispatched workers. Probably, not certainly: that
   * is an inference from the teardown code, not a measurement, and it is the
   * sole reason for discarding the only evidence AGAINST this rule.
   *
   * This is the file where a fast path would be written, which is why the
   * warning is here and not only in the tests.
   *
   * The comparison that settles the verb, on Windows/Node 26, twenty pool
   * teardowns per process, six runs each. It settles WHICH VERB, and that is
   * all: do not derive a rate from it. Read alone the first row implies 8.6%
   * per pool teardown, which is close to the "one in twelve" this whole
   * change exists to retract -- it is one of three arms, and the pooled fit
   * over all of them is in `docs/parse-pool-teardown.md`. Quoting a single
   * arm is how the retracted figure got published the first time.
   *
   *   terminate()                        5 of 6 runs died with SIGSEGV (139)
   *   worker closes its own port         0 of 6
   *   worker calls process.exit(0)       0 of 6
   *
   * Per-consumer rates, the populations behind them and the statistics are in
   * `docs/parse-pool-teardown.md` -- versioned, and not this file's history,
   * which still carries #598's retracted figures and, in the squashed body,
   * every superseded value next to its correction. They do not change the
   * rule, and keeping them consistent across three files proved to be its own
   * source of errors.
   *
   * What the grace period bounds, precisely: the wait for a reply from a
   * worker that is IDLE and does not answer -- one whose JS event loop is
   * wedged. It does not bound teardown in general, and an earlier revision of
   * this comment claimed it did.
   *
   * NOTHING here terminates a worker, and that is the point. Four review
   * rounds went into rules for when killing a thread was safe -- never while
   * busy, only after observed idleness, unless past a deadline -- and every
   * rule had a counterexample, because `terminate()` is simply the wrong verb
   * for teardown. It is what segfaults. Against a worker inside a native call
   * it does not even preempt: V8's termination interrupt is only checked at JS
   * boundaries, so it resolves only when the call returns on its own --
   * measured twice against ~4-4.5s of CPU-bound native work, at 3981ms and
   * 4457ms (two runs of the same experiment, not a discrepancy) -- making it
   * slower AND crash-prone there. Only a JS-wedged worker dies promptly, in
   * about 2ms.
   *
   * Teardown does not need the thread to die. It needs the pool to stop
   * waiting on it and the thread to stop holding the process open, which is
   * exactly `unref()`. Measured on the real parse worker, four addon-loaded
   * threads left live and unref'd across process exit: 0 failures in 10 runs
   * -- though that arm is four isolates in one teardown, against a table of
   * twenty teardowns of a 21-worker pool, so it carries little on its own.
   * `docs/parse-pool-teardown.md` has the section, including why 0 of 10 has
   * no power here.
   *
   * So the clocks below decide WHEN to give up, never whether it is safe to
   * kill -- and the `onError` path needs no special case either, which is what
   * removed the caveat this comment used to carry.
   *
   * The cost, stated rather than hidden: a genuinely wedged worker survives
   * until the process exits, burning a core if it is spinning. For `ix map` or
   * `ix ingest` that is nothing -- the process is about to end -- and `ix
   * watch` is safe too, because it runs each map as a CHILD PROCESS
   * (`watch.ts`), so every pool dies with its own process.
   *
   * The consumer that does hold the leak is the MCP server's in-process
   * runner: `createInProcessRunner` in `src/mcp/runner.ts` is the default
   * (`IX_MCP_SUBPROCESS=1` opts out), so repeated `ix_map` calls against a repo
   * with a wedging grammar would accumulate unref'd, still-spinning threads for
   * the life of the server. An earlier version of this comment named `ix watch`
   * and missed that one, which is exactly backwards. It is still the right
   * trade -- a leaked thread is recoverable, a SIGSEGV is not, and the crash
   * would take the whole server down -- but that is where to look if threads
   * ever accumulate.
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
      // Two clocks, and every path ends at one of them.
      //
      // `idleSince` is when the worker was last OBSERVED idle, not the instant
      // it left `active`. Checking `active` alone gave up on a worker that had
      // only just posted its result: the main thread deletes the entry, and the
      // worker reaches the queued `__shutdown` a moment later, so an expiry
      // landing in that window read a busy-but-untracked worker as silent.
      // Restarting the clock when it goes idle gives it a full `graceMs` of
      // quiet before anything is concluded from the silence. Under the old
      // `terminate()` this was a segfault; it now costs a parse result rather
      // than the process, but abandoning a worker that was about to answer is
      // still wrong.
      //
      // `hardDeadline` bounds the busy case, and exists because an earlier
      // revision re-armed forever. `destroy()` is the first statement of
      // `ingestFiles`'s outermost `finally`, so waiting on a worker that never
      // finishes stopped the run before it could print its summary at all --
      // strictly worse than the exit-139 it replaced. Past the deadline the
      // pool lets go, which costs nothing now that letting go is `unref()`
      // rather than a kill.
      // The ceiling as given. `Math.max(graceMs, maxWaitMs)` meant a ceiling
      // could never be shorter than the grace -- `new ParsePool(p, 1, 2000,
      // 500)` silently got 2000ms, not 500ms. It is still only CHECKED on tick
      // boundaries, so the effective ceiling rounds up to the next multiple of
      // `graceMs`; that is why the tests bound loosely rather than exactly.
      const hardDeadline = Date.now() + this.maxWaitMs;
      let idleSince: number | null = this.active.has(w) ? null : Date.now();
      const arm = (): void => {
        timer = setTimeout(tick, graceMs);
        // `unref` so a pool that is torn down early cannot hold the process
        // open for a grace period after everything else has finished.
        timer.unref?.();
      };
      const tick = (): void => {
        const now = Date.now();
        const busy = this.active.has(w);
        if (busy) idleSince = null;
        else if (idleSince === null) idleSince = now;

        const quietLongEnough = idleSince !== null && now - idleSince >= graceMs;
        if (!quietLongEnough && now < hardDeadline) {
          arm();
          return;
        }
        // Given up on: stop waiting for it, and stop it holding the process
        // open. NOT terminated.
        //
        // `terminate()` was the wrong verb for this whole branch. It is what
        // segfaults -- that is the bug this file exists to fix -- and against a
        // worker inside a native call it does not even preempt: it resolves
        // only when the call returns, so it was strictly slower AND
        // crash-prone there (the timings are on `shutdown` above). `unref()`
        // gives the only thing teardown needs: the thread stops keeping the
        // event loop alive, so the CLI exits, and nobody disposes an isolate
        // that still holds the addon. Measured on the real parse worker, four
        // addon-loaded threads left live and unref'd across process exit: 0
        // failures in 10 runs. Note that is one teardown per run, so it is
        // not comparable to `shutdown`'s twenty-teardown table.
        //
        // The cost is written up on `shutdown` above: a wedged worker survives
        // until the process exits. Nothing for the CLI, and `ix watch` runs
        // each map as a child process, but the MCP in-process runner can
        // accumulate them.
        //
        // So let go of the OBJECT GRAPH too, not just the thread. Every
        // listener `spawnWorker` attached is a closure over `this`, and
        // `destroy()` only drops the pool's reference to the worker -- the
        // worker still referenced the pool, so one abandoned thread pinned its
        // whole `ParsePool`, its `Worker[]`, its `active` map and every
        // remaining `Task` closure for the life of the process. In a long-lived
        // `ix mcp` that is the bigger of the two leaks.
        w.removeAllListeners('message');
        w.removeAllListeners('exit');
        w.removeAllListeners('error');
        // ...but never leave a live Worker with NO 'error' listener. An
        // unhandled 'error' event is a process-level crash, and this thread is
        // still running -- a wedged parse that eventually throws would take the
        // MCP server down.
        //
        // `SWALLOW_ERROR` rather than an inline `() => {}`, and that is the
        // whole point rather than a style preference. A function literal
        // written HERE closes over this scope -- `this`, `w`, the task
        // closures -- whether or not it names any of them, so attaching one
        // would have re-pinned the exact object graph the three lines above
        // just released, and the removals would have bought nothing.
        // Confirmed with `--expose-gc` and a `WeakRef` on the pool: inline
        // handler, POOL STILL RETAINED; hoisted, POOL COLLECTED.
        w.on('error', SWALLOW_ERROR);
        w.unref();
        done();
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

  /**
   * Worker deaths this run has reacted to. Monotonic.
   *
   * Deaths, not replacements: past `MAX_RESPAWNS` the pool stops replacing but
   * still reacts -- it has spliced `workers` before the branch is reached, and
   * `idle` too if the worker was idle (one that died mid-task lives in
   * `active`, so there is nothing to take out of the free list -- which is the
   * case the cap test exercises) -- and a caller watching for "did the pool notice a worker die"
   * needs those too. (What the branch itself does past the cap depends on
   * whether any worker survives; `onError` spells that out.)
   * An earlier revision counted replacements and sat inside the cap branch,
   * which silently stopped advancing at exactly the point a caller most wants
   * to know.
   *
   * Deliberately NOT `respawns`, which is a budget rather than a tally:
   * `onResult` clears it on every successful round trip, so a run that lost a
   * dozen workers -- each replacement then parsing a file -- ends with
   * `respawns === 0` and is indistinguishable from a run that lost none. That
   * is the right behaviour for the cap and the wrong number for a reader, and
   * it makes `respawns` useless to wait on: any completed parse resets it.
   *
   * This one is a LEVEL. `onError` increments it in the same synchronous
   * handler that does the splicing, so once it has advanced the pool has
   * BEGUN reacting to that death -- and, since the handler runs to completion
   * before any asynchronous observer gets the loop back, has finished by the
   * time anyone polling can read it. The distinction matters only to a future
   * caller reading this from inside a synchronous path. The increment now runs
   * before everything the handler does afterwards: on the capped path before
   * `dead` is latched and before the queue is stranded and resolved, and on
   * the healthy path before `spawnWorker()` and `drain()`. So such a caller
   * could see it advanced with `idle` still empty, no replacement yet, and
   * the queue not yet moving.
   *
   * What it observes that nothing else does is a death with no task in
   * flight, which `crashedTasks()` deliberately does not count because no
   * file was lost. That combination is otherwise invisible from outside,
   * which is what this exists for.
   *
   * Test observability, and only that today -- nothing in `ingest.ts` reads
   * it, so a run that respawned a dozen workers still prints the same summary
   * as a healthy one. Surfacing it there is a reasonable thing to want and a
   * different change; do not read this comment as saying it already happens.
   *
   * Waiting on it means waiting on a BASELINE, not on `> 0`. The count
   * latches for the life of the run, so `> 0` answers "has any worker ever
   * died", which is true forever after the first one -- correct only for a
   * test observing that first death. Anything later wants
   * `const before = pool.workerDeaths()` and then `> before`, or it is a
   * poll that returns immediately and waits for nothing.
   *
   * Two things stop it moving, and a `> before` wait across either never
   * completes -- the same hang this counter was moved out of the cap branch
   * to avoid, one step further along:
   *
   *   teardown   `onError` returns at its `destroyed` guard, so no death is
   *              counted once `destroy()` has begun.
   *   the latch  past `MAX_RESPAWNS` with no worker left, `dead` is set and
   *              nothing is ever spawned again, so no further death can
   *              occur. This one bites while the process is still running
   *              normally, which makes it the easier of the two to miss.
   *
   * The teardown caveat is on the private `respawns` field too, which a
   * caller reading this accessor would not see.
   */
  workerDeaths(): number {
    return this.deaths;
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

  /**
   * Respawns CONSUMED since the last successful round trip, capped at
   * `MAX_RESPAWNS` -- so 0 means the full budget is available and 16 means it
   * is exhausted, which is the opposite of how "budget" usually reads.
   * `onResult` clears it on any success, so it is not a tally either: read
   * `deaths` for "how many deaths did the pool REACT to?" -- which is not the
   * same as "how many workers died": `onError` returns early once `destroy()`
   * has begun, so the ordinary end-of-run exit of every surviving worker is
   * uncounted, and a clean run ends at 0.
   */
  private respawns = 0;

  /** Worker deaths this run has reacted to. Never reset. */
  private deaths = 0;

  /**
   * True once the pool is out of workers AND out of replacements.
   *
   * Latched, because the condition is permanent: nothing spawns a worker after
   * the cap, so every later `parse()` would queue forever.
   */
  private dead = false;

  /**
   * Generous enough for real flakiness, small enough to stop a spawn loop.
   *
   * Public for the same reason `SHUTDOWN_GRACE_MS` is: the test that pins the
   * capped death derives its expectation from this rather than restating it.
   * A hard-coded 17 there fails on a cap change with a message about the
   * counter, and the tempting repair is to loosen the assertion into
   * something that no longer catches the bug.
   */
  static readonly MAX_RESPAWNS = 16;

  private onError(w: Worker, _err: Error): void {
    // Not during shutdown. `destroy()` ends every worker on purpose, and
    // treating that as a crash respawns the pool it is trying to close: the
    // replacements outlive `this.workers = []`, a worker thread refs the event
    // loop, and the CLI prints its summary and then hangs forever. The guard
    // lives HERE rather than on the 'exit' listener because 'error' reaches the
    // same code: a worker that faults while `destroy()` is waiting on it takes
    // the identical path.
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
    // Asked rather than killed, for the same reason `destroy()` asks, and
    // fire-and-forget as the `terminate()` here always was.
    //
    // Defensive, and measured to be so: a worker that emits 'error' is already
    // being torn down by V8, 'exit' follows immediately, and it never processes
    // a `__shutdown` posted from this handler -- a probe printed the 'error'
    // event with `threadId=1`, then 'exit' with `threadId=-1`, and the worker's
    // message handler never ran. So on both arms this settles via 'exit' or the
    // `threadId` fast path, and the post is a no-op. Kept because it costs
    // nothing and is correct if a worker ever does survive an 'error'; do not
    // read it as evidence that a faulted thread can still answer.
    this.shutdown(w, ParsePool.FAULTED_GRACE_MS).catch(() => {});
    this.workers.splice(idx, 1);
    // ...and out of `idle` too, ALWAYS, cap or no cap. A worker can emit 'error'
    // while it is IDLE -- an uncaught async throw, or ERR_WORKER_OUT_OF_MEMORY
    // between tasks -- and leaving the terminated thread in the free list means
    // a later `drain()` pops it and posts to nothing: the task's promise never
    // settles and the `Promise.all` over the parse batch hangs the ingest.
    const idleIdx = this.idle.indexOf(w);
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1);

    // Before the cap branch, because a death past the cap still reacts -- it
    // has already spliced `workers` above, and `idle` too if it was idle (a
    // worker that died mid-task is in `active`, so there is nothing to splice
    // from the free list) -- and a signal meaning
    // "the pool reacted to a death" has to advance for those too. Inside the
    // branch it counted replacements instead, so past the cap it stopped
    // moving, and the baseline wait described on `workerDeaths()` (~140 lines
    // above) would hang on exactly the deaths a caller most wants to see.
    //
    // What the cap branch itself does -- the `if/else if` immediately below --
    // depends on whether any worker is left. (Past the cap, that is. While the
    // budget lasts the pool simply respawns and never latches `dead`.) With
    // none, the `else if` latches `dead`, strands the queue and resolves it
    // as crashed, then returns -- so that path never reaches `drain()`. With
    // others still alive, NEITHER branch body runs and control falls straight
    // through to `drain()`. `ingest.ts` builds the pool with
    // `Math.max(1, os.cpus().length - 1)` and `respawns` is a pool-wide budget
    // that any success resets, so on an ordinary machine the fall-through is
    // the usual case -- do not read the cap as implying the pool is finished.
    //
    // The floor in that expression is there because 1 is reachable, and at
    // concurrency 1 this inverts: the first death PAST the cap is also the last
    // worker, so `workers.length === 0` always holds and the pool always
    // latches `dead`. (Not the death that exhausts the budget -- that one
    // still takes the respawn branch and spawns a replacement. The two are
    // one apart, and this file is where that distinction has to stay
    // straight.) Above concurrency 1 it does not invert. Which case a given machine falls
    // into depends on its core count, and this comment deliberately does not
    // say -- an earlier revision guessed at CI's and contradicted the machine
    // sizes in `docs/parse-pool-teardown.md`, which is the file that owns
    // them.
    this.deaths++;

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
