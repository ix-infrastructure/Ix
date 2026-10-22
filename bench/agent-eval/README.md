# With/without-Ix agent evaluation

This harness compares `baseline` and `ix` runs of the same agent, model, effort and budget. It records resolution, usage and time, and reports paired differences with bootstrap 90% confidence intervals. Run Claude Code and Codex as separate experiments.

## Offline smoke and tests

From the repository root, with Node 22+ on Linux or macOS:

```sh
node --test bench/agent-eval/test/eval.test.mjs
node bench/agent-eval/run.mjs --dry-run --out bench/agent-eval/results/smoke
```

Use a fresh output directory each time. The dry run executes subprocess setup, probes, a stub agent, evaluation, metrics parsing and reporting for three tasks × two arms × two repeats (12 runs). It requires neither Docker nor a paid agent. The checked-in `smoke.json` contains **synthetic tasks and placeholder SHAs**; its reports are explicitly synthetic and cannot establish Ix effectiveness.

The CLI test bridge runs portable manifest, telemetry and statistics tests on every platform in `npm test`, `test:unit` and `test:coverage`. POSIX orchestration/provisioning tests and the dry run are skipped on Windows; Linux/macOS retain that integration coverage. To exercise the portable subset alone, set `AGENT_EVAL_PORTABLE_ONLY=1` when invoking the Node test suite. The tests cover manifests, arm configuration/isolation, native telemetry fixtures, bootstrap bounds, committed solution patches, local provisioning and the smoke.

## Pin a real task set

**No real SWE-bench Verified manifest ships with this repository, and none was generated or checked during development.** Obtain an official `princeton-nlp/SWE-bench_Verified` test-split JSON array or JSONL export locally. Save it at `bench/agent-eval/local/verified.json`, retaining the upstream dataset revision and license information alongside it. Do not redistribute exports or task patches without checking upstream and repository licenses. The importer validates content but cannot authenticate provenance.

```sh
mkdir -p bench/agent-eval/local
# After placing your official export at local/verified.json:
node bench/agent-eval/manifest.mjs bench/agent-eval/local/verified.json bench/agent-eval/local/manifest-50.json
# A smaller real experiment: task count, minimum repo count, seed
node bench/agent-eval/manifest.mjs bench/agent-eval/local/verified.json bench/agent-eval/local/manifest-3.json 3 3 20261013
```

The default selects 50 tasks across at least five repos, using stable SHA-256 ranking by seed and task id. The generated manifest pins every task id, repo and base SHA, and the complete export hash. Preserve this manifest for reproduction. The runner checks each task against the hash-verified export. Gold/test patches are omitted from the manifest and native agent prompt.

SWE-PolyBench is not enabled; adding it requires license review and its official evaluator.

## Local real-run setup

Use a reachable Docker daemon, a pinned local official SWE-bench checkout, cached public task repos, a local Ix backend and the installed native agent. Docker image downloads and real agent usage may incur costs; there is no hosted benchmark dependency. Supply authentication through the native CLI's supported environment, never through benchmark JSON. Existing home-directory login caches are deliberately not copied. The harness does not provide a sandbox against a malicious solver accessing other host files; use a disposable machine with no unrelated data.

1. Obtain the official SWE-bench source locally at a chosen full commit SHA. Keep its tracked files clean and install its dependencies:

   ```sh
   python3 -m venv bench/agent-eval/local/venv
   bench/agent-eval/local/venv/bin/python -m pip install -e bench/agent-eval/local/SWE-bench
   git -C bench/agent-eval/local/SWE-bench rev-parse HEAD
   ```

   Set `evaluator.revision` to that SHA and retain dependency versions and Docker image digests with the experiment. The evaluator verifies HEAD/cleanliness and imports from that checkout. Evaluation uses the saved official export, one worker and a separate deadline.

2. Cache a bare clone of each selected repo as `local/repos/OWNER__NAME.git`. Each cache must contain the manifest's base commits. For each locally obtained public task checkout:

   ```sh
   mkdir -p bench/agent-eval/local/repos
   git clone --bare /path/to/public-task-checkout bench/agent-eval/local/repos/OWNER__NAME.git
   ```

   The runner only clones from these caches, with detached pinned checkouts; it never fetches task repositories.

3. Build Ix in this checkout and start a dedicated local backend using the repository's documented Docker setup. Keep the backend image digest fixed throughout the experiment and save it with the results. No backend reset is performed by this harness.

   ```sh
   npm --prefix ix-cli ci
   npm --prefix ix-cli run build
   node ix-cli/dist/cli/main.js --version
   git rev-parse HEAD
   ```

