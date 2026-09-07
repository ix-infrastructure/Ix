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
 * Who this actually hit, measured against the pre-fix build rather than
 * inferred from the per-teardown rate (Windows / Node 26, pool of 21):
 *
 *   one pool per process, then exit        1-3 of 15 segfaulted
 *   twenty pools in one process            7 of 10
 *   a real `ix ingest` of 300 files        0 of 60
 *
 * So the risk scales with teardowns PER PROCESS, and the consumers exposed to
 * it are the ones that build many pools in a single process: the MCP server's
 * in-process runner (`createInProcessRunner`, the default unless
 * IX_MCP_SUBPROCESS=1) and the vitest suite, where this first showed up as an
 * intermittent "Worker exited unexpectedly". A one-shot `ix map` / `ix ingest`
 * did NOT reproduce it in 60 runs -- an earlier version of this comment claimed
 * one in twelve of them exited 139, which the end-to-end run does not support.
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
