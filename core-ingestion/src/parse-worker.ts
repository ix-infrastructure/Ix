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
 * How often: no per-command figure is claimed, because the runs do not pin
 * one. Measured on the pre-fix build, Windows / Node 26, pool of 21:
 *
 *   minimal harness, ONE teardown then exit     5 of 40
 *   minimal harness, twenty teardowns           5 of 6, 7 of 10, 7 of 12
 *   a real `ix ingest` of 300 files             0 of 60
 *
 * Two things the numbers do say. Comparing like with like -- both single
 * teardowns -- 5 of 40 against 0 of 60 is a real difference (Fisher exact
 * p = 0.009), so a real ingest is not simply the harness with a CLI around it.
 * WHY is not established, and it is not teardown count, because both are one.
 * Do not rely on the difference.
 *
 * And the twenty-teardown runs imply 8.6%, 5.8% and 4.3% per teardown, against
 * 12.5% from the single-teardown runs. Those disagree, so quoting any one of
 * them as "the" rate -- in either direction -- is picking a number to suit an
 * argument. Two earlier versions of this comment did exactly that.
 *
 * The ingests really did parse, so 0 of 60 is not a silently broken addon:
 * `unparsed: 0` is the field that would catch it (a worker whose bindings fail
 * to load resolves null and lands in `filesSkippedUnparsed`, never in
 * `parseErrors`), and the graph held 300 classes and 300 functions.
 *
 * What is established: the crash is real, reproducible, and it reached the
 * suite. `ingest-files.test.ts` drives 14 real ingests per vitest process and
 * produced it as an intermittent "Worker exited unexpectedly". The MCP server's
 * in-process runner (`createInProcessRunner`, the default unless
 * IX_MCP_SUBPROCESS=1) has that same many-pools-in-one-process shape, which is
 * why it is named here; it was not measured.
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
