// Copyright 2026 Ix Infrastructure Inc.

import type { HookDecision, HookEvent, HostAdapter } from "../host.js";
import { idString, onePath, parseObject, record, str } from "./fields.js";

/** Claude Code's tools that write a file named by `tool_input.file_path`. */
export const CLAUDE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * Claude Code: the hook's stdin is one JSON object (`session_id`, `cwd`,
 * `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `prompt`),
 * and context for the model goes back as
 * `{"hookSpecificOutput":{"hookEventName":...,"additionalContext":...}}`.
 * A PreToolUse decision goes back in the same wrapper as
 * `permissionDecision` / `permissionDecisionReason`.
 */
export const claudeCodeAdapter: HostAdapter = {
  id: "claude",
  projectDirEnv: "CLAUDE_PROJECT_DIR",

  readEvent(raw: string): HookEvent | undefined {
    const p = parseObject(raw);
    if (!p) return undefined;
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
      sessionId: idString(p.session_id),
      toolName,
      editedPaths: onePath(edited),
      prompt: str(p.prompt),
      payload: p,
    };
  },

  writeContext(event: string, additionalContext: string): string {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext },
    });
  },

  writeDecision(event: string, decision: HookDecision, reason?: string): string {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, permissionDecision: decision, permissionDecisionReason: reason },
    });
  },

  projectDirs(event: HookEvent): string[] {
    return event.cwd === undefined ? [] : [event.cwd];
  },
};
