---
name: ix
description: "This skill should be used when answering structural questions about a codebase: understanding what a symbol is, tracing flows, measuring change impact, finding callers/callees/imports, or detecting code smells. It drives the Ix CLI (ix map/explain/trace/impact/search/rank/smells) against a persistent code graph stored in a local backend, instead of grepping or guessing. Run scripts/bootstrap.sh once to install the CLI and start the backend, then ix map on the repo root."
license: Apache-2.0
metadata:
  version: 1.0.0
  source: https://github.com/ix-infrastructure/Ix
---

# Ix — Persistent Codebase Map

## Overview

Ix parses a repository with tree-sitter (26 languages), builds a graph of its symbols, calls, and imports, and stores it in a local backend (ArangoDB via Docker). Query that graph with `ix` commands to answer bounded, structural questions instead of reading files blindly. The graph persists between sessions.

Use this skill whenever the question is about structure, relationships, or impact: what a symbol is, what calls it, what it calls, how data flows, what breaks if a change lands, which files are most depended-on, or where the smells are.

## When to Use

- Answering "what is this / what does it touch" questions about a symbol, class, or module.
- Tracing how a flow moves through the system.
- Estimating blast radius before a change.
- Finding callers, callees, imports, and dependents.
- Detecting smells, ranking hotspots, and scoring subsystems.
- Onboarding to an unfamiliar codebase.

Do not use this skill for prose-style or history questions — use it for structural, graph-backed answers.

## Quick Start (first run)

Map the target repo with the bootstrap script:

```bash
bash scripts/bootstrap.sh [repo-root] [--no-map]                                            # Bash / Git Bash / macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 [repo-root] [-NoMap]         # Windows PowerShell
```

The bootstrap checks Node >= 22, git, Docker, and ripgrep; installs the `ix` CLI if missing; starts the local Docker backend; and maps the repo by default. Re-run `scripts/bootstrap.sh` on each new repo to register and map it.

Refresh the graph after code changes:

```bash
ix map --silent
```

## Core Workflow

Map → Explain → Trace → Impact

| Step | Command | Example |
|---|---|---|
| Build/refresh the graph | `ix map` | `ix map .` |
| Understand a component | `ix explain` | `ix explain IngestionService` |
| Bounded deterministic context | `ix context` | `ix context IngestionService --max-entities 20` |
| Trace a flow | `ix trace` | `ix trace user_login_flow` |
| Analyze impact | `ix impact` | `ix impact verify_token --format llm` |

## Using the Skill

1. Start with high-level commands for one-shot answers: `ix overview`, `ix impact`, `ix rank`.
2. Drill down with primitives — `ix search`, `ix callers`, `ix callees`, `ix contains`, `ix imports`, `ix imported-by`, `ix depends` — reusing exact entity IDs from prior JSON output.
3. Prefer `--format llm` when reading output yourself (token-minimal); use `--format json` when chaining commands or extracting a field. See references/output-formats.md.
4. For the full command surface, decomposition recipes, and best practices, load references/commands.md; for a command's complete flag list, load references/flags.md.
5. If the backend is unreachable or a command fails, load references/troubleshooting.md.

## Rules

1. Before answering codebase questions, run targeted `ix` commands. Do not answer from training data alone.
2. After noticing contradictory information, run `ix conflicts` and present the results.
3. Never guess codebase facts — if Ix has structured data, use it.
4. Immediately after modifying code, run `ix map --silent` to re-ingest.
5. When Ix reports low confidence, mention the uncertainty to the user, suggest re-running `ix map`, and never present low-confidence data as established fact.

## Harness install seam

The skill installer (`scripts/install-skill.sh`) reads an explicit, small harness table from `ix-cli/scripts/skill-harnesses.mjs` — claude, agents, codex and cursor only. Each entry's skills directory is verified against what that harness actually reads (Cursor uses `~/.cursor/skills-cursor`, not `~/.cursor/skills`); gemini, opencode, openclaw and vscode have no skills convention, so they are deliberately not install targets. Adding a harness is a one-line edit in that table, after checking where the harness really looks. `ix mcp install` uses the separate MCP host registry (`ix-cli/src/mcp/hosts.ts`) — a different table answering a different question.

When `TOOLSCAN_PATH` is set, both surfaces consult its discovery output so a harness CLI installed outside `PATH` can still be found — and `ix mcp install` executes the absolute path toolscan reports, so the off-PATH harness is inspected and registered through the binary toolscan found. Toolscan is optional and additive: if it is unset or fails, the embedded `PATH` and config-directory probes remain authoritative. `TOOLSCAN_PATH` is opt-in: neither surface ever looks `toolscan` up on `PATH` (the CLI executes whatever `TOOLSCAN_PATH` names, so only set it to a binary you trust).

The probe battery has two environment seams:

| Seam | Used by | Default |
|---|---|---|
| `TOOLSCAN_PATH` | `skill-harnesses.mjs --probe`, `ix mcp install` | Unset — no toolscan, embedded probes decide |
| `HARNESS_HOME` | `skill-harnesses.mjs --probe` | `os.homedir()`; `install-skill.sh` uses the shell's `$HOME` |

For a hermetic probe with no real user configuration:

```bash
HARNESS_HOME="$(mktemp -d)" \
  node ix-cli/scripts/skill-harnesses.mjs --probe
```

To drive the same probe with a local or npm-installed toolscan bundle:

```bash
TOOLSCAN_PATH=/path/to/toolscan/dist/toolscan.mjs \
  HARNESS_HOME="$(mktemp -d)" \
  node ix-cli/scripts/skill-harnesses.mjs --probe
```

`--probe` emits `id|label|bin|config-dir|skill-dir|present|detectedVia`, where `present` is `1` or `0` and `detectedVia` names the probe that decided (`toolscan` | `path` | `config-dir` | `none`). `scripts/install-skill.sh --dry-run --json` emits the same per-harness view as machine-readable JSON: one object per host with `action` (`would-install` | `would-refuse` | `installed` | `refused` | `skip`), `dest`, and `detectedVia` — so CI can assert *how* a harness was found, not just that it was. A `would-refuse` in the preview exits 1, matching the real run's conflict exit, so scripts can rely on the two agreeing.

The install report's `--format json|llm` output carries `detectedVia` per host (`toolscan` | `path` | `config-dir` | `none`), so a consumer can see which probe decided presence — a host toolscan found reads `toolscan` even when its CLI also happens to be on PATH, and a host found by the PATH probe reads `path` rather than being misattributed to its config directory.

## References

- **references/commands.md** — full command routing tables, decomposition recipes, best practices, and the do-not-use list. Load before running any command beyond the core four above.
- **references/flags.md** — every flag the CLI registers, per command, with values and defaults. Load when a command needs shaping beyond the examples in commands.md, or to check whether a flag exists before guessing.
- **references/output-formats.md** — `--format llm|json|text` rules, commands that do not implement `llm`, and Pro-gated commands. Load when formatting output or when a "requires Ix Pro" error appears.
- **references/troubleshooting.md** — prerequisites, backend health checks, `ix doctor`, and environment flags. Load when a command fails or the backend is unreachable.

## Scripts

- **scripts/bootstrap.sh** — cross-platform first-run setup (bash; works on macOS, Linux, and Windows under Git Bash / MSYS2 / WSL).
- **scripts/bootstrap.ps1** — native Windows PowerShell first-run setup.
