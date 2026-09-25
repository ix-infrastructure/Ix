---
title: MCP server
description: Serve Ix's graph tools to any MCP client with ix mcp.
---

The CLI includes a stdio [Model Context Protocol](https://modelcontextprotocol.io) server:

```bash
ix mcp
```

You don't normally run it yourself. Your AI client launches it in the active workspace, so every tool call answers
from that repository's graph.

## Register your clients

```bash
ix mcp install            # detect installed clients and register ix mcp with each
ix mcp install --dry-run  # show what would change, write nothing
ix mcp doctor             # check each client's registration
```

| Flag | Effect |
|---|---|
| `--host <ids...>` | Only these clients: `claude`, `codex`, `cursor`, `vscode`, `gemini`, `openclaw`, `opencode`. An unknown ID is an error |
| `--dry-run` | Print the targets and write nothing |
| `--force` | Replace an `ix-memory` registration that belongs to a different server |

`install` writes through each client's own MCP command where one exists (`claude mcp add`, `codex mcp add`,
`gemini mcp add`, `openclaw mcp set`), so the client stays in charge of its own config format. It edits Cursor,
VS Code and opencode config files directly, merging in place and keeping a `.bak` alongside.

It **never overwrites** a server it doesn't own. If the name `ix-memory` already belongs to something else, such as
an earlier Ix plugin, that client is reported and left untouched. Pass `--force` to replace it.

## Register one client by hand

Point the client at `ix` with the argument `mcp`. For Codex:

```bash
codex mcp add ix-memory -- ix mcp
```

## Tools

`ix mcp` advertises ten tools by default:

| Tool | Answers |
|---|---|
| `ix_health` | Is the backend reachable? |
| `ix_locate` | Where is this symbol defined? |
| `ix_search` | Which entities match this name? |
| `ix_text` | Where does this text appear? |
| `ix_explain` | What is this, and what does it touch? |
| `ix_overview` | A structural summary of a target |
| `ix_context` | A bounded context bundle for a target |
| `ix_impact` | What breaks if this changes? |
| `ix_neighbors` | Callers, callees, imports or importers, picked by `relation` |
| `ix_read` | The source of a symbol or line range |

`ix mcp --tools=all` advertises every tool instead.

## Repair a moved launcher

If you move or reinstall `ix`, a client may still point at the old path. For Cursor, VS Code, opencode and OpenClaw
(except on Windows), `ix mcp doctor` reports the stale registration and `ix mcp install` repairs it.

Other clients don't expose their stored command, so remove the registration with the client's own command and
re-run the install:

```bash
claude mcp remove ix-memory
ix mcp install
```

## Process isolation

Tool calls run inside the server process. Set `IX_MCP_SUBPROCESS=1` to run each call as a separate `ix` child
process instead. Each call gets slower by roughly the CLI's startup time, but the calls are fully isolated from one
another.
