/**
 * Worker thread entry point for parallel file parsing.
 * Each worker maintains its own Parser singleton (safe — module state is per-thread).
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
 * Measured against the pre-fix build, Windows / Node 26, pool of 21 workers.
 * Two separate experiments:
 *
 *   a minimal harness, one teardown then exit     5 of 40 segfaulted
 *   the same harness, twenty teardowns            7 of 12
 *   a real `ix ingest` of 300 files               0 of 60
 *
 * The first two agree: ~12.5% per teardown, and 1-(1-0.125)^20 is most of the
 * time. The third does not follow from them -- at 12.5% the chance of seeing
 * zero in 60 is about 0.03% -- so a real ingest genuinely escapes a crash the
 * harness reproduces from the same single teardown of the same sized pool.
 *
 * WHY it escapes is not established, and this comment does not guess. It is
 * not teardown count: both are one. The pool is definitely running there --
 * an instrumented dist prints `init concurrency=21` then `destroy workers=21`
 * on every ingest -- so the terminate path executes on 21 addon-loaded threads
 * and survives, for a reason nobody has pinned down. Do not rely on it.
 *
 * Where it was actually observed: `ingest-files.test.ts`, which drives 14 real
 * ingests per vitest process and produced this as an intermittent "Worker
 * exited unexpectedly". The MCP server's in-process runner
 * (`createInProcessRunner`, the default unless IX_MCP_SUBPROCESS=1) has the
 * same many-pools-per-process shape; that one is inferred, not measured.
 *
 * An earlier version of this comment put the CLI at "one `ix map` in twelve".
 * The arithmetic behind it was sound -- 5 of 6 over 20 teardowns implies 8.6%
 * each, which is 1 in 12 -- but it was never run end to end, and when it was,
 * the CLI showed 0 of 60. Extrapolating the rate to a different consumer was
 * the mistake, not the division.
 *
 * Closing the port from INSIDE lets the thread unwind its own event loop and
 * dispose its isolate in order. Measured 0 crashes in the same experiment.
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
