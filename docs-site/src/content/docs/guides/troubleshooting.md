---
title: Troubleshooting
description: Diagnose and fix the most common Ix problems.
---

## Start here

Most first-run problems mean the backend isn't up yet. Check it in this order:

```bash
ix status          # is the backend reachable?
ix docker start    # start it (ArangoDB + memory layer)
ix doctor          # server, database and graph integrity
```

Set `IX_DEBUG=1` to see full stack traces on any error.

## Common problems

| Symptom | Fix |
|---|---|
| `Ix backend not reachable` | Run `ix docker start`, wait for it, then `ix doctor` |
| Docker daemon not running | Start Docker Desktop or the Docker service, then retry |
| `ix: command not found` | Restart your shell so `PATH` picks up the wrapper, or re-run the installer |
| `ix text` errors | Install ripgrep (`brew`, `apt`, `dnf` or `choco install ripgrep`) |
| `The '<name>' command requires Ix Pro.` | That command is part of Ix Pro and isn't in the open-source CLI |
| `Compass UI not found` on `ix view` | Run `ix upgrade` to fetch Compass |
| Compass shows "Compass not connected to a codebase" | Run `ix map .` from the repo root, then reload the tab |
| Slow or stale results | Refresh the graph with `ix map --silent` |
| A workspace's graph disappeared | `ix reset` clears every workspace. Re-run `ix map` in each repository |

## `ix map` stops with "Commits against … kept failing"

After several consecutive failed commits, `ix map` stops instead of sending one doomed request per file. Read the
`Last error` line it prints. The backend returns the same error for two different causes:

- **The database is saturated.** `ix doctor` can still pass. Check `docker stats`, wait for ArangoDB to go idle, and
  re-map.
- **The backend rejects a patch.** The error names the patch or field. Fix it and re-map, or set
  `IX_COMMIT_FAILURE_LIMIT=0` to send the remaining patches anyway.

## Docker image pulls fail

Docker Hub limits anonymous pulls to 100 per six hours per IP. Run `docker login` (free) and retry.

## Still stuck?

- Ask in [Discord](https://discord.gg/ncEYVHVqZ8)
- Search or open an [issue on GitHub](https://github.com/ix-infrastructure/Ix/issues). Include the output of
  `ix doctor` and `ix --version`
