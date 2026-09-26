---
title: Visualize with Compass
description: Explore your codebase's graph in the browser with ix view.
---

Compass is Ix's visualizer. It renders the graph of the current workspace in your browser.

```bash
ix view
```

This starts Compass on port 8080 and opens it. Try the [live demo](https://ix-infra.com/demo/) to see it without
installing anything.

## Commands

| Command | Effect |
|---|---|
| `ix view` / `ix view start` | Start Compass and open the browser |
| `ix view start --no-open` | Start without opening a browser |
| `ix view start --all` | Show every mapped workspace together |
| `ix view --port 9000` | Serve on a different port |
| `ix view status` | Is Compass running? |
| `ix view stop` | Stop it |

## How it connects

Compass serves its web app and proxies every `/v1/*` request to the local backend on port 8090. It stamps each
request with the workspace it was launched from, which is how it scopes the view to one repository. See
[Visualizer proxy](/api/overview/#visualizer-proxy) in the API overview.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Compass UI not found` | Run `ix upgrade` to fetch Compass. Re-running the installer removes the Compass assets |
| "Compass not connected to a codebase" | This workspace has no graph yet. Run `ix map .` from the repo root, then reload the tab |
