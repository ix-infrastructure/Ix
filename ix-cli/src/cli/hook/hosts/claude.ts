// Copyright 2026 Ix Infrastructure Inc.

import type { HookEvent, HostAdapter } from "../host.js";

/** Claude Code's tools that write a file named by `tool_input.file_path`. */
export const CLAUDE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * Claude Code: the hook's stdin is one JSON object (`session_id`, `cwd`,
 * `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `prompt`),
 * and context for the model goes back as
 * `{"hookSpecificOutput":{"hookEventName":...,"additionalContext":...}}`.
 */
export const claudeCodeAdapter: HostAdapter = {
  id: "claude",

  readEvent(raw: string): HookEvent | undefined {
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return undefined; }
    if (!payload || typeof payload !== "object") return undefined;
    const p = payload as Record<string, unknown>;
    // A cwd that is there but not a string is not something Claude Code
    // sends; claude-post-edit has always printed nothing for it.
    if (p.cwd && typeof p.cwd !== "string") return undefined;
    const toolName = str(p.tool_name);
    const toolInput = record(p.tool_input);
    const toolResponse = record(p.tool_response);
    const edited = toolName !== undefined && CLAUDE_EDIT_TOOLS.has(toolName)
      ? toolInput?.file_path ?? toolResponse?.filePath
      : undefined;
    return {
      host: "claude",
      event: str(p.hook_event_name),
      cwd: str(p.cwd),
      // Spelled as claude-post-edit has always keyed its state file
      // (`${session_id}`), so a session's memory survives the move here.
      sessionId: p.session_id == null ? undefined : String(p.session_id),
      toolName,
      editedPaths: typeof edited === "string" && edited !== "" ? [edited] : [],
      prompt: str(p.prompt),
      payload,
    };
  },

  writeContext(event: string, additionalContext: string): string {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext },
    });
  },
};

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? v as Record<string, unknown> : undefined;
}
