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

Generated from the registry in `ix-cli/src/cli/env.ts`. A flag is on for any value but `0`, `false` or `no` (any case); unset or empty leaves its default. A number must be a number in full: `15m` or `-1` keeps the default rather than meaning 15 or -1. An `int` takes whole numbers; an `ms` value is milliseconds.

<!-- env-vars:start (generated from ix-cli/src/cli/env.ts by ix-cli/scripts/check-env-registry.mjs --write) -->
| Variable | Type | Default | Effect |
|---|---|---|---|
| `IX_AUTO_MAP` | flag | off | Set by editor and agent hooks: marks an `ix map` as automatic. An automatic run ingests and defers computing the map, and is skipped against a remote backend |
| `IX_AUTO_MAP_CLOUD` | flag | off | Lets an automatic `ix map` (`IX_AUTO_MAP`) run against a remote backend too |
| `IX_BULK_DELETES` | flag | decided by the backend's release | Whether the backend's bulk commit route takes patches that delete nodes. Set it on or off for a backend build that reports no release |
| `IX_COMMIT_BASE_REV_RETRIES` | int | 8 | Re-sends of a commit after another writer on the same backend moved the graph revision under it |
| `IX_COMMIT_CONCURRENCY` | int | 8 | Commit requests `ix map` / `ix ingest` keeps in flight at once. Lower it to go easier on a struggling backend |
| `IX_COMMIT_CONFLICT_RETRIES` | int | 6 | Retries of one commit after a lock conflict or a dropped connection. `0` turns these retries off. It does not affect the 502/503/504/429 retries; see `IX_COMMIT_TRANSIENT_RETRY_MS` |
| `IX_COMMIT_FAILURE_LIMIT` | int | 5 | Consecutive failed commits before `ix map` stops. It stops after one when the backend reports its database unreachable. `0` never stops |
| `IX_COMMIT_HTTP_MAX_FILES` | int | 1000 | Most files one commit request carries |
| `IX_COMMIT_MAX_OPS` | int | 45000 | Most graph operations one commit request carries: the backend's transaction grows with them |
| `IX_COMMIT_TRANSIENT_RETRY_MS` | ms | 5000 | The total time one bulk commit may spend retrying after a 502, 503, 504 or 429, counting both the requests and the waits between them (at most three retries, and at most one after a 504). A bulk is sent again only if another request as long as the one that failed still fits, so a slow bulk goes straight to the per-file fallback. `Retry-After` is honoured up to that limit; a longer value is cut to it. `0` turns these retries off |
| `IX_CONFIG_LOCK_STALE_MS` | ms | 30000 | How long the `config.yaml` lock may go untouched before it is presumed abandoned |
| `IX_CONFIG_LOCK_WAIT_MS` | ms | 30000 | How long a write to `config.yaml` waits for another process's write to finish before failing |
| `IX_DEBUG` | flag | off | Prints full stack traces on errors, and one stderr line per backend request with the `X-Correlation-Id` it sent (the backend tags its request and slow-query logs with it). Every request of one `ix` run shares the id's prefix |
| `IX_ENDPOINT` | string | `endpoint` in config.yaml, else `http://localhost:8090` | The backend URL. Overrides `endpoint` in the config file |
| `IX_FORMAT` | `text`, `json`, `llm` | `format` in config.yaml, else `text` | Default output format. Overrides the config file. `--format` overrides it |
| `IX_GRAPH_HEALTH` | flag | on | Read commands check whether the workspace's graph looks hollowed by another ingest and say so. `0` turns the check off |
| `IX_GRAPH_HEALTH_TIMEOUT_MS` | ms | 2000 | How long that check may take before the answer goes out without it |
| `IX_HOME` | string | `~/.ix` | Relocates everything under `~/.ix`, configuration included. Useful for giving a CI job or a second install its own state. It's read at use, not at install, so move `~/.ix` there rather than expecting the old configuration to be found |
| `IX_HOOK_DEBUG` | flag | off | Makes `ix hook post-edit` say on stderr why it printed what it did |
| `IX_HOOK_LOG` | string | unset | A file `ix hook post-edit` appends one JSON line to per call, saying what it did and why |
| `IX_HOOK_STATE_DIR` | string | `<IX_HOME>/hook-state` | Where `ix hook post-edit` remembers which edited symbols it already reported this session |
| `IX_HOOK_TIMEOUT_MS` | ms | 3000 | How long `ix hook post-edit` may take before it gives up and prints nothing |
| `IX_LEGACY_EXIT_CODES` | flag | off | Makes every non-zero exit 1, as before exits 2, 3 and 4 had their own meanings |
| `IX_LOAD_ALL_COMMANDS` | flag | off | Loads every command module on each call, as releases before the start-up fast path did. Without Ix Pro installed, `ix <command>` normally loads only that command; with Ix Pro installed every call already loads everything, so this changes nothing there. If a command misbehaves on an install without Pro, try it again with this set: a difference between the two is a bug worth reporting |
| `IX_LOCAL_TOKEN` | string | unset | Read by the local backend, not the CLI: the token it requires on every request. `ix docker start --local-token` writes it to `~/.ix/backend/.env` (see [Local token](#local-token)) |
| `IX_LOCK_DIR` | string | `<IX_HOME>/locks` | Where the CLI keeps the lock files that stop two `ix map` runs (or two stitches) on one workspace at once. For a read-only `IX_HOME` |
| `IX_MAP_BACKGROUND_REFRESH` | flag | on | Read commands start a background `ix map` when the map is stale. `0` turns that off: they answer from the last map and say it is stale |
| `IX_MAP_BACKGROUND_TIMEOUT_MS` | ms | 300000 | The background refresh's hard time limit, so a wedged refresh cannot hold the map lock |
| `IX_MAP_DEADLINE_MS` | ms | 900000 | The wall-clock budget of one `ix map` or `ix ingest`; past it every request is aborted and the command exits. `0` or empty turns it off |
| `IX_MAP_EAGER` | flag | off | Makes an automatic `ix map` compute the map after an incremental edit too, for a hook that reads regions straight from `ix map` |
| `IX_MAP_LOCK_MAX_MS` | ms | 1200000 | How long a map or stitch lock may go untouched before the next run treats it as abandoned and takes it |
| `IX_MAP_REFRESH_DEBOUNCE_MS` | ms | 30000 | How long after one background refresh another may start. `0` or empty means no wait |
| `IX_MCP_SUBPROCESS` | flag | off | Runs each MCP tool call in its own `ix` process |
| `IX_MISS_PROBE` | flag | on | When a name is not in the graph, `ix` searches the files for it to say why (not mapped yet, stale, or only text). `0` skips that search, for a tree too large even for one bounded search |
| `IX_NO_UPDATE_CHECK` | flag | off | Turns off the check for a newer release that `ix` runs when a person is watching (text output on a terminal) |
| `IX_ORPHAN_SWEEP_MAX_MS` | ms | 60000 | Time budget of that cleanup in one run. Files past it are committed without the cleanup and named for the next `IX_RECONCILE_ON_FORCE=1` run |
| `IX_ORPHAN_SWEEP_MAX_REQUESTS` | int | 25000 | Request budget of that cleanup in one run: one stored-patch read per file, one node read per 1000 candidates |
| `IX_PARSE_BUDGET_MS` | ms | 10000 | How long `ix map` / `ix ingest` may spend parsing one file before skipping it and naming it in the summary. A skipped file is tried again on every run, and `ix status` warns about it until it is in the graph. `0` turns the budget off |
| `IX_PARSE_DEBUG` | flag | off | Read by the parser, which takes only `1`: prints why a file's parse failed on stderr |
| `IX_PARSE_STREAM_CHUNK` | int | 500 | Files parsed per batch before the batch is committed. For tests: a small value makes a small run behave like a large one |
| `IX_PARSE_WORKERS` | int | 8 | Most parse workers `ix map` / `ix ingest` starts (never more than the cores less one). Workers start as files need them, one per 50 files |
| `IX_PATCH_ACTOR` | string | `ix/ingestion` (`ix/github-ingest` for `ix ingest --github`) | The `actor` stamped on each graph patch `ix map` / `ix ingest` sends. Set it to empty (`IX_PATCH_ACTOR=`) for a backend that authenticates writers and stamps the verified principal itself: such a backend rejects a non-empty actor that differs from the principal with 403 `body actor ... conflicts with verified principal`. Any other value is sent as the actor |
| `IX_READ_DEADLINE_MS` | ms | 60000 | How long one command's reads may take in all before it fails, so a hung backend fails a query in a minute rather than after each request's 2-minute timeout. The clock restarts after each write the command makes. `ix map`, `ix ingest` and `ix stats` have no read deadline. `0` turns it off. A read that meets a refused or dropped connection, or a 502/503/504, is retried once; writes are not, except as `IX_COMMIT_CONFLICT_RETRIES` and `IX_COMMIT_TRANSIENT_RETRY_MS` describe |
| `IX_RECONCILE_ON_FORCE` | flag | off | Makes an `ix map --force` (or `ix ingest --force`) also remove nodes an earlier extractor wrote and the current one no longer does, at the files' current content. `ix map` does this by itself on the run after an extractor change, on a backend from 1.0.33 that applies deletes in bulk. Set this to finish a cleanup that run could not do (an older backend, since upgraded) or did not finish (its budget ran out): it reads only what was left. Without a record of what was left, it reads the patch of the extractor before the current one for every file |
| `IX_SMELLS_WAIT` | int | 20 (json, llm), 300 (text) | Seconds `ix smells` waits for a fresh analysis before showing the stored results; at most 300. `--wait` overrides it. Ignored under MCP |
| `IX_STDIN_IDLE_MS` | ms | 300000 | How long a command reading text from stdin waits for the pipe to send anything more before it fails, rather than hanging on a pipe left open. `0` turns it off |
| `IX_STITCH_COOLDOWN_MS` | ms | 900000 | How long `ix map` declines to start a cross-repo stitch after one that may still be running on the backend. `0` turns the cooldown off |
| `IX_STITCH_WAIT_MS` | ms | 30000 | How long `ix map` waits for a stitch that is still in flight to finish before skipping its own |
| `IX_STRICT_TARGETS` | flag | off | What `--strict` does, for every graph command: an ambiguous target exits 2 and a name found only as text exits 3, rather than being answered |
| `IX_TOKEN` | string | the stored local token | Bearer token sent to a local backend (localhost or another loopback address) on every request. Overrides the stored local token (see [Local token](#local-token)). Never sent to any other endpoint |
<!-- env-vars:end -->

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
