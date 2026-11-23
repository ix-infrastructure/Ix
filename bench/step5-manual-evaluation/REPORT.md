# Step 5 controlled manual MVP evaluation

**B-01 through B-07 passed. The controlled fixture is ready for a separately reviewed, read-only Ix self-hosting experiment. Production rollout remains blocked by the unresolved +5% no-evidence ix_explain latency gate.** The live Codex workflow met the functional and context-size criteria. It did not meet the practical usefulness criterion in the nine matched pairs. The separate packet-replay experiment met the source-read criterion. The two measurements answer different questions.

## What the real default call returned

After the development build ran ordinary `map .`, Codex called `ix_context({"target":"Job"})` once and opened zero source files. The raw MCP text includes this evidence record.

```text
evidence kind=behavior title="Mapped state writes" observed_evidence="stop writes this.status = \"done\" in \"job.ts\" [7,4,7,24], candidate prior unknown. start writes this.status = \"running\" in \"job.ts\" [4,34,4,57], guard true \"this.status === \\\"queued\\\"\" [4,8,4,32], candidate prior \"queued\". class view covers returned members only"
```

Both methods resolved under class `acdd4e44-6d65-e1b3-3782-0fcc7cc62abd` and one instance-field slot `39b72c02eceac8cf9aa854b9f2c4c50733741cf89c178bd26cbda7c08d393696`. The write and guard spans use one-based lines and zero-based UTF-16 columns with an exclusive end. The guard constrains the observed branch. The response supplies a candidate prior and the assignment destination. It establishes neither an initial/terminal state nor an ordering between calls. The class projection covers only returned members.

The demonstration took 16.34 s. The model service reported 41,257 input tokens, including 37,248 cached, and 272 output tokens. Its default tool text contained 1116 bytes. See runs/demonstration.jsonl for the complete argument, return and answer.

## Source and lifecycle checks

| Case | Oracle observation | Result | Mapped writes | Default bytes | Behavioral row estimated tokens |
|---|---|---|---:|---:|---:|
| B-01 | One slot shared across start and stop. Guard, candidate prior and all source slices match. | PASS | 2 | 1116 | 164 |
| B-02 | Only the guard and inferred prior change to paused. The stop write ID survives. | PASS | 2 | 1116 | 164 |
| B-03 | Destination changes to active. The prior remains paused. | PASS | 2 | 1115 | 163 |
| B-04 | The enabled guard remains observed. Both candidate priors are unknown. | PASS | 2 | 1089 | 151 |
| B-05 | The done write is retired. The stop method ID survives. | PASS | 1 | 1027 | 122 |
| B-06 | All current writes disappear. The class and both original method IDs still resolve. | PASS | 0 | 767 | 0 |
| B-07 | Original sites, IDs, source hash, spans, guards and priors restored in the original workspace. | PASS | 2 | 1116 | 164 |

Full class and both individually resolved method projections were checked at every revision. The default-text checker independently reconstructed expected assignments, guards, priors and citation slices from each fixture and the pre-map labels. A negative control replaced the unknown prior for stop and the checker rejected it. See audit.jsonl, verify-default.log and each *-audit.json.

## Matched Codex trials

Three pairs per source revision and comparison yielded 36 separately launched sessions plus the demonstration. Each arm has nine runs. Medians below are calculated across sessions within each arm. Model tokens are telemetry reported by Codex. Visible context is a separate estimate over supplied packet text and actual tool outputs.

| Arm | Score /10 | Source reads, total | All tools, total | Visible context, median tokens | Model input, median | Cached input, median | Output, median | Wall, median s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| source | 10 | 9 | 9 | 92 | 43,694 | 36,992 | 287 | 11.94 |
| live | 10 | 9 | 18 | 601 | 68,668 | 57,984 | 358 | 16.04 |
| ablated | 10 | 9 | 9 | 450 | 44,343 | 37,248 | 270 | 13.88 |
| full | 10 | 3 | 3 | 509 | 13,491 | 10,368 | 206 | 8.83 |

Practical trials compare source-only with a live default call plus optional source. Ablation trials compare replayed packets with exactly one behavioral line removed or retained, with identical access to the source reader. Columns below are medians of within-pair differences, treatment minus control.

