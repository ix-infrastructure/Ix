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
runs each:

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

**The addon is held from spawn, not from the first parse.**
`core-ingestion/src/index.ts` resolves grammars at module scope and
`parse-worker.ts` imports it statically. A spawned worker always holds the core
plus the **twelve statically imported** grammars — not "13 required", because
`tree-sitter-powershell` is a required dependency that nonetheless loads
through a null-returning helper. That is the precondition the crash needs, so
an undispatched worker is **not known to be safe to terminate**. Workers that
had parsed were the ones observed to crash and spawn-then-destroy was not, but
the mechanism was never isolated and the rate for undispatched workers was
never measured.

**Known theoretical exposure that does not manifest.** `core-ingestion`'s own
suite runs `vitest run --pool threads` and 36 of its 38 test files import
`./index.js`, so every vitest worker thread holds the addon from spawn and
tinypool tears those threads down. Measured anyway: 0 segfault signatures in 10
local runs, and the `core-ingestion tests` CI step passes on all five matrix
legs. Recorded so the next reader does not have to rediscover the question.

## Superseded figures

Earlier revisions of this work stated, and then retracted, that roughly one
`ix map` in twelve exited 139. That was the harness rate applied to a consumer
it was never measured on. Do not reconstruct numbers from the commit history:
`main` squash-merges, so the log for these files still carries #598's retracted
figures, and this PR's squashed body concatenates every superseded value beside
its correction. This file is the current record.
