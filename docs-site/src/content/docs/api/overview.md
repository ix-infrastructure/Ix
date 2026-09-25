---
title: HTTP API overview
description: The JSON-over-HTTP API the local Ix backend serves to the CLI, MCP server and Compass.
---

The Ix backend serves a JSON-over-HTTP API on **`http://localhost:8090`**. The `ix` CLI, the MCP server and Compass
are all clients of it. You only need it to build your own tooling on top of the graph.

The **Endpoints** pages in the sidebar are generated from the
[OpenAPI spec](https://github.com/ix-infrastructure/Ix/blob/main/docs/api/openapi.yaml). A CI check keeps that spec
in step with what the CLI actually calls.

## Quick start

```bash
# Liveness and graph schema version
curl -s http://localhost:8090/v1/health

# Ingest a repository
curl -s -X POST http://localhost:8090/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{"path": "/absolute/path/to/repo", "recursive": true}'

# Search for a symbol
curl -s -X POST http://localhost:8090/v1/search \
  -H "Content-Type: application/json" \
  -d '{"term": "IngestionService", "limit": 10, "kind": "class"}'
```

## Conventions

- Every endpoint is under `/v1` and speaks JSON (`Content-Type: application/json`).
- Schema compatibility is signaled by `schema_version` in `GET /v1/health`, which also reports the backend's
  release version.
- **No authentication** on the local backend. It binds to localhost only.

## Scoping

Most read endpoints accept optional `workspace_id` and `system_id` parameters that bound the result set to one
workspace or one multi-repository system. When neither is given, the backend falls back to the `x-ix-workspace` and
`x-ix-system` headers.

## Visualizer proxy

Compass (`ix view`, port 8080) proxies every `/v1/*` request to the backend and stamps the workspace headers, so the
browser app never handles workspaces itself. It adds one endpoint of its own:

- `POST /__ix/remap` rebuilds the graph of the workspace the view is scoped to. It accepts loopback requests only,
  and returns `409` under `--all` or while a remap is already running.

## Full reference

The [full API reference](/api/reference/) covers every endpoint by area, plus data models, errors, timeouts and
versioning.
