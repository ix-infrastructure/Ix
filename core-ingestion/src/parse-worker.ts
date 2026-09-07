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
 * The signature, which was never in dispute: exit 139 after a completely
 * successful ingest -- patches committed, summary printed, and a non-zero `$?`
 * for anything that reads it. If you are here because a clean `ix map` exited
 * 139, this is it.
 *
 * How often, measured on the pre-fix build (Windows / Node 26, pool of 21):
 *
 *   minimal harness, twenty teardowns per process   19 of 28 runs crashed
 *   minimal harness, ONE teardown then exit          5 of 40
 *   a real `ix ingest` of 300 files                  0 of 60
 *
 * Pooling the twenty-teardown runs gives about 5.5% per teardown, and the
 * single-teardown arm (12.5%) is consistent with that once the sample sizes are
 * taken seriously -- P(>=5 of 40 | p=0.055) = 0.07. So there is ONE harness
 * rate, roughly 3-8%, not the four contradictory ones an earlier revision of
 * this comment claimed in order to argue no rate could be quoted.
 *
 * The real ingest is the outlier. Against the pooled rate, 0 of 60 has
 * probability 0.033, and compared like with like -- harness and ingest both at
 * a single teardown -- 5 of 40 against 0 of 60 gives Fisher exact p = 0.009. It
 * really does behave differently, WHY is not established, and it is not
 * teardown count, because both are one. Do not rely on the difference.
 *
 * Those ingests genuinely parsed, so 0 of 60 is not a silently broken addon.
 * A bindings failure would move BOTH counters and both read zero: the workers
 * die at module evaluation, which raises the reported `parseError`
 * (`parseErrors + crashedParses()`), and their tasks resolve null, which raises
 * `unparsed`. They are not disjoint -- an earlier revision said they "catch
 * different things", and `ingest.ts` says the opposite in as many words. What
 * `unparsed` catches ALONE is the quieter case of a healthy worker returning
 * null because an optional grammar is absent. The graph also held 300 classes
 * and 300 functions.
 *
 * What is established: the crash is real, reproducible, and it reached the
 * suite. `ingest-files.test.ts` drives 14 real ingests per vitest process and
 * produced it as an intermittent "Worker exited unexpectedly". The MCP server's
 * in-process runner (`createInProcessRunner`, the default unless
 * IX_MCP_SUBPROCESS=1) has that same many-pools-in-one-process shape, which is
 * why it is named; it was not measured.
 *
 * Note the addon is loaded at SPAWN, not at first parse: the `tree-sitter`
 * import and its twelve grammars are static in `index.ts`, and this file
 * statically imports that. Every spawned worker holds it. Parsing still seems
 * to be what arms the crash -- spawn-then-destroy without any parse did not
 * reproduce it (0 of 6) -- but do not treat a never-dispatched worker as
 * addon-free.
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
