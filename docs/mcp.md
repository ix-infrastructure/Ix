# `ix mcp` — serving the graph tools over MCP

The CLI includes a canonical stdio MCP server exposing the same graph tools the
editor integrations use:

```bash
ix mcp
```

The client launches the server in the active workspace, so every Ix tool uses
that repository's graph and configuration.

## Registering clients

```bash
ix mcp install            # detect clients and register `ix mcp` with each
ix mcp install --dry-run  # show what would change, write nothing
ix mcp doctor             # check each client's registration
```

`install` knows Claude Code, Codex, Cursor, VS Code, Gemini CLI, OpenClaw and
opencode.

### How each client is written

It writes through each client's own MCP command where one exists — `claude mcp
add`, `codex mcp add`, `gemini mcp add`, and `openclaw mcp set` everywhere but
Windows — so the client owns its config format.

Cursor, VS Code and opencode are edited directly instead, as is OpenClaw on
Windows: its registration is passed as a JSON argument, which `cmd` cannot carry
intact. Every direct write is merged in place with a `.bak` kept alongside.

Cursor, VS Code and opencode are also detected by their config directory rather
than by a shell command, since `cursor` and `code` are opt-in shims a GUI
install may not have.

### It never overwrites

If the name `ix-memory` already belongs to a different server — an earlier Ix
plugin, say — that client is reported and left exactly as it was.

| Flag | Effect |
|---|---|
| `--force` | Replace an `ix-memory` registration that is not ours |
| `--host <id>` | Limit the run to one client; an unrecognised id is an error, not a silent no-op |
| `--dry-run` | Print the targets and write nothing |

### Repairing a moved launcher

Where a client's own config can be read back — Cursor, VS Code, opencode, and
OpenClaw off Windows — `doctor` also reports a registration of ours whose
recorded launcher path has since disappeared, and `install` repairs it.

The clients that answer with a rendered table instead expose no stored command,
so a launcher that has moved there is not detected. Clear the name with that
client's own command and re-run:

```bash
claude mcp remove ix-memory
ix mcp install
```

## Registering one client by hand

Point the client at `ix` with the argument `mcp`. For Codex:

```bash
codex mcp add ix-memory -- ix mcp
```

## Process isolation

Tool calls run inside the server process. Set `IX_MCP_SUBPROCESS=1` to run each
one as a separate `ix` child process instead — slower by roughly the CLI's
startup time per call, but fully isolated.

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
`ix config set format llm` (see [output formats](llm-format.md)). Ix's core MCP tools already answer
in this format. JSON arrays are what headroom's array compressor cuts. This avoids that compressor only: headroom
does not exclude shell output by default, so its text compression can still shorten the result. To limit it to the
lossless rewrites, name the shell tool in the environment, `HEADROOM_PROTECT_TOOL_RESULTS=Bash`, which also protects
the tools above.

headroom's `--code-memory` (Serena, installed by default by `wrap`) and `--code-graph` (codebase-memory-mcp) are
separate tools. Ix runs alongside them, or instead of Serena with `--code-memory none`. headroom is a third-party
tool and this is not an official integration; these notes describe its behaviour as of its 976aa71 commit.

## See also

- [Consolidating the per-host plugins onto `ix mcp`](mcp-plugin-consolidation.md)
  — what the six plugin repos can and cannot hand over to MCP.
