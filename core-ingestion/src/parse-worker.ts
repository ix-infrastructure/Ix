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
 * How often, honestly: not established. Across harness variants the implied
 * per-teardown rate ranged 4.3% to 12.5% (20-teardown runs gave 5 of 6, 7 of
 * 10 and 7 of 12; single-teardown runs 5 of 40), and those do not agree with
 * each other. A real `ix ingest` of 300 files was 0 of 60 -- but at the low end
 * of that range the chance of seeing zero in 60 is about 7%, so that result
 * does NOT show the CLI is exempt, and no per-command figure is claimed here.
 * (Those ingests did parse: entitiesParsed 1200, parseError 0, so the addon was
 * genuinely loaded rather than silently failing.)
 *
 * What IS established: the crash is real and reproducible, and it reached the
 * suite -- `ingest-files.test.ts` drives 14 real ingests per vitest process and
 * produced it as an intermittent "Worker exited unexpectedly". The MCP server's
 * in-process runner (`createInProcessRunner`, the default unless
 * IX_MCP_SUBPROCESS=1) builds pools the same way; not measured.
 *
 * An earlier version of this comment put the CLI at "one `ix map` in twelve".
 * The arithmetic was sound -- 5 of 6 over 20 teardowns is 8.6% each -- but it
 * was never run end to end. A later version then claimed the CLI provably
 * escapes, which over-read 0 of 60 against a rate the experiments never pinned
 * down. Both were the same mistake in different directions: stating an impact
 * the measurements do not support.
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
