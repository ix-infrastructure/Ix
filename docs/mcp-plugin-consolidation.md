# Consolidating the per-host plugins onto `ix mcp`

Ix ships six per-host plugin repos, each with its own tool implementation:
`ix-claude-plugin`, `ix-codex-plugin`, `ix-cursor-plugin`, `ix-gemini-plugin`,
`ix-openclaw-plugin`, `ix-opencode-plugin`. `ix mcp` serves the same graph tools
from the CLI, so those implementations can be retired in favour of one server.

This is what that costs and in what order it can happen.

## What MCP can and cannot absorb

Measured across the six repos (source only, excluding `node_modules` and `dist`):

| Layer | Lines | Absorbed by `ix mcp`? |
|---|---:|---|
| Tool implementations (`mcp/`, `tools/`, `runtime/`) | ~15,300 | **Yes** |
| Agents, hooks, skills, commands, rules | ~10,600 | **No** |

MCP standardizes tools, resources and prompts. It has no concept of a hook, a
skill, a slash command or a host instruction file, so roughly 40% of what the
plugins do has no MCP equivalent and stays host-specific whatever else happens.
Consolidation retires the tool layer; it does not retire the plugins.

## Tool-surface parity

The plugins never shared one tool surface. Measured against `ix mcp`:

| Plugin | Tools | Tools `ix mcp` lacked |
|---|---:|---|
| ix-codex-plugin | 23 | — |
| ix-cursor-plugin | 23 | — |
| ix-gemini-plugin | 23 | `ix_decide`, `ix_ingest`, `ix_query`, `ix_status` |
| ix-openclaw-plugin | 17 | `ix_decide`, `ix_docs_tool`, `ix_ingest`, `ix_query` |
| ix-opencode-plugin | 17 | `ix_decide`, `ix_docs_tool`, `ix_ingest`, `ix_query` |
| ix-claude-plugin | 0 (skills only) | — |

`ix mcp` now closes that gap, with two deliberate exclusions:

- **`ix_query`** — the deprecated command the CLI docs tell agents not to use
  ("produces oversized low-signal responses"). Dropped on purpose.
- **`ix_docs_tool`** — a composite over `ix_overview`, which is served.

`ix_neighbors` is served. It is one tool for callers, callees, imports,
importers and overrides. The four single-relation tools stay in the full
catalog for `--tools=all`; the default session advertises `ix_neighbors` in
their place. See [Toolsets](mcp.md#toolsets).

And `ix_status` is Gemini's name for what `ix mcp` calls `ix_health`; both run
`ix status`.

`ix_decide`, `ix_ingest` and `ix_neighbors` were real gaps and are now served.
`ix_decide` is a write and needs Pro, so it is advertised only when `@ix/pro`
resolves — as are `ix_briefing` and `ix_decisions`, which this server previously
offered to every install even though every call answered "requires Ix Pro".

**Net:** codex and cursor can delegate with no change in what an agent can do.
gemini loses `ix_query` (`ix_status` is served as `ix_health`). openclaw and
opencode lose `ix_query` and `ix_docs_tool`.

## Structured results and tool annotations

`ix mcp` exposes two protocol conveniences on top of the tool surface:

- **Tool annotations.** Every advertised tool carries a `title`, and every tool
  implemented in this repository also carries `readOnlyHint`, `destructiveHint`,
  `idempotentHint` and `openWorldHint` so a client can present and route it
  correctly. Graph reads are read-only and idempotent; `ix_map`, `ix_ingest`,
  and `ix_smells` in its default mode, which stores versioned claims, are
  destructive because they mutate backend state; only `ix_ingest` is
  open-world, because its GitHub form reaches an external API.

  The Pro tools — `ix_briefing`, `ix_decisions`, `ix_decide` — carry a title and
  no behavioral hint, for the same reason they carry no `outputSchema`: they are
  implemented in the separate `@ix/pro` package, so nothing here can check a
  claim about them. That asymmetry is deliberate rather than an oversight.
  Clients use `readOnlyHint` to decide whether a call needs the user's approval,
  so a wrong one does not merely mislabel a tool — it removes the prompt in
  front of it. An absent hint costs a confirmation; a wrong one costs the
  confirmation itself.

  Hints describe intent and are not themselves a boundary: the enforcement that
  matters (argv construction, timeouts, output bounds, process cleanup) lives in
  the runner, and what a tool can reach is bounded by the command it runs, not by
  what it is advertised as.

- **Structured content.** `ix_map` and `ix_ingest` return their parsed JSON
  object as `structuredContent`, with an `outputSchema`, so agents receive
  typed values instead of a string to re-parse. The schema asserts only "an
  object": the real field shape is backend-defined and versioned, and
  promising specific fields would break tool calls the moment the backend
  renames one. The human-readable text result is preserved for clients that
  prefer it. Most remaining tools return their `llm`-format text, which has no
  stable object shape worth promising.

  `ix_smells` and `ix_context` return `structuredContent` only when the caller
  passes `structured: true`. Neither declares an `outputSchema`: an output
  schema is a promise that every result carries structured content, and an
  opt-in copy cannot make that promise. Without the flag, `ix_smells` returns
  compact JSON text and `ix_context` returns llm records.

  The Pro tools are the exception worth naming: they run in JSON too, but get
  neither an `outputSchema` nor `structuredContent`, because their shape cannot
  be checked from this package. Those two go together on purpose — attaching the
  parsed object without the schema would hand clients the unverified value
  anyway, minus the contract that would let them validate it. Their answer is
  still returned, as text.

## Order of work

1. **Ship `ix mcp` in a released `@ix/cli`.** Nothing downstream can depend on it
   until then. The plugins already gate features on CLI version floors, so this
   becomes a new floor.
2. **Point each plugin's registration at `ix mcp`** instead of its own server,
   and delete that server. Start with codex and cursor — those two are lossless.
3. **Leave agents, hooks, skills and commands where they are.** They are the
   plugins' remaining reason to exist.

Step 2 is one PR per repo and each is independently revertible; a plugin that has
not migrated keeps working, because `ix mcp install` refuses to take a name that
another server already holds.
