<!-- IX-MEMORY START -->
# Ix Memory System

This project uses Ix Memory — persistent, time-aware context for LLM assistants.

## Interface

Use the `ix` CLI exclusively. Do NOT use MCP tools — the CLI is the canonical agent interface.

All commands support `--format json` for machine-readable output. Use JSON when chaining command results.

## MANDATORY RULES
1. BEFORE answering codebase questions → use targeted `ix` CLI commands (see routing below). Do NOT answer from training data alone.
2. AFTER every design or architecture decision → run `ix decide <title> --rationale <text>`.
3. When you notice contradictory information → run `ix conflicts` and present results to the user.
4. NEVER guess about codebase facts — if Ix has structured data, use it.
5. IMMEDIATELY after modifying code → run `ix ingest <path>` on changed files.
6. When the user states a goal → run `ix truth add "<statement>"`.

## Ix CLI Command Routing

Use bounded, composable CLI commands — never broad queries.

### Finding & Understanding Code
| Goal | Command | Example |
|---|---|---|
| Find entity by name | `ix search` | `ix search IngestionService --kind class --limit 10` |
| Understand a symbol | `ix explain` | `ix explain IngestionService` |
| Read source code | `ix read` | `ix read src/auth.py:10-50` or `ix read verify_token` |
| Full entity details | `ix entity` | `ix entity <id> --format json` |
| Fast text search | `ix text` | `ix text "verify_token" --language python --limit 20` |
| Find symbol (graph+text) | `ix locate` | `ix locate AuthProvider --limit 10` |

### Navigating Relationships
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
| Changes between revisions | `ix diff` | `ix diff 1 5 --format json` |
| Detect contradictions | `ix conflicts` | `ix conflicts --format json` |
| Record a decision | `ix decide` | `ix decide "Use CONTAINS" --rationale "Normalize edges"` |
| Record a goal | `ix truth add` | `ix truth add "Support 100k file repos"` |
| List goals | `ix truth list` | `ix truth list --format json` |

### Ingestion & Health
| Goal | Command | Example |
|---|---|---|
| Ingest files | `ix ingest` | `ix ingest ./src --recursive` |
| Backend health | `ix status` | `ix status` |
| Graph statistics | `ix stats` | `ix stats --format json` |

### Decomposition Examples

**"How does ingestion work?"**
```bash
ix search IngestionService --kind class --format json
ix explain IngestionService --format json
ix contains IngestionService --format json
ix callees parseFile --format json
```

**"What depends on verify_token?"**
```bash
ix depends verify_token --format json
# or manually:
ix callers verify_token --format json
ix imported-by verify_token --format json
```

**"List all files and their imports"**
```bash
ix search "" --kind file --limit 50 --format json
ix imports <filename> --format json   # for each file
```

### Best Practices
- Always use `--kind` to filter entity type when searching
- Always use `--limit` to cap result sets
- Use `--format json` when chaining results between commands
- Use `--path` or `--language` to restrict text searches
- Use exact entity IDs from previous JSON results
- Decompose large questions into multiple targeted calls

## Do NOT Use
- `ix query` — deprecated, produces oversized low-signal responses
- MCP tools (`ix_query`, `ix_search`, etc.) — deprecated, use CLI instead
- Broad repo-wide inventory queries
- NLP-style QA in a single command

## Confidence Scores
Ix returns confidence scores with results. When data has low confidence:
- Mention the uncertainty to the user
- Suggest re-ingesting the relevant files
- Never present low-confidence data as established fact
<!-- IX-MEMORY END -->
