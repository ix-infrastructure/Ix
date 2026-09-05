# Ix Command Reference

Use bounded, composable CLI commands — never broad queries. Run every command
with the `ix` prefix from the repo root of the mapped workspace.

This file routes a goal to a command. For the complete flag surface of any
command — every option, its accepted values and its default — see
[flags.md](flags.md).

## High-Level Workflow Commands (prefer first)

These aggregate multiple graph operations into single bounded responses.

| Goal | Command | Example |
|---|---|---|
| Blast radius / impact | `ix impact` | `ix impact UserService --format llm` |
| Hotspot discovery | `ix rank` | `ix rank --by dependents --kind class --top 10 --format llm` |
| One-shot summary | `ix overview` | `ix overview IngestionService --format llm` |
| Deterministic context bundle | `ix context` | `ix context IngestionService --format llm` |
| Scoped entity listing | `ix inventory` | `ix inventory --kind function --path auth.py --format llm` |

## Finding & Understanding Code

| Goal | Command | Example |
|---|---|---|
| Find entity by name | `ix search` | `ix search IngestionService --kind class --limit 10` |
| Understand a symbol | `ix explain` | `ix explain IngestionService` |
| Read source code | `ix read` | `ix read src/auth.py:10-50` or `ix read verify_token` |
| Full entity details | `ix entity` | `ix entity <id> --format json` |
| Fast text search | `ix text` | `ix text "verify_token" --language python --limit 20` |
| Find symbol (graph+text) | `ix locate` | `ix locate AuthProvider --kind class` |

## Navigating Relationships

| Goal | Command | Example |
|---|---|---|
| What calls a function | `ix callers` | `ix callers verify_token --format json` |
| What a function calls | `ix callees` | `ix callees processPayment` |
| Members of a class | `ix contains` | `ix contains IngestionService` |
| What an entity imports | `ix imports` | `ix imports auth_provider.py` |
| What imports an entity | `ix imported-by` | `ix imported-by AuthProvider` |
| Dependency impact | `ix depends` | `ix depends verify_token --depth 2` |

## History, Diffs & Contradictions

| Goal | Command | Example |
|---|---|---|
| Entity history | `ix history` | `ix history <entityId> --format llm` |
| Changes between revisions | `ix diff` | `ix diff 1 5 --summary --format llm` |
| Detect contradictions | `ix conflicts` | `ix conflicts --format llm` |

## Architecture Analysis

| Goal | Command | Example |
|---|---|---|
| Detect code smells | `ix smells` | `ix smells --format json` |
| Score subsystems | `ix subsystems` | `ix subsystems --level 2 --format json` |
| List smell claims | `ix smells --list` | `ix smells --list --format json` |
| List subsystem scores | `ix subsystems --list` | `ix subsystems --list --format json` |

## Ingestion & Health

| Goal | Command | Example |
|---|---|---|
| Update graph + map | `ix map --silent` | `ix map --silent` |
| Ingest GitHub data | `ix ingest` | `ix ingest --github owner/repo --limit 50` |
| Backend health | `ix status` | `ix status` |
| System doctor | `ix doctor` | `ix doctor` |
| Start backend | `ix docker start` | `ix docker start` |
| Graph statistics | `ix stats` | `ix stats --format json` |

## Session Metrics

| Goal | Command | Example |
|---|---|---|
| Token savings so far | `ix savings` | `ix savings --format llm` |
| Per-command breakdown | `ix savings --detail` | `ix savings --detail --format llm` |
| Clear lifetime totals | `ix savings reset` | `ix savings reset` |

