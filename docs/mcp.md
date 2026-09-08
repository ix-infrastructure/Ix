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

## See also

- [Consolidating the per-host plugins onto `ix mcp`](mcp-plugin-consolidation.md)
  — what the six plugin repos can and cannot hand over to MCP.
