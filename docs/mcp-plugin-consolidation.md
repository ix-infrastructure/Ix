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
| ix-openclaw-plugin | 17 | `ix-decide` (pre-edit verdict), `ix_docs_tool`, `ix_ingest`, `ix_neighbors`, `ix_query` |
| ix-opencode-plugin | 17 | `ix-decide` (pre-edit verdict), `ix_docs_tool`, `ix_ingest`, `ix_neighbors`, `ix_query` |
| ix-claude-plugin | 0 (skills only) | — |

`ix mcp` now closes most of that gap. One gap stays open, and three tools are
excluded on purpose.

Not served: **the pre-edit verdict.** The openclaw and opencode plugins ship an
`ix-decide` tool (`tools/ix-decide.ts`) that takes `touched_paths`, `intent` and
`risk_tolerance` and answers ALLOW or REVIEW, computed from `ix impact`. It is
read-only and needs no Pro. `ix mcp` has no equivalent. Its `ix_decide` shares
the name and nothing else: it runs the Pro command `ix decide <title>` and
records a design decision, which is a write. The verdict stays in those
plugins' own tools and hooks until a read-only MCP tool exists for it, and that
tool should not reuse the name.

The deliberate exclusions:

- **`ix_query`** — the deprecated command the CLI docs tell agents not to use
  ("produces oversized low-signal responses"). Dropped on purpose.
- **`ix_neighbors`** — a composite of `ix_callers` + `ix_callees` + `ix_depends`,
  all served individually. Callers lose one round-trip, not a capability.
- **`ix_docs_tool`** — a composite over `ix_overview`, likewise served.

And `ix_status` is Gemini's name for what `ix mcp` calls `ix_health`; both run
`ix status`.

`ix_ingest` was a real gap and is now served. `ix_decide` is served too, but
it is the Pro decision recorder; whether that is what gemini's own `ix_decide`
does has not been re-checked here, so compare its parameters before migrating
that plugin. `ix_decide` is a write and needs Pro, so it is advertised only
when `@ix/pro` resolves — as are `ix_briefing` and `ix_decisions`, which this
server previously offered to every install even though every call answered
"requires Ix Pro".

**Net:** codex and cursor can delegate with no change in what an agent can do.
gemini loses `ix_query`, plus a verdict tool if its `ix_decide` turns out to be
one. openclaw and opencode lose `ix_query`, the two composites and the pre-edit
verdict.

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

- **Structured content.** `ix_map`, `ix_ingest` and `ix_smells` return their
  parsed JSON object as `structuredContent` (with an `outputSchema`) so agents
  receive typed values instead of a string to re-parse. The schema asserts only
  "an object": the real field shape is backend-defined and versioned, and
  promising specific fields would break tool calls the moment the backend
  renames one. The human-readable text result is preserved for clients that
  prefer it. Most remaining tools return their `llm`-format text, which has no
  stable object shape worth promising.

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
   Before migrating openclaw or opencode, remove every prompt, skill or hook
   text that tells an agent to call `ix-decide` before editing. Under `ix mcp`
   the closest name an agent will find is `ix_decide`, which writes a decision
   record instead of returning a verdict.
3. **Leave agents, hooks, skills and commands where they are.** They are the
   plugins' remaining reason to exist.

Step 2 is one PR per repo and each is independently revertible; a plugin that has
not migrated keeps working, because `ix mcp install` refuses to take a name that
another server already holds.
