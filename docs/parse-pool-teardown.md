# Parse-pool teardown: why nothing calls `terminate()`

`ParsePool` never terminates a worker. It asks (`__shutdown`), waits, and
`unref()`s one that will not answer. This file is the durable record of why,
and of what was and was not measured. The code carries the rule; the numbers
live here so they do not have to be kept consistent across three source files.

Origin: Ix#598 (the fix) and Ix#650 (this correction). Windows / Node 26,
against a live backend.

**Reproducing these arms, precisely, because no single commit runs them
all.** They need the `terminate()` teardown that #598 removed, and the fix
landed BEFORE the test file the real-ingest arm drives:

| commit | | |
|---|---|---|
| `084f472` | #570 | last build with the `terminate()` teardown |
| `20e1dae` | #598 | the fix -- teardown becomes `__shutdown` + `unref()` |
| `b9b84ef` | #597 | adds `ingest-files.test.ts` AND the loader's vm fallback |

So:

- The **minimal harness** arm runs at `084f472` -- but the harness itself is
  not in the repo, at that commit or any other, and it produced the 6.3% that
  is the numerator of the ratios that compare it to real ingests -- 28× and
  3.86×, though not the 7× idle-vs-loaded further down, which is real against
  real. So by this section's own standard it
  is not reproducible either: the build is named, the program is not.
