<!-- IX-MEMORY START -->
# Ix Memory System

This project uses Ix Memory — persistent, time-aware context for LLM assistants.

## Interface

Use the `ix` CLI exclusively. All commands support `--format json` for machine-readable output.

Use JSON when chaining command results.

## MANDATORY RULES
1. BEFORE answering codebase questions → use targeted `ix` CLI commands (see routing below). Do NOT answer from training data alone.
2. AFTER every design or architecture decision → run `ix decide <title> --rationale <text>`.
3. When you notice contradictory information → run `ix conflicts` and present results to the user.
4. NEVER guess about codebase facts — if Ix has structured data, use it.
5. IMMEDIATELY after modifying code → run `ix map` to re-ingest and update the graph.
6. When the user states a goal → run `ix truth add "<statement>"`.

## Ix CLI Command Routing

Use bounded, composable CLI commands — never broad queries.

### High-Level Workflow Commands (Preferred)

Start here. These aggregate multiple graph operations into single bounded responses.

| Goal | Command | Example |
|---|---|---|
| Blast radius / impact | `ix impact` | `ix impact UserService --format json` |
| Hotspot discovery | `ix rank` | `ix rank --by dependents --kind class --top 10` |
| One-shot summary | `ix overview` | `ix overview IngestionService --format json` |
| Scoped entity listing | `ix inventory` | `ix inventory --kind function --path auth.py` |
| Plan work | `ix plan` | `ix plan task "title" --plan <id> --resolves <bugId> --workflow-staged '{"discover":["cmd"]}' --format json` |
| Track decisions | `ix decide` | `ix decide "Use X" --rationale "..." --affects Entity --responds-to <bugId>` |
| Create goals | `ix goal` | `ix goal create "Support GitHub" --format json` |
| Session resume | `ix briefing` | `ix briefing --format json` |
| Track bugs | `ix bug` | `ix bug create "title" --affects Entity` |

### Low-Level Primitives

Underlying structural commands — useful for debugging or fine-grained inspection.

#### Finding & Understanding Code
| Goal | Command | Example |
|---|---|---|
| Find entity by name | `ix search` | `ix search IngestionService --kind class --limit 10` |
| Understand a symbol | `ix explain` | `ix explain IngestionService` |
| Read source code | `ix read` | `ix read src/auth.py:10-50` or `ix read verify_token` |
| Full entity details | `ix entity` | `ix entity <id> --format json` |
| Fast text search | `ix text` | `ix text "verify_token" --language python --limit 20` |
| Find symbol (graph+text) | `ix locate` | `ix locate AuthProvider --kind class` |

#### Navigating Relationships
| Goal | Command | Example |
|---|---|---|
| What calls a function | `ix callers` | `ix callers verify_token --format json` |
| What a function calls | `ix callees` | `ix callees processPayment` |
| Members of a class | `ix contains` | `ix contains IngestionService` |
| What an entity imports | `ix imports` | `ix imports auth_provider.py` |
| What imports an entity | `ix imported-by` | `ix imported-by AuthProvider` |
| Dependency impact | `ix depends` | `ix depends verify_token --depth 2` |

### History & Decisions
| Goal | Command | Example |
|---|---|---|
| Design decisions | `ix decisions` | `ix decisions --topic ingestion --limit 10` |
| Entity history | `ix history` | `ix history <entityId>` |
| Changes between revisions | `ix diff` | `ix diff 1 5 --summary --format json` |
| Detect contradictions | `ix conflicts` | `ix conflicts --format json` |
| Record a decision | `ix decide` | `ix decide "Use CONTAINS" --rationale "Normalize edges" --responds-to <bugId>` |
| Record a goal | `ix truth add` | `ix truth add "Support 100k file repos"` |
| List goals | `ix truth list` | `ix truth list --format json` |
| Bug tracking | `ix bug create` | `ix bug create "title" --severity high --affects Entity` |
| Update bug status | `ix bug update` | `ix bug update <id> --status resolved` |
| Bug listing | `ix bugs` | `ix bugs --status open --format json` |
| Bug details | `ix bug show` | `ix bug show <id> --format json` |
| List recent patches | `ix patches` | `ix patches --limit 20 --format json` |

