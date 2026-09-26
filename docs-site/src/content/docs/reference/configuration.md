---
title: Configuration
description: The config file, environment variables, directories and ports Ix uses.
---

## Config file

The CLI stores its configuration in `~/.ix/config.yaml`. Read and write it with `ix config`:

```bash
ix config show                # everything
ix config get endpoint        # one value
ix config set format llm      # set a value
```

## Environment variables

| Variable | Effect |
|---|---|
| `IX_HOME` | Relocates everything under `~/.ix`, configuration included. Useful for giving a CI job or a second install its own state. It's read at use, not at install, so move `~/.ix` there rather than expecting the old configuration to be found |
| `IX_FORMAT` | Default output format: `text`, `json` or `llm`. Overrides the config file. `--format` overrides it |
| `IX_DEBUG=1` | Prints full stack traces on errors |
| `IX_MCP_SUBPROCESS=1` | Runs each MCP tool call in its own `ix` process |
| `IX_COMMIT_FAILURE_LIMIT=<n>` | Consecutive failed commits before `ix map` stops (default 5). `0` never stops |

### Bootstrap script variables

These apply to the agent skill's `bootstrap.sh`:

| Variable | Skips |
|---|---|
| `IX_SKIP_INSTALL=1` | Installing the CLI |
| `IX_SKIP_BACKEND=1` | Starting and waiting for the backend |
| `IX_SKIP_MAP=1` | Running `ix map` |
| `IX_SKIP_COMPASS=1` | Restoring Compass with `ix upgrade` |

## Directories

| Path | Contents |
|---|---|
| `~/.ix/config.yaml` | CLI configuration |
| `~/.ix/backend/` | Docker Compose file for the local backend |
| `~/.ix/cli/` | The installed CLI |
| `~/.ix/cli/compass/` | Compass assets, fetched by `ix upgrade` |

## Ports

All services bind to `127.0.0.1` only.

| Port | Service |
|---|---|
| `8090` | Ix Memory Layer (the HTTP API) |
| `8529` | ArangoDB |
| `8080` | Compass (`ix view`), configurable with `--port` |
