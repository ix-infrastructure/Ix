// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { parseBudgetOption } from "../options.js";
import { DEFAULT_TOKEN_BUDGET } from "../around.js";
import { runAutoMapProcess } from "../hook/auto-map.js";
import { runHookProcess } from "../hook/entry.js";

/**
 * `ix hook <agent-event>`: entry points an agent harness runs on its own
 * events. One subcommand per (harness, event), because each harness has its
 * own stdin and stdout contract; `claude-post-edit` is Claude Code's
 * PostToolUse for Edit / MultiEdit / Write. `auto-map` serves every host,
 * told apart by `--host`.
 */
export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description("Entry points for agent hooks (Claude Code PostToolUse: claude-post-edit; any host: auto-map)");

  hook
    .command("claude-post-edit")
    .description("Claude Code PostToolUse hook: after an edit, tell the agent who depends on what it changed")
    .option("--graph-root <dir>", "Mapped workspace to query (default: the one containing the edited file)")
    .option("--worktree <dir>", "Checkout the agent edits (default: git root of the hook cwd); mapped to the same relative paths in --graph-root")
    .option("--budget <tokens>", "Token budget for the context it adds (~4 chars a token)", (v: string) => parseBudgetOption(v, String(DEFAULT_TOKEN_BUDGET)), DEFAULT_TOKEN_BUDGET)
    .addHelpText("after", `
Reads Claude Code's PostToolUse JSON on stdin and the working tree's diff
against HEAD, so an edit made through Bash counts as much as one made with
Edit or Write. Each edited symbol is reported once per session (state in
IX_HOOK_STATE_DIR, default <IX_HOME>/hook-state); a call that edited nothing new
prints nothing. Prints one JSON object,
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}},
naming the changed symbols' callers, importers that use them, and tests that
reach them -- or prints nothing. Always exits 0: a backend that is down, an
unmapped workspace, a file not in the graph or a non-code file all print
nothing. Gives up after IX_HOOK_TIMEOUT_MS (default 3000). IX_HOOK_DEBUG=1
says why on stderr; IX_HOOK_LOG=<file> appends one JSON line per call saying
what it did (no_changes, diff_unchanged, reported, silent, timeout;
tool-edit outside git) and why.

.claude/settings.json:
  {"hooks":{"PostToolUse":[{"matcher":"Edit|MultiEdit|Write|Bash",
    "hooks":[{"type":"command","command":"ix hook claude-post-edit"}]}]}}`)
    // Normally never reached: main.ts dispatches this invocation before the
    // CLI loads. Kept so the command is registered, documented and runnable
    // through the full CLI too.
    .action(async (opts: { graphRoot?: string; worktree?: string; budget: number }) => {
      await runHookProcess(opts);
    });

  hook
    .command("auto-map")
    .description("Guarded, debounced automatic map: refresh an already-mapped project's graph in the background")
    .option("--host <name>", "Whose hook payload is on stdin, for its field names: claude, cursor, gemini or codex", "claude")
    .option("--root <dir>", "Project directory to map from (default: the payload's, else the host's project variable, else the cwd)")
    .addHelpText("after", `
Reads the host's hook JSON on stdin for the project directory (Claude Code,
Gemini CLI, Codex: cwd; Cursor: workspace_roots) and starts at most one
detached \`ix map <root> --silent\` with IX_AUTO_MAP=1 for its git root, then
returns. Skips, in this order: a directory outside git, a git root that is
$HOME, a root tried within IX_MAP_DEBOUNCE_SECONDS (default 300; the stamp,
in IX_HOOK_STATE_DIR, default <IX_HOME>/hook-state, is written before the next
check), a root that is not a registered workspace with a completed graph
ingest (an automatic map never creates a workspace). When a map of the root
is already running it asks that map for one more pass instead. Prints nothing
and always exits 0; gives up after IX_HOOK_TIMEOUT_MS (default 3000), never
the map itself. IX_HOOK_DEBUG=1 says why on stderr; IX_HOOK_LOG=<file>
appends one JSON line per call.

Claude Code, .claude/settings.json:
  {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"ix hook auto-map --host claude"}]}]}}
Cursor, .cursor/hooks.json:
  {"version":1,"hooks":{"stop":[{"command":"ix hook auto-map --host cursor"}]}}
Gemini CLI, .gemini/settings.json:
  {"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"ix hook auto-map --host gemini"}]}]}}
Codex, .codex/hooks.json:
  {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"ix hook auto-map --host codex"}]}]}}`)
    // Normally never reached: main.ts dispatches this before the CLI loads.
    .action(async (opts: { host?: string; root?: string }) => {
      await runAutoMapProcess(opts);
    });
}
