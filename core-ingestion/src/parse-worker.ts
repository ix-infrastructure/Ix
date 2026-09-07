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
 *   REAL INGESTS (`ingest-files.test.ts` under vitest, ~9.5 ingests per
 *   process at the time; it drives 14 today)
 *     idle machine                         2 of 75 processes  -> 0.28%/teardown
 *     loaded machine                       9 of 50 processes  -> 2.1%/teardown
 *     a real `ix ingest` of 300 files      0 of 60
 *     -> P(zero in 60) is 0.84 at the idle rate and 0.29 at the loaded one, so
 *        the CLI result is unremarkable under either
 *
 * PLAN AGAINST THE LOADED RATE. CI is the loaded case, and the two differ by
 * 7.3x. Today's exposure for that file, multiplying the per-teardown rate back
 * up over its 14 ingests, is 3.9% of processes when idle and 25% when loaded --
 * quoting the idle number as "the" number understates a CI leg by 6.5x (the
 * 7.3x above is the per-teardown ratio; these are per-process). The loaded
 * figure rests on 9 of 50 processes, so its 95% interval is wide: 12%-43% once
 * rolled up. Wide, and still an order above the idle case -- Fisher exact on
 * 2/75 against 9/50 is p = 0.006.
 *
 * The per-teardown rate is the portable quantity; the per-process counts
 * are the ones tied to ~9.5, so multiply back up rather than re-dividing 2 of
 * 75 by 14.
 *
 * Load also accounts for most of the harness/real gap: the harness is 22x the
 * idle rate but only 3.1x the loaded one. What remains unexplained is that 3.1x,
 * not the 22x an earlier revision of this comment made much of.
 *
 * Parses per worker is NOT controlled anywhere, and counting it properly turns
 * it from a threat into a second argument. `ingestFiles` parses a `.ts` file
 * TWICE -- once in the index prescan and once in the streaming loop, both on
 * this pool -- so a 30-file ingest dispatches ~60 tasks, not 30. Over a
 * 21-worker pool that is ~2.9 per worker for the vitest fixture and ~28.6 for
 * the 300-file `ix ingest`, against ~1.4 for the harness, which does no
 * prescan.
 *
 * So the harness parses the LEAST per worker and crashes the most, by 22x. If
 * exposure grew with parses per worker the ordering would be the other way
 * round, which makes it an unlikely explanation for the gap rather than an
 * uncontrolled one. It is still uncontrolled between the two real-ingest
 * datasets (2.9 against 28.6), and there the same reasoning applies: the CLI
 * parses ten times more per worker and crashed zero times in 60.
 *
 * So the harness overstates real exposure -- 22x against an idle machine, 3.1x
 * against a loaded one -- and the CLI result is not the anomaly it looks like
 * on its own: it agrees with the vitest figure. Do not size anything from the
 * harness rate.
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
 * Note the addon is loaded at SPAWN, not at first parse: `index.ts` pulls in
 * `tree-sitter` and twelve grammars by static import, ELEVEN more optional ones
 * eagerly through `tryLoadGrammar` at module scope, and four more through
 * top-level `await` -- 27 grammars plus the core, so up to 28 native addons,
 * all resolved before this file's body runs and held by every spawned REAL
 * worker. Up to, because 14 of the 27 are optional dependencies that load
 * through helpers returning null when absent: the Windows machine these
 * numbers came from has no `tree-sitter-sas` prebuild, and an
 * `--omit=optional` install holds only the 13 required grammars. The floor is
 * what matters for the conclusion -- a spawned worker always holds the core
 * and a dozen-odd grammars, never zero. Parsing still
 * seems to be what arms the crash -- spawn-then-destroy with no parse did not
 * reproduce it in 6 runs of twenty teardowns, an outcome the fitted rate makes
 * a 0.04% event ACROSS the six (per single run it predicts 27% clean, so one
 * clean run would mean nothing).
 *
 * That experiment is confounded, though, and the inference is weaker than it
 * looks: four of those grammar loads are TOP-LEVEL `await`, so a worker's
 * module evaluation is still suspended for a moment after spawn and its
 * `message` handler is not yet registered. A worker destroyed in that window
 * could not answer `__shutdown` and may not have finished loading either, so
 * "no parse" and "not fully loaded" are not separated. Treat "parsing arms it"
 * as unproven, and certainly not as a licence to terminate a never-dispatched
 * worker.
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