### Planning (Pro)
| Goal | Command | Example |
|---|---|---|
| Create a goal | `ix goal create` | `ix goal create "Support GitHub" --format json` |
| List goals | `ix goals` | `ix goals --status active --format json` |
| Create a plan | `ix plan create` | `ix plan create "Fix auth" --goal <id> --responds-to <bugId> --format json` |
| Add a task | `ix plan task` | `ix plan task "Step 1" --plan <id> --depends-on <taskId> --resolves <bugId> --workflow-staged '{"discover":["ix overview X"],"implement":["ix map"],"validate":["ix smells"]}' --format json` |
| Plan status | `ix plan status` | `ix plan status <id> --format json` |
| Next actionable task | `ix plan next` | `ix plan next <id> --with-workflow --format json` |
| Run next task workflow | `ix plan next` | `ix plan next <id> --run-workflow --stage discover --format json` |
| List all plans | `ix plans` | `ix plans --format json` |
| List tasks | `ix tasks` | `ix tasks --status pending --plan <id> --format json` |
| Task details | `ix task show` | `ix task show <id> --with-workflow --format json` |
| Update task | `ix task update` | `ix task update <id> --status done --format json` |
| Run task workflow stage | `ix task update` | `ix task update <id> --run-workflow discover --format json` |

### Workflows (Pro)
Workflows are staged command sequences (discover → implement → validate) attached to tasks, plans, or decisions. All commands must start with `ix ` — no shell operators.

| Goal | Command | Example |
|---|---|---|
| Attach workflow | `ix workflow attach` | `ix workflow attach task <id> --file workflow.json` |
| Show workflow | `ix workflow show` | `ix workflow show task <id> --format json` |
| Validate workflow | `ix workflow validate` | `ix workflow validate task <id>` |
| Run workflow | `ix workflow run` | `ix workflow run task <id> --stage implement --format json` |

**Workflow JSON format:**
```json
{
  "discover":   ["ix overview AuthService", "ix impact AuthService"],
  "implement":  ["ix map"],
  "validate":   ["ix smells --format json", "ix subsystems --format json"]
}
```

### Architecture Analysis
| Goal | Command | Example |
|---|---|---|
| Detect code smells | `ix smells` | `ix smells --format json` |
| Score subsystems | `ix subsystems` | `ix subsystems --level 2 --format json` |
| List smell claims | `ix smells --list` | `ix smells --list --format json` |
| List subsystem scores | `ix subsystems --list` | `ix subsystems --list --format json` |

### Ingestion & Health
| Goal | Command | Example |
|---|---|---|
| Update graph + map | `ix map` | `ix map` |
| Ingest GitHub data | `ix ingest` | `ix ingest --github owner/repo --limit 50` |
| Backend health | `ix status` | `ix status` |
| Graph statistics | `ix stats` | `ix stats --format json` |

### Decomposition Examples

**"How does ingestion work?"**
```bash
ix overview IngestionService --format json    # start here
# If you need more detail:
ix contains IngestionService --format json
ix callees parseFile --format json
```

**"What depends on verify_token?"**
```bash
ix impact verify_token --format json          # one-shot answer
# or manually:
ix callers verify_token --format json
ix imported-by verify_token --format json
```

**"What are the most important classes?"**
```bash
ix rank --by dependents --kind class --top 10 --format json
```

**"List all functions"**
```bash
ix inventory --kind function --format json
```

### Best Practices
- Always use `--kind` with `ix search` to get bounded results
- Use `ix inventory` instead of `ix search ""` for listing entities by kind
- Use `ix diff --summary` for broad revision comparisons (server-side, fast)
- Use `--full` only when you need every individual change
- Always use `--limit` to cap result sets
- Use `--format json` when chaining results between commands
- Use `--path` or `--language` to restrict text searches
- Use exact entity IDs from previous JSON results
- Decompose large questions into multiple targeted calls

## Semantic Boundaries

Use the right entity type for the right purpose:

- **decision** — a choice between alternatives, with rationale. Use `ix decide`.
- **bug** — something broken, missing, or incorrect. Use `ix bug create`.
- **task/plan** — intended work and sequencing. Use `ix plan` / `ix plan task`.

## Do NOT Use
- `ix query` — deprecated, produces oversized low-signal responses
- NLP-style QA in a single command

## Confidence Scores
Ix returns confidence scores with results. When data has low confidence:
- Mention the uncertainty to the user
- Suggest re-running `ix map` to refresh the graph
- Never present low-confidence data as established fact
<!-- IX-MEMORY END -->