- The **real-ingest** arm needs both, and no commit has both -- checked every
  commit on `main`. It was measured on a hand-assembled tree: `084f472`, plus
  TWO files from `b9b84ef` --

      ix-cli/src/cli/__tests__/ingest-files.test.ts   the harness itself
      ix-cli/src/cli/commands/ingestion-loader.ts     or it cannot run at all

  The loader is not optional. `loadIngestionModules` reaches the built
  `core-ingestion` through `new Function("return import(specifier)")`, and
  inside vitest's vm context that throws `A dynamic import callback was not
  specified`. `b9b84ef` added the fallback for exactly that; `084f472` has the
  indirection and no fallback, so the ONE-file recipe an earlier revision of
  this section gave -- the test file alone -- throws on the first `run()` and
  measures zero ingests, not twelve. That is what the second file above
  fixes. Before that it said "check out `084f472`", which gives "no such
  file". Say the whole recipe or the arm is not reproducible.
- The **vitest** check needs the CURRENT tree, not either of those: its
  "36 of 38" is today's count.

## The bug

`Worker.terminate()` on a thread that has loaded the tree-sitter native
bindings segfaults the **process**. It presents as **exit 139 after a
completely successful ingest** — patches committed, summary printed, and a
non-zero `$?` for anything that reads it.

The comparison that settles the verb, twenty pool teardowns per process, six
runs of each variant. Those six `terminate()` runs are **not a separate
experiment**: they are one of the three arms pooled into the 19-of-28 figure
below (7 of 12, 7 of 10, and these 5 of 6). Read on their own they imply 8.6%
per POOL teardown (every rate in this file is per pool unless it says
per-isolate; for this 21-worker pool the two differ by ~20×, and the
conversion is worked through below), which is close to the retracted "one in
twelve" — that is the
hazard of quoting a single arm, and the reason the fit below uses all of
them.

| teardown | result |
|---|---|
| `terminate()` | 5 of 6 runs died with SIGSEGV (139) |
| worker closes its own port | 0 of 6 |
| worker calls `process.exit(0)` | 0 of 6 |

## How often

Two populations, and they differ by more than an order of magnitude. All of
this is for a **21-worker pool** (`os.cpus().length - 1` on the measuring
machine); exposure depends on how many addon-loaded isolates are disposed, so
none of it carries to a pool of another size. CI runners are 3–4 vCPU, giving
pools of 2–3.

**Minimal harness** — nothing else in the process:

| configuration | result |
|---|---|
| twenty teardowns per process | 19 of 28 runs crashed |
| one teardown then exit | 5 of 40 |

Both arms fit one rate: **6.3% per POOL teardown, 95% CI 4.1–9.3%** — that
is one teardown disposing all 21 of the pool's isolates, not one isolate. The
per-isolate hazard is 0.31%; see the vitest section for why the difference
matters. Pooling is
licensed by asking whether the one-teardown arm contradicts the
twenty-teardown arm's own rate (5.5%, again per pool):
`P(≥5 of 40 | p=0.055) = 0.067` — a failure to reject, borderline, not a
demonstration of agreement.

**Real ingests** — `ingest-files.test.ts` under vitest. That file drives a
FIXED number of ingests per process, not an average: **12** at `b9b84ef`, the
version measured (14 today). The per-teardown rate is `1-(1-p)^12` solved
against the process counts.

The exponent is TEARDOWNS, and 12 is the ingest count, so that step rests on a
premise worth writing down: `ingestFiles` creates its pool lazily, through
`ensureParsePool()`, so an ingest that parses no file tears nothing down. Every
ingest in that file parses at least one — the `fixture(N)` calls are all
N > 0, with `force: true` — so ingests and teardowns coincide there. Add an
empty-repo or unsupported-extension case and they stop coinciding, and
updating this
exponent to the new ingest count would understate the rate with nothing red.
That is the same unrecorded-derivation failure that made 9.5 unfalsifiable.

| configuration | result | per POOL teardown |
|---|---|---|
| idle machine | 2 of 75 processes | 0.225% |
| loaded machine | 9 of 50 processes | 1.64% |

(Per pool, as everywhere else here — not per isolate. 0.225% sits near the
0.31% per-ISOLATE hazard derived below, and they are not the same quantity.)

Earlier revisions divided by **9.5**, giving 0.28% and 2.1%. That number is
not derivable from any version of the file and no derivation was ever
recorded, so it is withdrawn. It was not harmless: it sets the headline ratio
below, and 9.5 is the flattering end — the correction moves the harness
overstatement from 22× to 28×, i.e. further from the harness, not nearer.

Fisher exact on 2/75 vs 9/50 is **p = 0.007** two-sided (0.004 one-sided), and
is unaffected by the divisor since it compares process counts. A real
`ix ingest` of 300 files was **0 of 60** — that is *one* teardown per process,
and `P(zero in 60)` is 0.87 at the idle rate, 0.37 at the loaded one.
Unremarkable under either.

## The grammar tally

The source comments defer here for this, so it has to actually be here.
`core-ingestion/src/index.ts` resolves **27 grammars** plus the tree-sitter
core:

| how it loads | count | can it be absent? |
|---|---|---|
| static `import` | 12 | no -- evaluation fails if the package is missing |
| `tryLoadGrammar` (sync helper) | 11 | yes, returns null |
| `tryImportGrammar` (async helper) | 4 | yes, returns null |

Cross-cutting that, `package.json` has **13 required** grammars and 14
optional. The two splits do not line up: `tree-sitter-powershell` is a
REQUIRED dependency that still loads through the async helper, which is why
the guaranteed floor is "the core plus the twelve static ones" and not "the 13
required". That one package is the whole reason the distinction is worth
writing down.

## What this does and does not establish

The minimal harness overstates real exposure by **28×** on the only
load-matched comparison available (idle vs idle). Against the loaded real rate
it is **3.86×** (6.3267 / 1.6397; the printed 6.3 / 1.64 gives 3.84, which is
why this one is written to two decimals rather than rounded into an
ambiguity). An earlier revision labelled 6.327 / 1.640 as "the unrounded MLE
over the unrounded loaded rate" -- both are themselves rounded, and a reader
following this file's own convention would recompute from the real values and
think one of the two paragraphs wrong. That comparison mixes
conditions — the harness was never run loaded, and load raises the rate — so
treat it as a lower bound on what is unexplained, not the residue after
subtracting load.

**Parses per worker is not controlled.** `ingestFiles` parses a `.ts` file
twice (index prescan, then streaming loop, both on the same pool), so file
counts double; and `ingest-files.test.ts` is not uniformly 30 files — it calls
`fixture(30)` **seven** times, `fixture(12)` once and `fixture(4)` twice at
`b9b84ef` — the measured version; it is eight/one/two today — giving 0.38 to
2.9 parses per worker across its runs and straddling the harness's ~1.4.
An earlier claim that "the harness parses the least per worker and crashes the
most" is therefore false for several of the teardowns behind the data. This
remains an open confound.

**The addon is held from module evaluation, not from the first parse.**
`core-ingestion/src/index.ts` resolves grammars at module scope and
`parse-worker.ts` imports it statically, so a worker reaches that state on its
own, without being dispatched. Undispatched workers at teardown are ordinary,
not exotic: `init()` spawns `concurrency` of them up front, so any batch
smaller than the pool leaves some that never received a task. (The addon-free
window is much narrower than "before the first parse": `tree-sitter` and the
twelve grammars are `index.ts`'s own static imports, near the top of its
dependency graph, so the isolate holds them within moments of `new Worker()`
and long before `index.ts`'s body — let alone its top-level `await`s —
runs. A worker suspended at one of those awaits already holds all twelve.) Once
evaluated, a worker holds the core
plus the **twelve statically imported** grammars — not "13 required", because
`tree-sitter-powershell` is a required dependency that nonetheless loads
through a null-returning helper. That is the precondition the crash needs, so
an undispatched worker is **not known to be safe to terminate**. Workers that
had parsed were the ones observed to crash, and a spawn-then-destroy arm went
0 of 120 teardowns. **Do not use that arm.** Its harness calls `pool.init()`
and then `await pool.destroy()` with nothing in between — no wait for an ack
or an `'online'` event. The inference is that it therefore tore the workers
down inside the addon-free window
described above. It measured threads that had not finished loading, which is a
different population from "evaluated but never dispatched", and it therefore
says nothing about whether parsing matters. Earlier revisions of this document
read a `p = 4e-4` rejection and a 2.5% upper bound out of it; both are
withdrawn.

So there is **no measurement** distinguishing an evaluated-but-undispatched
worker from a parsed one. The rule rests on the mechanism instead: such a
worker holds the addon, which is the precondition the crash needs, and nothing
has shown it is safe to terminate.

**A consistency check on another consumer that terminates addon-loaded
threads.** `core-ingestion`'s own suite runs `vitest run --pool threads`, and
36 of its 38 test files import `./index.js`. The mechanism differs from the
parse worker's: vitest's worker entry does not import `core-ingestion`, so a
thread picks the addon up when it *evaluates* such a test file, not at spawn —
a thread can be spawned and torn down having run none. Either way the threads
are terminated, which is the exposed shape: vitest 4's `ThreadsPoolWorker`
does `await this.thread.terminate()` in its `stop()`, called per worker.

Not tinypool, which earlier revisions of this file named. Vitest 4 dropped it:
it is absent from `vitest@4.1.11`'s dependencies, from both lockfiles and from
`node_modules` entirely. The conclusion was right and the attribution was not,
which is worse than useless in the one document whose job is to be checkable.

Measured: **0 segfault signatures in 10 local runs.** The `core-ingestion
tests` CI step also passes on all five matrix legs, but do not weigh that
equally: CI runs Node 22 and 24, where everything here was measured on Node
26. That is the whole of the objection — the runners' 3–4 vCPUs are NOT a
second reason, because under per-file isolation vCPU count sets how many
threads run at once, not how many are terminated, and it is the latter the
arithmetic below indexes. The 10 local runs are the measurement; CI is a
weaker corroboration.

Either way the result is consistent with everything else here, and it is worth
showing the conversion, because getting it wrong once made this section claim a
falsification it does not support.

The 6.3% is per POOL teardown, and a pool disposes 21 isolates. Treating
those disposals as independent gives `1-(1-h)^21 = 0.063`, i.e. **h = 0.31%**
— a factor of **20.4** (6.3267 / 0.3107; the printed figures give 20.3). The
fifth digit on the MLE is why h shows 0.3107 and not 0.3108: recomputing from
a 4-digit 6.327 gives the latter. It changes nothing above -- 6.3267/0.3108 is
20.36 and still rounds to 20.4 -- but this is the paragraph about a
mis-rounded conversion factor, so the operand that actually reproduces the
printed one is the one to give. And
for a pool of 21 that is the only shape the answer can
take: at small h the pool rate is about 21h, so the ratio can approach 21 and
never exceed it. Any conversion factor larger than the pool size is arithmetic
that went wrong, which is how a bad conversion factor quoted here in an
earlier revision was caught: it divided 8.6% by 0.31%, a single arm's per-pool
rate against the pooled per-isolate one, and got 27.7. Written out because it
rounds to 28 and so does the harness-overstatement figure above, which is
correct and unrelated (6.3% over 0.225%). Two different quantities landing on
the same rounded number, one of them retracted, is exactly the confusion this
file exists to prevent.

**Independence is an assumption, and this document has direct evidence
against it.** The idle-vs-loaded real-ingest rates differ 7× at identical pool
size, and the harness overstates idle real ingests by 28×, so something not in
the model moves the rate. Carrying `h` from the harness onto vitest's
one-at-a-time terminations is also a cross-population transfer — the same move
this file retracts for the "one in twelve" figure. The conclusion survives
either way, which is why it is stated rather than hedged away: redo it with
the real-ingest IDLE hazard instead — 0.225% per pool over 21 isolates is
h = 1.07e-4, and 36 terminated isolates over 10 runs gives **0.96** — against
0.33, both unremarkable. Nothing here rests on the exact h. (An earlier
revision said 0.95. That was not an arithmetic slip -- 0.95 is what the
withdrawn 0.28% idle rate gives (0.953, which the file rounded to 0.95) -- it
moved because the rate
under it did.) Do not read that as "and
everything else is exact" — an earlier revision of this parenthetical said so
and was wrong in the same breath: the conversion factor earlier in this same
section read 20.5 where its own inputs give 20.4. Ratios here are quoted from
unrounded
inputs, so recomputing from the ROUNDED figures printed beside them can differ
in the last digit; where that changes the rounding, the operands are given.

How many addon-loaded isolates a run terminates is not a guess: `isolate`
defaults to `true`, `core-ingestion` ships no vitest config to change it, and
vitest reuses a runner only when the finished task AND the next queued one are
both non-isolated. Otherwise it stops the worker after the file. So the run
spawns and terminates about one worker per test file — **36 addon-loaded**, of
38 — giving `P(0 crashes in 10 runs) = 0.33`. Unremarkable, and nothing to
explain.

Note this is the count of TERMINATED threads, which is what the hazard applies
to. Machine parallelism (21 here) bounds how many run concurrently and is not
this quantity; an earlier revision offered 10 / 21 / 36 as a bracket over an
unknown, when the config already determined it.

Mixing the two units — applying a per-pool rate to individual isolates — is
the easiest error in this document to make, and the reason every rate here
says which it is.

## The unref-at-exit arm

`shutdown()`'s give-up path leaves an unresponsive worker alive and
`unref()`'d, and the source comments defer here for what that costs.

Measured: **four addon-loaded threads left live and unref'd across process
exit, 0 failures in 10 runs.** On its own that carries very little, and the
comparison to make is not against the `terminate()` row of the table above:
that row is twenty teardowns of a 21-worker pool per run, while this is four
isolates in one teardown per run. At the per-isolate h = 0.31%, four isolates
is ~1.2% per run and `P(0 in 10)` is 0.88 -- so this arm would look exactly
like this whether the path is safe or not. It has no power, and it is recorded
so nobody mistakes it for reassurance.

What carries the argument is the mechanism, and it was probed separately:
spawn a worker, `unref()` it, let the process end, and the parent never
receives an `'exit'` event while the worker's own `process.on('exit')` never
runs -- the process leaves at code 0 with the thread still live. Process exit
does not run the orderly per-worker shutdown that `terminate()` drives. That
is why `unref()` is not simply a deferred `terminate()`.

## Superseded figures

Earlier revisions of this work stated, and then retracted, that roughly one
`ix map` in twelve exited 139. That was the harness rate applied to a consumer
it was never measured on. Do not reconstruct numbers from the commit history:
`main` squash-merges, so the log for these files still carries #598's retracted
figures, and this PR's squashed body concatenates every superseded value beside
its correction. This file is the current record.
