# Parse-pool teardown: why nothing calls `terminate()`

`ParsePool` never terminates a worker. It asks (`__shutdown`), waits, and
`unref()`s one that will not answer. This file is the durable record of why,
and of what was and was not measured. The code carries the rule; the numbers
live here so they do not have to be kept consistent across three source files.

Origin: Ix#598 (the fix) and Ix#650 (this correction). Measurements are from
the pre-fix build `084f472`, Windows / Node 26, against a live backend.

## The bug

`Worker.terminate()` on a thread that has loaded the tree-sitter native
bindings segfaults the **process**. It presents as **exit 139 after a
completely successful ingest** — patches committed, summary printed, and a
non-zero `$?` for anything that reads it.

The comparison that settles the verb, twenty pool teardowns per process, six
runs of each variant. Those six `terminate()` runs are **not a separate
experiment**: they are one of the three arms pooled into the 19-of-28 figure
below (7 of 12, 7 of 10, and these 5 of 6). Read on their own they imply 8.6%
per teardown, which is close to the retracted "one in twelve" — that is the
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

Both arms fit one rate: **6.3% per teardown, 95% CI 4.1–9.3%**. Pooling is
licensed by asking whether the one-teardown arm contradicts the twenty-teardown
arm's own rate (5.5%): `P(≥5 of 40 | p=0.055) = 0.067` — a failure to reject,
borderline, not a demonstration of agreement.

**Real ingests** — `ingest-files.test.ts` under vitest, ~9.5 ingests per
process at the time of measuring (it drives 14 today):

| configuration | result | per teardown |
|---|---|---|
| idle machine | 2 of 75 processes | 0.28% |
| loaded machine | 9 of 50 processes | 2.1% |

Fisher exact on 2/75 vs 9/50 is **p = 0.007** two-sided (0.004 one-sided), so
load matters. A real `ix ingest` of 300 files was **0 of 60** — that is *one*
teardown per process, and `P(zero in 60)` is 0.84 at the idle rate, 0.29 at the
loaded one. Unremarkable under either.

## What this does and does not establish

The minimal harness overstates real exposure by **22×** on the only
load-matched comparison available (idle vs idle). Against the loaded real rate
it is 3.1×, but that mixes conditions — the harness was never run loaded, and
load raises the rate — so treat 3.1× as a lower bound on what is unexplained,
not the residue after subtracting load.

**Parses per worker is not controlled.** `ingestFiles` parses a `.ts` file
twice (index prescan, then streaming loop, both on the same pool), so file
counts double; and `ingest-files.test.ts` is not uniformly 30 files — it calls
`fixture(30)` eight times, `fixture(12)` once and `fixture(4)` twice, giving
0.38 to 2.9 parses per worker across its runs and straddling the harness's
~1.4. An earlier claim that "the harness parses the least per worker and
crashes the most" is therefore false for several of the teardowns behind the
data. This remains an open confound.

**The addon is held from module evaluation, not from the first parse.**
`core-ingestion/src/index.ts` resolves grammars at module scope and
`parse-worker.ts` imports it statically, so a worker reaches that state on its
own, without being dispatched. Undispatched workers at teardown are ordinary,
not exotic: `init()` spawns `concurrency` of them up front, so any batch
smaller than the pool leaves some that never received a task. (The addon-free
window is narrower than "before the first parse" — it is only between
`new Worker()` and the completion of the module's dependency-graph evaluation,
which ESM finishes before `index.ts`'s body and its top-level `await`s begin.
A worker suspended at one of those awaits already holds the core and all twelve
static grammars.) Once evaluated, a worker holds the core
plus the **twelve statically imported** grammars — not "13 required", because
`tree-sitter-powershell` is a required dependency that nonetheless loads
through a null-returning helper. That is the precondition the crash needs, so
an undispatched worker is **not known to be safe to terminate**. Workers that
had parsed were the ones observed to crash; spawn-then-destroy was not, over
**6 runs of twenty teardowns each — 0 of 120**. That is not a small sample:
under the fitted 6.3% it is a 0.04% outcome, so it rejects "holding the addon
is on its own enough" at p = 4e-4. Parsing, or something that travels with it,
does matter.

What it does NOT do is make an undispatched worker safe to terminate. Zero of
120 puts the 95% upper bound at **2.5% per teardown** — lower than the parsed
rate, and a long way from zero. That is the whole basis of the rule: not that
undispatched workers crash at the same rate, but that nobody has shown they do
not crash at all, and nobody has isolated the mechanism.

**The strongest evidence against the harness rate transferring.**
`core-ingestion`'s own suite runs `vitest run --pool threads`, and 36 of its 38
test files import `./index.js`. The mechanism differs from the parse worker's:
vitest's worker entry does not import `core-ingestion`, so a thread picks the
addon up when it *evaluates* such a test file, not at spawn — a thread can be
spawned and torn down having run none. Either way tinypool tears those threads
down with `terminate()`, which is the exposed shape.

Measured: **0 segfault signatures in 10 local runs**, and the `core-ingestion
tests` CI step passes on all five matrix legs. That is consistent with
everything else here, and it is worth showing the conversion, because getting
it wrong once made this section claim a falsification it does not support.

The 6.3% is per POOL teardown, and a pool disposes 21 isolates. The
per-isolate hazard is therefore `1-(1-h)^21 = 0.063`, i.e. **h = 0.31%**.
Tinypool terminates threads one at a time, so ~10 addon-loaded threads in a run
is ~3% per run and `P(0 in 10 runs) = 0.73`; even at one per test file it is
0.33. Nothing to explain.

Mixing the two units — applying a per-pool rate to individual isolates — is the
easiest error in this document to make, and the reason every rate here says
which it is.

## Superseded figures

Earlier revisions of this work stated, and then retracted, that roughly one
`ix map` in twelve exited 139. That was the harness rate applied to a consumer
it was never measured on. Do not reconstruct numbers from the commit history:
`main` squash-merges, so the log for these files still carries #598's retracted
figures, and this PR's squashed body concatenates every superseded value beside
its correction. This file is the current record.
