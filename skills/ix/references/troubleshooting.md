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

## Environment flags

- `IX_DEBUG=1` — full stack traces on any error.
- `IX_SKIP_INSTALL=1` — skip the CLI install step in bootstrap.
- `IX_SKIP_BACKEND=1` — skip starting/waiting for the backend in bootstrap.
- `IX_SKIP_MAP=1` — skip `ix map` in bootstrap.

## Re-mapping

The graph persists between sessions but goes stale as code changes. Re-run
`ix map --silent` from the repo root after every meaningful code change so
answers stay current.
