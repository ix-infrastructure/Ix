# Troubleshooting & Prerequisites

## Prerequisites

- **Node.js >= 22** — required by the `ix` CLI.
- **git** — used for workspace detection.
- **Docker + Docker Compose** — runs the local backend (ArangoDB on
  127.0.0.1:8529 and the Ix Memory Layer on 127.0.0.1:8090). Docker Desktop
  must be running on macOS/Windows.
- **ripgrep** — powers `ix text`; optional but recommended (non-fatal if
  missing).

The bootstrap script (`scripts/bootstrap.sh` / `bootstrap.ps1`) checks and
installs these, then installs the `ix` CLI if missing.

## Backend not reachable

Most first-run problems are the backend not being up yet. Diagnose in order:

```bash
ix status          # is the backend reachable?
ix docker start    # start the backend (ArangoDB + memory layer)
ix doctor          # check system health — server, database, graph integrity
```

If a command reports `Ix backend not reachable`, run `ix docker start` and try
again.

## Common failure modes

| Symptom | Fix |
|---|---|
| `Ix backend not reachable` | `ix docker start`, wait, then `ix doctor` |
| Docker daemon not running | Start Docker Desktop / the Docker service, then re-run bootstrap |
| `ix: command not found` | Re-run bootstrap (installs the CLI), or restart the shell so PATH picks up the wrapper |
| `The '<name>' command requires Ix Pro.` | Not installed — skip the step, do not retry or mention it again this session |
| `ix text` errors | Install ripgrep (brew/apt/dnf/choco) |
| `Compass UI not found` on `ix view` | Run `ix upgrade` to fetch Compass. Re-running the installer wipes the Compass assets, so bootstrap auto-restores them with `ix upgrade`; skip with `IX_SKIP_COMPASS=1` |
| Compass shows "Compass not connected to a codebase" | The scoped workspace has no graph — run `ix map .` from the repo root, then reload the tab |
| Slow or stale results | Re-run `ix map --silent` to refresh the graph |
| `Commits against <endpoint> kept failing` | Commits kept failing, so `ix map` gave up rather than sending one doomed request per file. Read the `Last error` line it prints — the CLI cannot tell the two causes apart, because the memory layer answers 500 for both. **A saturated database:** `ix doctor` still passes (it asks whether the backend is reachable and the graph consistent, and an ArangoDB too busy to begin a transaction is both), so check `docker stats` and `GET /_db/<db>/_api/query/current`, then re-map once it is idle. **Patches the backend will not accept:** the error names the patch or the field; re-map after fixing it, or `IX_COMMIT_FAILURE_LIMIT=0` to send the rest regardless. |

## Environment flags

- `IX_DEBUG=1` — full stack traces on any error.
- `IX_SKIP_INSTALL=1` — skip the CLI install step in bootstrap.
- `IX_SKIP_BACKEND=1` — skip starting/waiting for the backend in bootstrap.
- `IX_SKIP_MAP=1` — skip `ix map` in bootstrap.
- `IX_COMMIT_FAILURE_LIMIT=N` — consecutive failed commits before `ix map`
  stops sending more (default 5). `0` sends every patch regardless, which is
  the pre-#560 behaviour.

## Harness presence (hermetic reproduction)

The skill installer reads the explicit harness table in
`ix-cli/scripts/skill-harnesses.mjs` (claude, agents, codex, cursor — each
entry's skills directory verified against what that harness actually reads;
`ix mcp install` uses the separate MCP host registry in
`ix-cli/src/mcp/hosts.ts`). The helper's `--probe` emits one row per harness
with a `1`/`0` presence field and the detection source. When `TOOLSCAN_PATH`
is set, its discovery output is consumed as additive evidence for binaries
installed outside `PATH`; otherwise the embedded `PATH` and config-directory
probes decide.

Use these environment variables to reproduce the decision without using the
real user configuration:

| Variable | Scope | Purpose | Default |
|---|---|---|---|
| `TOOLSCAN_PATH` | helper and `ix mcp install` | An executable, script, or `dist/toolscan.mjs` to query. Opt-in only — the CLI never looks `toolscan` up on `PATH`, and it executes whatever this names, so point it only at a binary you trust. | Unset — no toolscan; embedded probes decide. |
| `HARNESS_HOME` | `skill-harnesses.mjs --probe` | Replaces Node's home directory when expanding `~` for config-directory presence checks. | `os.homedir()` |

A no-write local probe is:

```bash
HARNESS_HOME="$(mktemp -d)" \
  node ix-cli/scripts/skill-harnesses.mjs --probe
```

To include a local checkout or an npm-installed toolscan bundle:

```bash
TOOLSCAN_PATH=/path/to/toolscan/dist/toolscan.mjs \
  HARNESS_HOME="$(mktemp -d)" \
  node ix-cli/scripts/skill-harnesses.mjs --probe
```

To exercise the CLI surface against a fixture, restrict it with `--host` (an
unknown id fails loudly, so a renamed host cannot pass silently):

```bash
HOME="$(mktemp -d)" \
TOOLSCAN_PATH=/path/to/toolscan/dist/toolscan.mjs \
node ix-cli/dist/cli/main.js mcp install --host claude codex openclaw --dry-run --format json
```

The CI smoke job repeats this in a clean `node:22-bookworm` container with a
fake `toolscan` result naming only `claude`. The fake `claude` is installed at
`$HOME/.local/bin` — off PATH — so the job proves both directions of the seam:
presence decided by toolscan, and the off-PATH CLI invoked through the absolute
path toolscan reported. It asserts `claude` is present and `codex`/`agents`/
`cursor` are absent through the shell installer, and `claude` registers
(not a false conflict) plus `codex`/`openclaw` absent through `ix mcp install`;
the fake command and temporary home prevent host-machine state from making the
check pass accidentally.

## Re-mapping

The graph persists between sessions but goes stale as code changes. Re-run
`ix map --silent` from the repo root after every meaningful code change so
answers stay current.