4. Copy `bench/agent-eval/config.example.json` to `bench/agent-eval/local/config.json`. Fill in the native agent version, immutable model id, built Ix version, Ix source SHA and SWE-bench SHA. `environment.source_path` points to the Ix checkout; `ix_cli` points to its built CLI entrypoint; `plugin_revision` is its full HEAD SHA. Tracked CLI source and skills must match that SHA. Configure the reachable loopback `endpoint` (default example: `http://127.0.0.1:8090`). Config paths are relative to the invocation directory; run from the repository root. The example uses supplied setup/probe programs; no adapter implementation is needed.

5. Run a small real experiment before scaling:

   ```sh
   node bench/agent-eval/run.mjs --manifest bench/agent-eval/local/manifest-3.json --config bench/agent-eval/local/config.json --out /path/to/isolated-eval-results/verified-3
   # Use manifest-50.json and a fresh output directory for the full subset.
   ```

For Codex, set both `agent.family` and `agent.telemetry` to `codex`. For Claude Code, use `claude`. Keep the supplied `agent.command`. `agent.binary` can pin an absolute executable; otherwise it is resolved before isolation. `agent.args` supplies shared noninteractive permission options supported by your pinned version and must not override integrations. `claude --print` denies anything that would prompt. The example therefore passes `--permission-mode acceptEdits` in `agent.args` and lists shared tool rules (`Bash`) in `agent.allowed_tools`. The harness emits a single `--allowedTools` from that list and, for the ix arm only, adds the Ix MCP server rule (`mcp__plugin_ix-agent-eval_ix-memory`). `agent.args` cannot carry `--allowedTools` or any plugin/MCP/settings flag, and `agent.allowed_tools` cannot grant MCP tools. If Claude reports an Ix tool permission denial, the run fails instead of counting it as an Ix error. For Codex, `codex exec` needs an explicit `--sandbox` mode that can write the checkout (for example `workspace-write`). Check that sandboxed `ix` commands can still reach the loopback endpoint, and use the same args in both arms. Unsupported CLI flags fail the run. Config placeholders must be replaced; they are not model/version defaults.

## Supplied arm provisioning

Both arms receive fresh homes and Git/XDG/agent configuration directories. The runner constructs a private executable PATH for **all stages**, excluding ambient `ix` launchers. `environment.tool_paths` optionally pins the tool directories to copy into that PATH. Inherited Ix routing and parent sessions are removed. Other environment variables are inherited but never serialized. PATH isolation prevents ordinary direct Ix invocation; it is not an OS access boundary.

The baseline has no Ix launcher, skills, MCP registration or hooks. The Ix arm gets an explicit launcher for the configured built CLI, the revision-pinned tracked `skills/ix` files, and the benchmark's local integration:

- Claude Code: a local plugin loaded with `--plugin-dir`, containing the skill, Ix MCP registration and a PostToolUse hook for edits and Bash. The hook refreshes the map and runs `ix hook claude-post-edit` for dependent context. The product relies on editor plugins to re-ingest edits on a debounce. The benchmark has no editor plugin, so it refreshes synchronously, and `ix map` skips repositories that have not changed since the last map. The hook's Claude timeout outlasts both ix deadlines. Hook time is part of `wall_seconds` and is also reported separately as `hook_seconds`.
- Codex: the project `.agents/skills/ix` skill, an isolated `mcp_servers.ix-memory` configuration and a native `notify` hook that refreshes the map after `agent-turn-complete`. Its integration receipt records these settings. Hook timing differs across agent families; compare arms within one family.

The general installer registry (`ix-cli/scripts/skill-harnesses.mjs:60`) uses home-scoped Codex skills; this benchmark currently uses project skills. Aligning these locations is pending owner review because a credential-path guard rejected the proposed edit. Confirm project-skill discovery in the pinned native CLI before using real Codex results.

These are supplied benchmark integrations built from this repository, rather than installations from a marketplace or separate plugin repository. Preserve the harness checkout as well as the Ix source pin. Put real-run output outside project ancestry containing agent instructions/configuration (including this Ix checkout); the provisioner rejects those ancestors and names the offending path. Home directories count too: a home holding `~/.claude`, `~/.codex` or `~/.agents` rejects every output directory beneath it, so use a location outside your home (for example a dedicated data volume). The provisioner also rejects ambient task `AGENTS.md`, `CLAUDE.md`, `.claude`, `.codex` and `.mcp.json` configurations rather than editing task files. Choose compatible tasks or deliberately implement and document a custom isolation policy.

The probe verifies native CLI versions, pinned skill/config content, HEAD, executable availability and an exercised hook. It queries live `ix status` and `ix stats`; stale, incomplete, empty or unhealthy maps invalidate the run. Ix runs that produce nonempty patches must also have hook execution receipts. Version-specific native activation is still a real-run check: unit fixtures do not prove a particular installed CLI supports its plugin/notify flags.