`ix savings` reports how many tokens the graph saved against a naive
read-the-files baseline, in two scopes. Neither is per-terminal: the CLI sends a
bare `GET /v1/savings` with no session id, so the backend has nothing to
attribute a count to one shell with. `session` is an in-memory counter the
backend process has accumulated since it started, **shared by every client that
talks to it**; `lifetime` is the persisted total. So a fresh shell against a
backend that has been up all day reads that day's traffic from every other
shell as its "session". Each scope carries the command count, `tokens_saved`,
the `naive_tokens` / `actual_tokens` it was derived from, and money and water
estimates.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--detail` | — | off | Add one record per command type, within each scope |
| `--model <model>` | `opus\|sonnet\|haiku\|gpt-4o` | `opus` | Pricing table for `money_saved` only — token and water figures do not change |
| `--format <fmt>` | `text\|json\|llm` | `text` | See output-formats.md |

`ix savings reset` clears **both** scopes (`DELETE /v1/savings`, which runs
`session.set(empty) *> store.resetSavings`). It takes no flags, does not prompt,
and cannot be undone — there is no way to zero one scope and keep the other,
despite the CLI's own "Reset lifetime savings totals" description.

`--format llm` emits one `savings` header record and one `scope` record per
scope; `--detail` adds `command` records that name their scope:

```
savings model="Claude Opus ($15/MTok in, $75/MTok out)"
scope name=session commands=726 tokens_saved=832739 naive_tokens=1099164 actual_tokens=266425 money_saved=27.48 water_saved_ml=1665.478
command scope=session name=callers count=329 tokens_saved=334995
command scope=session name=entity count=308 tokens_saved=423741
scope name=lifetime commands=4820 tokens_saved=6142880 naive_tokens=8003104 actual_tokens=1860224 money_saved=202.72 water_saved_ml=12285.76
command scope=lifetime name=callers count=2104 tokens_saved=2210488
```

`command` records are emitted inside the scope loop, so each scope's breakdown
follows its own `scope` record rather than being grouped at the end. (Truncated
above: a real run emits one `command` record per entry in each breakdown.)

Reading a graph command's savings needs the backend up: the numbers come from
`GET /v1/savings`, not from a local file.

## Decomposition Recipes

**"How does ingestion work?"**
```bash
ix overview IngestionService --format json    # start here
ix contains IngestionService --format json    # more detail if needed
ix callees parseFile --format json
```

**"What depends on verify_token?"**
```bash
ix impact verify_token --format json          # one-shot answer
ix callers verify_token --format json         # or manually
ix imported-by verify_token --format json
```

**"What are the most important classes?"**
```bash
ix rank --by dependents --kind class --top 10 --format json
```

**"List all functions in a file"**
```bash
ix inventory --kind function --path auth.py --format llm
```

## Best Practices

- Always use `--kind` with `ix search` to get bounded results.
- Use `ix inventory` instead of `ix search ""` for listing entities by kind.
- Use `ix diff --summary` for broad revision comparisons; `--full` only when
  every individual change is needed.
- Always use `--limit` to cap result sets. Not on `ix diff --summary` or
  `ix diff --full`, though: each already fixes the volume, so `--limit`
  alongside either is refused rather than silently ignored.
- Use `--path` or `--language` to restrict text searches.
- Reuse exact entity IDs from previous JSON results when chaining commands.
- Decompose large questions into multiple targeted calls.

## Gotchas (surprises that already bit us)

- **`ix reset` is GLOBAL, not workspace-scoped.** `ix reset` → `POST
  /v1/reset`, and `ix reset --code` → `POST /v1/reset/code`; neither sends a
  workspace_id, so both wipe EVERY workspace's graph in the shared backend —
  the cwd only decides which mtime cache gets cleared. Running
  `ix reset -y --code` in one repo also destroys the graphs of every other
  mapped workspace (e.g. packwise) and empties the `--all` combined view;
  re-run `ix map` per workspace to rebuild. A workspace-scoped endpoint
  (`/v1/reset/workspace`, via `deleteWorkspace`) exists server-side, but the
  CLI does not expose it.

- **The OSS↔Pro command boundary is derived at runtime, not declared.**
  `main.ts` snapshots `ossCmdNames` immediately after `registerOssCommands()`;
  the Pro probe (`tryLoadProCommands`) then diffs whatever commands exist
  against that set to decide which count as "Pro". Consequences:
  - Adding a `register*Command` call in `oss.ts` silently reclassifies that
    command as OSS — it vanishes from the Pro help diff.
  - Removing one from `oss.ts` makes Pro own it, or — without the license — a
    Pro stub replaces it (stubs skip any name already registered, so an OSS
    command left in place blocks its stub).
  - `registerProCommands` is async (each Pro command is dynamically imported)
    and MUST be awaited; skipping the await makes every `ix <pro-cmd>` fail
    with "unknown command".
  - Real example: `registerPatchesCommand` was defined but never called in
    `oss.ts`, so a `patches` entry in `PRO_COMMANDS` shadowed it and `ix
    patches` answered "requires Ix Pro" (#371). #390 wired the call in and
    dropped the stub, so `ix patches` is an OSS command today.

## Do NOT Use

- `ix query` — deprecated, produces oversized low-signal responses.
- NLP-style free-text QA in a single command — decompose into targeted calls.