| Comparison | Wins/ties/losses on score | Score Δ | Source reads Δ | All tools Δ | Visible tokens Δ | Actual input Δ | Output Δ | Seconds Δ |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| live minus source | 1/8/0 | +0 | +0 | +1 | +509 | +26,332 | +100 | +4.55 |
| full minus ablated | 2/7/0 | +0 | -1 | -1 | +59 | -30,852 | -63 | -4.11 |

| Revision | Comparison | Per-pair score differences | Per-pair source-read differences |
|---|---|---|---|
| V0 | live minus source | 0, 0, 0 | 0, 0, 0 |
| V0 | full minus ablated | 0, 0, 0 | -1, -1, -1 |
| B04 | live minus source | 1, 0, 0 | 0, 0, 0 |
| B04 | full minus ablated | 0, 1, 1 | -1, -1, -1 |
| B06 | live minus source | 0, 0, 0 | 0, 0, 0 |
| B06 | full minus ablated | 0, 0, 0 | 0, 0, 0 |

## Errors, limits and readiness

- The source oracle matched all 11 expected write observations over seven maps: 11 true positives, zero false positives and zero false negatives. These observations include repeated sites at different revisions. All six observed guards, all 11 prior classifications (four equality candidates and seven unknowns), and all 17 assignment/guard citations matched. B-06 was assessed independently for absence of stale evidence. Both original method nodes omitted behavior_v1 at B-06 and regained it at B-07, as confirmed by real entity reads. The two slot writes restored with the original IDs. No stale or incorrect product evidence was observed.
- For the original fixture the behavioral record added 349 characters, or 164 estimated tokens when its own length is rounded up. The full default response cost 522 estimated tokens versus 359 after ablation. Rounding the packet totals separately gives a 163-token difference. Every revision stayed within the proposed 200-token incremental budget. This estimate and the much larger model-service input totals measure different boundaries.
- The live practical arm scored 90/90 versus 89/90 for source-only, with one point gained in one pair. Both arms read the source in all nine runs. The median paired score gain and source-read saving were zero. Codex took an additional 4.55 seconds per pair at the median and made an additional tool call. The fixture offers no practical usefulness win under the agreed criterion.
- The intact replay packet scored 90/90 versus 88/90 for the ablated packet. The median score change was zero and the median source-read saving was one, meeting the alternative rubric criterion. All six evidence-bearing intact replays answered without opening source and gave exact assignment and guard columns. All six matched ablated runs opened source. At the zero-write revision the two packets were byte-identical and all six replay runs opened source. Live-Ix answers gave exact spans for both sites and the guard in two of six evidence-bearing runs.
- Across 36 graded answers there were zero observed hallucinations or critical errors. Three answers correctly described conditional predecessor examples after B-04 but left the requested unknown-prior classification implicit. Each lost one prior-state point. Because the prompts disclosed that this was a one-file repository and the reader returned the entire file, a source-backed claim of exhaustiveness within that file was acceptable. No turn was credited for inferring repository-wide completeness from the absence of a mapped record alone.
- At B-05, the first operator audit incorrectly required zero unavailable owners. Ix correctly retained the stop symbol, cleared its write and explicitly reported one unavailable owner in the remaining class view. The exact-text checker also initially treated the parameter named enabled as a second candidate guard span. It now checks the occurrence inside the if condition. Both checks were corrected against the design and the independent source without changing any response or product code. The original lifecycle audit and corrected results are preserved. At B-06, the default response contained structural facts without a behavioral row or an explicit verified-absence claim.
- The small single-class task, repeated source versions, score ceiling, required first Ix call and one model/effort setting limit generalization. The per-session source reader enabled exact read accounting, while its one-call full-file granularity made source access inexpensive. Differences in tool turns affect billed/context input and cache behavior. Wall times are descriptive. The replay control retains the original evidence count in its header so every other line remains unchanged.
- For a separately approved self-hosting experiment, label production owners and negative controls on a frozen Ix revision before mapping, and blind the labels from Codex. Include tasks spanning multiple owners or files, permit optional source verification in both arms, and report eligible-site count, per-pair accuracy, source reads, and actual model usage. Report an empty eligible sample as unmeasurable positive recall. The current result supports attempting that bounded experiment. It does not establish an agent productivity improvement or resolve the release gate.

Per-answer scores, comments and usage are in scorecards.csv. Pair differences are in pairs.csv. PROTOCOL.md describes isolation and reproduction. The evidence archive contains the unmodified model event streams, actual prompts, operator captures and per-revision source snapshots. Linux prerequisites for the deferred production benchmark are in TRACK-A-LINUX.md.
