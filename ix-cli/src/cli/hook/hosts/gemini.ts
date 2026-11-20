// Copyright 2026 Ix Infrastructure Inc.

import type { HookDecision, HookEvent, HostAdapter } from "../host.js";
import { idString, onePath, parseObject, record, str } from "./fields.js";

/** Gemini CLI's built-in tools that write a file named by `tool_input.file_path`. */
const GEMINI_EDIT_TOOLS: ReadonlySet<string> = new Set(["replace", "write_file"]);

/**
 * Gemini CLI: the hook's stdin is one JSON object with `session_id`,
 * `transcript_path`, `cwd`, `hook_event_name` and `timestamp` on every event,
 * plus `tool_name` / `tool_input` / `tool_response` on BeforeTool and
 * AfterTool and `prompt` on BeforeAgent. Context for the model goes back as
 * Claude Code's does, `{"hookSpecificOutput":{"hookEventName":...,
 * "additionalContext":...}}`; a decision goes back as top-level `decision` /
 * `reason`.
 */
export const geminiCliAdapter: HostAdapter = {
  id: "gemini",
  projectDirEnv: "GEMINI_PROJECT_DIR",

  readEvent(raw: string): HookEvent | undefined {
    const p = parseObject(raw);
    if (!p) return undefined;
    const toolName = str(p.tool_name);
    const edited = toolName !== undefined && GEMINI_EDIT_TOOLS.has(toolName) ? record(p.tool_input)?.file_path : undefined;
    return {
      host: "gemini",
      event: str(p.hook_event_name),
      cwd: str(p.cwd),
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

  writeDecision(_event: string, decision: HookDecision, reason?: string): string {
    return JSON.stringify({ decision, reason });
  },

  projectDirs(event: HookEvent): string[] {
    return event.cwd === undefined ? [] : [event.cwd];
  },
};
