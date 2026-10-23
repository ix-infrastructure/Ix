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

`ix mcp` advertises five tools by default, one per question the graph answers better than Grep and Read:

| Tool | Answers |
|---|---|
| `ix_context` | Where do I start on this target or issue (`issue=<text>`)? Ranked evidence with `path:lines` |
| `ix_search` | Which definition does this name mean? |
| `ix_neighbors` | Callers, callees, imports or importers, picked by `relation` |
| `ix_impact` | What does a change to this reach? |
| `ix_read` | The source of a symbol by name, or a line range |

The server also sends `instructions` when a client connects, saying when to use Ix instead of Grep and which tool to
reach for first. Clients that load tool schemas only on demand still show these to the model. Over MCP, hints and
`next` records are written as tool calls with arguments, such as `ix_neighbors symbol=X relation=callers`, not as CLI
flags.

`ix mcp --tools=all` advertises every tool instead, including `ix_health`, `ix_text`, `ix_locate`, `ix_overview`
and `ix_explain`, which were in the default set before.

## Repair a moved launcher

If you move or reinstall `ix`, a client may still point at the old path. For Cursor, VS Code, opencode and OpenClaw
(except on Windows), `ix mcp doctor` reports the stale registration and `ix mcp install` repairs it.

Other clients don't expose their stored command, so remove the registration with the client's own command and
re-run the install:

```bash
claude mcp remove ix-memory
ix mcp install
```

## Behind a compressing proxy

Some proxies shrink tool results before the model sees them. headroom (`headroom wrap claude`) is one: it compresses
every tool result except those on its exclude list, and Ix's tools are not on that list by default. Ix has already
ranked its answer and cut it to a budget, and it says so in the output (`truncated ...` records and the shown/total
counts). A second cut can drop rows Ix ranked high, and the agent loses the signal that something is missing.

Add the Ix tools to headroom's excluded tools:

```bash
HEADROOM_EXCLUDE_TOOLS='mcp__ix-memory__*' headroom wrap claude
```

`mcp__ix-memory__*` matches the names Claude Code gives the tools of the `ix-memory` server that `ix mcp install`
registers. If you registered Ix under another name, use that name. Set it as an environment variable:
`headroom wrap claude` has no flag for it and passes options it does not know on to `claude`, but it hands its
environment to the proxy it starts. The proxy reads the setting when it starts, so restart it after changing it.
Excluded results skip headroom's lossy compression, but it can still rewrite them without losing data: JSON is
minified, repeated log lines are collapsed and search hits are grouped under their path. In token mode, excluded
results far back in a long session can also be compressed; `HEADROOM_PROTECT_TOOL_RESULTS` turns that off, but it
also protects Read, Glob, Grep, Write and Edit results.

If the agent calls `ix` through the shell, prefer `--format llm`, or set it once with `IX_FORMAT=llm` or
`ix config set format llm` (see [output formats](/concepts/output-formats/)). Ix's core MCP tools already answer
in this format. JSON arrays are what headroom's array compressor cuts. This avoids that compressor only: headroom
does not exclude shell output by default, so its text compression can still shorten the result. To limit it to the
lossless rewrites, name the shell tool in the environment, `HEADROOM_PROTECT_TOOL_RESULTS=Bash`, which also protects
the tools above.

headroom's `--code-memory` (Serena, installed by default by `wrap`) and `--code-graph` (codebase-memory-mcp) are
separate tools. Ix runs alongside them, or instead of Serena with `--code-memory none`. headroom is a third-party
tool and this is not an official integration; these notes describe its behaviour as of its 976aa71 commit.

## Process isolation

Tool calls run inside the server process. Set `IX_MCP_SUBPROCESS=1` to run each call as a separate `ix` child
process instead. Each call gets slower by roughly the CLI's startup time, but the calls are fully isolated from one
another.
