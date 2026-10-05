// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { parseBudgetOption } from "../options.js";
import { DEFAULT_TOKEN_BUDGET } from "../around.js";
import { runHookProcess } from "../hook/entry.js";

/**
 * `ix hook <agent-event>`: entry points an agent harness runs on its own
 * events. One subcommand per (harness, event), because each harness has its
 * own stdin and stdout contract; `claude-post-edit` is Claude Code's
 * PostToolUse for Edit / MultiEdit / Write.
 */
export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description("Entry points for agent hooks (Claude Code PostToolUse: claude-post-edit)");

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
}