Every stage receives one final absolute request-file argument. Custom setup/probe/agent/evaluator adapters remain possible through argv-array configs. Probe receipts contain version, repo/base/agent identity, `ix_available`, `mapped`, `plugin_installed`, `skills_installed`, `hooks_enabled`, and, for Ix, `mapped_commit`, `plugin_revision` and SHA-256 file evidence. The runner validates these fields and requires evidence inside the run directory. Evaluation receipts must agree with the official task report, whose saved bytes are hashed. Empty patches require the official harness's empty-patch evidence.

## Measurements and interpretation

Artifacts include `harness.json` (script hashes), `manifest.json`, `config.json`, `schedule.json`, per-stage logs, binary solution patches, official report evidence, `runs.jsonl`, `report.json` and `summary.md`. Patches compare against the task's pinned base, including agent commits and newly created files; integration files are excluded. Runs are sequential, with seed-randomized task/arm order and two repeats by default.

Native JSONL and normalized adapter telemetry record input/output/cached tokens, turns, tool calls, search counts, Ix calls and Ix errors by code. Claude input includes cache reads and cache creation; cached tokens are the cache-read subset. Codex usage sums completed turns. Message/tool ids are deduplicated. Missing usage or terminal events invalidate a normally completed transcript. Budget deadlines may leave partial transcripts: observed tool/turn counters are retained, missing total token usage is `null`, and partial usage is saved separately as `observed_usage`. A final interrupted JSONL write is discarded only for a budget-limited agent stage. Search/Ix shell counts cover direct commands and `sh`/`bash`/`zsh -c` wrappers with quote-aware tokenization. Dynamic expansions, aliases and commands hidden inside scripts require normalized tool telemetry; counts are observed invocations, not a full shell execution trace. Hook Ix calls/errors are recorded separately and added to run totals, excluding setup/probe calls.

The common budget sets agent wall time and post-run turn/token ceilings; budget exhaustion records a run outcome and continues the remaining schedule. Agent deadlines terminate the process group, preserve logs and the current patch, and still evaluate that patch. Native Claude `error_max_turns` receipts are retained even when the CLI exits nonzero. Ordinary crashes and invalid setup/probe/evaluation stages remain fatal. The official harness writes no task report when a patch fails to apply or its tests time out. It lists those instances in the run summary's `error_ids`, and so does the scorer. When `run_instance.log` names either cause, the run is scored unresolved (`report_kind: error-summary`, `evaluation_error`). Any other evaluator error, such as an image build or Docker failure, stays fatal. Claude also receives `--max-turns`. Codex receives no native turn limit, and its `turns` metric counts `codex exec` turns (normally one per run), not model requests; for Codex, `max_turns` and `turn_budget` are effectively inert, so rely on the time and token ceilings and do not compare `turns` across agent families. Turn/token ceilings are checked against observed usage after execution. The token ceiling counts uncached input plus output: cache reads are excluded, because a long session re-reads its cached context every turn; overshoots are conservatively `resolved: 0` because the final patch may include work beyond the declared limit. The official test verdict is retained as `official_resolved`. Time-limited or native turn-limited patches produced within the ceiling retain their official verdict. Each result has a `termination` reason (`completed`, `time_budget`, `turn_budget`, or `token_budget`). These are resource ceilings, not guaranteed billing caps. No retries occur. There is no resume: a fatal run error stops the experiment without `report.json`/`summary.md`; completed runs remain in `runs.jsonl` and the failing run's `failure.json`, and a rerun needs a fresh output directory. Clone, checkout, setup and probe each have an `environment.seconds` deadline; Git checks/patch extraction add bounded 10-second stages. Evaluation has its own deadline, including Docker image builds. Only agent-stage deadlines are retained as outcomes; setup, mapping and evaluation deadlines still fail the experiment. POSIX process groups are terminated at deadlines and reaped after stage completion. Windows isolation is not supported.

Reports include per-arm means/medians, mean and median differences with **paired task-cluster percentile bootstrap 90% CIs** (10,000 samples in the real config), and per-task descriptive rows for every metric. Repeats stay together when resampling tasks. Missing arms, unequal repeats and duplicate runs are errors. Resolution is a fraction; differences are Ix minus baseline. All scheduled runs remain in the resolution denominator, including budget-limited runs. For metrics with missing totals, per-arm summaries and CIs use only complete paired tasks; reports show paired-task coverage and observed-run counts. If no paired usage is available, usage estimates/CIs are explicitly unavailable. This conditional usage comparison may be biased by missingness and is not evidence of a cost advantage among timed-out tasks. `wall_seconds` is agent execution time, including synchronous hooks; setup/evaluation/total times are also recorded. Small sets can have degenerate intervals and cannot establish effectiveness. Real-task resolve rates remain unverified until a real run completes.

Reproduce from the same saved manifest/export, config, tool versions, Ix/harness commits, backend/image digests and agent model. Remote aliases can drift. CIs quantify task sampling uncertainty, not model drift, environment bias or billing prices. Review logs before publication. Local input data and results are gitignored.
