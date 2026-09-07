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
 * How often, measured on the pre-fix build (Windows / Node 26). Two populations,
 * and they differ by more than an order of magnitude:
 *
 *   MINIMAL HARNESS (pool of 21, nothing else in the process)
 *     twenty teardowns per process        19 of 28 runs crashed
 *     one teardown then exit               5 of 40
 *     -> fitting both: 6.3% per teardown, 95% CI 4.1-9.3%
 *
 *   REAL INGESTS
 *     `ingest-files.test.ts` in vitest     2 of 75 processes
 *     -> the file drove 9-10 ingests per process when that was measured, so
 *        about 0.3% per teardown (1.9% when the machine was loaded). It drives
 *        14 today: redo the division, do not reuse the 0.3%.
 *     a real `ix ingest` of 300 files      0 of 60
 *     -> at 0.3% the chance of zero in 60 is 0.84; entirely expected
 *
 * So the harness overstates real exposure by more than twenty times, and the
 * CLI result is not the anomaly it looks like on its own -- it agrees with the
 * vitest figure. Do not size anything from the harness rate.
 *
 * Two earlier revisions of this comment got this wrong in opposite directions:
 * one read 0 of 60 as proving the CLI exempt, the other quoted the harness rate
 * as though it applied to a real run. What reconciles every dataset is simply
 * that real ingests crash rarely rather than never. WHY they differ from the
 * harness is not established.
 *
 * Those ingests genuinely parsed, so 0 of 60 is not a silently broken addon.
 * A bindings failure would move BOTH counters and both read zero: the workers
 * die at module evaluation, which raises the REPORTED `parseError` (the
 * `+ crashedParses()` fold in `skipReasons.parseError`), and their tasks resolve
 * null, which raises `unparsed`. Be precise about which counter -- the raw
 * `parseErrors` variable and `filesSkippedUnparsed` ARE disjoint, which is what
 * `ingest.ts` says next to that fold and why the fold exists. What `unparsed`
 * catches ALONE is a live worker returning null -- a missing optional grammar,
 * or a parse that THREW, which `parseFile` catches internally and reports the
 * same way, so neither the worker nor the counter can tell them apart (see the
 * note on `skipReasons.unparsed` in `ingest.ts`). The graph also held 300
 * classes and 300 functions.
 *
 * The rate is per teardown of a 21-worker pool (`os.cpus().length - 1` on the
 * machine that measured it). Exposure plainly depends on how many addon-loaded
 * isolates are disposed, so do not carry 6.3% to a pool of a different size.
 *
 * Note the addon is loaded at SPAWN, not at first parse: the `tree-sitter`
 * import and its twelve grammars are static in `index.ts`, and this file
 * statically imports that, so every spawned REAL worker holds it. Parsing still
 * seems to be what arms the crash -- spawn-then-destroy with no parse did not
 * reproduce it in 6 runs of twenty teardowns, an outcome the fitted rate makes
 * a 0.04% event ACROSS the six (per single run it predicts 27% clean, so one
 * clean run would mean nothing) -- but that is an observation about arming,
 * not a licence to treat a never-dispatched worker as safe to terminate.
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
