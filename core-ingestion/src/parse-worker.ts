/**
 * Worker thread entry point for parallel file parsing.
 * Each worker maintains its own Parser singleton (safe — module state is
 * per-thread).
 * Receives: { filePath: string, source: string } | { __shutdown: true }
 * Posts:    { ok: true, result: FileParseResult } | { ok: false }
 */
import { parentPort } from 'node:worker_threads';
import { parseFile } from './index.js';

if (!parentPort) throw new Error('parse-worker must run inside a worker thread');

/**
 * A message asking this thread to end itself, rather than be terminated.
 *
 * `Worker.terminate()` tears a thread down from the outside, and doing that to
 * a thread that has loaded the tree-sitter native bindings SEGFAULTS the whole
 * process -- the parses need not even be in flight, an idle worker that has
 * parsed once is enough.
 *
 * How it presents: exit 139 after a completely successful ingest -- patches
 * committed, summary printed, and a non-zero `$?` for anything that reads it.
 * If you are here because a clean `ix map` exited 139, this is it.
 *
 * NEVER-DISPATCHED WORKERS ARE NOT EXEMPT. The addon is held from module
 * EVALUATION, not from the first parse: `index.ts` resolves its grammars at
 * module scope and this file imports it statically, so a worker reaches that
 * state on its own without being dispatched. `tree-sitter` and the statically
 * imported grammars are `index.ts`'s own imports, near the top of its
 * dependency graph, so the isolate holds them within moments of
 * `new Worker()` -- long
 * before that file's body or its top-level `await`s run. A worker that has
 * parsed nothing, or that is still suspended at one of those awaits, holds
 * them all the same. That is the precondition the crash needs, so an
 * undispatched worker is not known to be safe to terminate.
 *
 * Whether it is as dangerous as a parsed one has never been measured: the one
 * arm that looked -- spawn-then-destroy, 0 of 120 -- destroyed its pool with
 * no wait for an ack or an `'online'` event, so it very probably tore threads
 * down before they had finished loading: a different population. Inferred
 * from that teardown code, not measured.
 *
 * `parse-pool.test.ts` used to say the opposite -- "an untouched worker has
 * not loaded the addon" -- which is what made a `terminate()` fast path for
 * undispatched workers look safe. That is the claim being retracted; it was
 * never in this file.
 *
 * Rates, populations and the reasoning are in `docs/parse-pool-teardown.md`,
 * which is versioned and travels with a clone. Do not reconstruct them from
 * this file's history: `main` squash-merges, so the log here also carries
 * #598, whose figures this work retracts, and the squashed body concatenates
 * every superseded value beside its correction.
 *
 * They are deliberately not restated here. Keeping a statistical write-up
 * consistent across three source files produced more defects over successive
 * reviews than it prevented, and none of it changes what this code must do.
 *
 * Closing the port from INSIDE lets the thread unwind its own event loop and
 * dispose its isolate in order, and did not crash once where terminating
 * crashed most runs -- the comparison is on `ParsePool.shutdown`, in
 * `ix-cli/src/cli/commands/parse-pool.ts`.
 *
 * The teardown contract, precisely, because the pool's half of it changed and
 * this is the only place the worker states it: `ParsePool` never terminates a
 * worker. If one does not answer, the pool stops waiting and `unref()`s it, so
 * the CLI can exit while the thread is still alive. Nothing reclaims a wedged
 * thread before the process ends -- do not write code here that relies on
 * being killed, and do not "restore" a `terminate()` fallback in the pool,
 * which is the segfault itself.
 *
 * Not exported: `ix-cli` does not depend on this package and inlines the
 * literal, and this module throws at load outside a worker thread, so an
 * importer could not use the type anyway. The binding between the two is the
 * test that runs `ParsePool` against this built file.
 */
type ShutdownMessage = { __shutdown: true };

type ParseMessage = { filePath: string; source: string };

parentPort.on('message', (msg: ParseMessage | ShutdownMessage) => {
  if ((msg as ShutdownMessage).__shutdown) {
    // `close()`, not `process.exit()`. Both avoid the crash, but `exit()` from
    // a worker takes the process's exit code with it if the main thread is
    // already on its way out, and this runs during teardown.
    parentPort!.close();
    return;
  }
  const { filePath, source } = msg as ParseMessage;
  try {
    const result = parseFile(filePath, source);
    parentPort!.postMessage({ ok: result !== null, result: result ?? null });
  } catch {
    parentPort!.postMessage({ ok: false, result: null });
  }
});
