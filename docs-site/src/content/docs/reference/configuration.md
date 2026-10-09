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
| `IX_TOKEN=<token>` | Bearer token sent to a local backend (localhost or another loopback address) on every request. Overrides the stored local token (see [Local token](#local-token)). Never sent to any other endpoint |
| `IX_DEBUG=1` | Prints full stack traces on errors, and one stderr line per backend request with the `X-Correlation-Id` it sent (the backend tags its request and slow-query logs with it). Every request of one `ix` run shares the id's prefix |
| `IX_READ_DEADLINE_MS=<ms>` | How long one command's reads may take in all before it fails (default 60000), so a hung backend fails a query in a minute rather than after each request's 2-minute timeout. The clock restarts after each write the command makes. `ix map`, `ix ingest` and `ix stats` have no read deadline. `0` turns it off. A read that meets a refused or dropped connection, or a 502/503/504, is retried once; writes never are |
| `IX_MCP_SUBPROCESS=1` | Runs each MCP tool call in its own `ix` process |
| `IX_COMMIT_FAILURE_LIMIT=<n>` | Consecutive failed commits before `ix map` stops (default 5). `0` never stops |
| `IX_COMMIT_BASE_REV_RETRIES=<n>` | Re-sends of a commit after another writer on the same backend moved the graph revision under it (default 8) |
| `IX_PARSE_BUDGET_MS=<ms>` | How long `ix map` / `ix ingest` may spend parsing one file before skipping it and naming it in the summary (default 10000). A skipped file is tried again on every run, and `ix status` warns about it until it is in the graph. `0` turns the budget off |
| `IX_PARSE_WORKERS=<n>` | Most parse workers `ix map` / `ix ingest` starts (default 8, never more than the cores less one). Workers start as files need them, one per 50 files |
| `IX_PATCH_ACTOR=<actor>` | The `actor` stamped on each graph patch `ix map` / `ix ingest` sends (default `ix/ingestion`; `ix ingest --github` uses `ix/github-ingest`). Set it to empty (`IX_PATCH_ACTOR=`) for a backend that authenticates writers and stamps the verified principal itself: such a backend rejects a non-empty actor that differs from the principal with 403 `body actor ... conflicts with verified principal`. Any other value is sent as the actor |

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
| `~/.ix/backend/` | Docker Compose file for the local backend, its `.env` (the local token, mode 0600) and an optional `docker-compose.override.yml` |
| `~/.ix/cli/` | The installed CLI |
| `~/.ix/cli/compass/` | Compass assets, fetched by `ix upgrade` |

## Ports

All services bind to `127.0.0.1` only.

| Port | Service |
|---|---|
| `8090` | Ix Memory Layer (the HTTP API) |
| `8080` | Compass (`ix view`), configurable with `--port` |

ArangoDB has no host port: it runs without authentication, so only the memory layer reaches it, over the Compose network. To use its web UI, publish the port yourself in `~/.ix/backend/docker-compose.override.yml`, which `ix docker` applies, then run `ix docker stop` and `ix docker start` (a backend that is already healthy is left as it is, so `ix docker start` alone does not apply it):

```yaml
services:
  arangodb:
    ports:
      - "127.0.0.1:8529:8529"
```

## Local token

The backend refuses requests from other hosts, from web pages and with non-JSON bodies. It can also require a bearer token, so that another local process cannot use it without the token in `~/.ix`. This is opt-in for now:

```bash
ix docker start --local-token     # generate a token, store it, restart the backend requiring it
ix docker start --no-local-token  # stop requiring it and forget it
ix doctor                         # "Backend token" says whether it is required and accepted
```

The token is stored as `auth.local_token` in `~/.ix/config.yaml` and written to `~/.ix/backend/.env` for Compose. The CLI and `ix view` send it only to a local endpoint. `IX_TOKEN` overrides it, under the same rule: no token, stored or from `IX_TOKEN`, is sent to a backend on another host. To use a token-protected backend elsewhere, forward its port to this machine (for example `ssh -L 8090:localhost:8090 <host>`) and point `IX_ENDPOINT` at `http://localhost:8090`.
