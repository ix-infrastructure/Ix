// Copyright 2026 Ix Infrastructure Inc.

import type { HookDecision, HookEvent, HostAdapter } from "../host.js";
import { idString, onePath, parseObject, record, str, strings } from "./fields.js";

/** Cursor's events whose top-level `file_path` is a file the agent (or Tab) just wrote. */
const CURSOR_EDIT_EVENTS: ReadonlySet<string> = new Set(["afterFileEdit", "afterTabFileEdit"]);

/**
 * Cursor's generic tool events, on which a `Write` tool call names its file in
 * `tool_input.file_path` (or `tool_input.path`). postToolUseFailure is left
 * out: the write did not happen.
 */
const CURSOR_TOOL_EVENTS: ReadonlySet<string> = new Set(["preToolUse", "postToolUse"]);

/**
 * The only events on which Cursor hands a hook's `additional_context` to the
 * model. preToolUse's agent_message reaches the agent only on a deny, and
 * beforeSubmitPrompt takes only continue / user_message, so neither carries
 * advisory context.
 */
const CURSOR_CONTEXT_EVENTS: ReadonlySet<string> = new Set(["sessionStart", "postToolUse", "postToolUseFailure"]);

/**
 * The decision fields Cursor reads on each before-action event: which
 * permission values it takes, and whether it reads `agent_message`. Any other
 * event takes no decision.
 */
const CURSOR_PERMISSION_EVENTS: ReadonlyMap<string, { values: readonly HookDecision[]; agentMessage: boolean }> = new Map([
  ["preToolUse", { values: ["allow", "deny"], agentMessage: true }],
  ["beforeShellExecution", { values: ["allow", "deny", "ask"], agentMessage: true }],
  ["beforeMCPExecution", { values: ["allow", "deny", "ask"], agentMessage: true }],
  ["subagentStart", { values: ["allow", "deny"], agentMessage: false }],
  ["beforeReadFile", { values: ["allow", "deny"], agentMessage: false }],
]);

/**
 * Cursor: the hook's stdin is one JSON object with `conversation_id`,
 * `generation_id`, `model`, `hook_event_name`, `cursor_version`,
 * `workspace_roots` (every folder the window has open), `user_email` and
 * `transcript_path` on every event, plus the event's own fields: `tool_name`,
 * `tool_input`, `tool_use_id` and `cwd` on preToolUse / postToolUse,
 * `file_path` and `edits` on afterFileEdit, `prompt` on beforeSubmitPrompt.
 *
 * A hook answers with flat snake_case keys, and Cursor reads each only on
 * some events (https://cursor.com/docs/hooks, "Hook events"):
 * `additional_context` on sessionStart and postToolUse(Failure); `permission`
 * (+ `user_message`, and `agent_message` where read) on the before-action
 * events; `continue` + `user_message` on beforeSubmitPrompt. Where Cursor reads
 * nothing, the adapter writes nothing.
 */
export const cursorAdapter: HostAdapter = {
  id: "cursor",
  projectDirEnv: "CURSOR_PROJECT_DIR",

  readEvent(raw: string): HookEvent | undefined {
    const p = parseObject(raw);
    if (!p) return undefined;
    const event = str(p.hook_event_name);
    const toolName = str(p.tool_name);
    let editedPaths: string[] = [];
    if (event !== undefined && CURSOR_EDIT_EVENTS.has(event)) {
      editedPaths = onePath(p.file_path);
    } else if (event !== undefined && CURSOR_TOOL_EVENTS.has(event) && toolName === "Write") {
      const input = record(p.tool_input);
      editedPaths = onePath(input?.file_path ?? input?.path);
    }
    return {
      host: "cursor",
      event,
      // The agent runs in the window's first folder; a shell command's `cwd` is
      // only where that command runs, so it counts only when no folder is named.
      cwd: strings(p.workspace_roots)[0] ?? str(p.cwd),
      sessionId: idString(p.conversation_id),
      toolName,
      editedPaths,
      prompt: str(p.prompt),
      payload: p,
    };
  },

  writeContext(event: string, additionalContext: string): string {
    return CURSOR_CONTEXT_EVENTS.has(event) ? JSON.stringify({ additional_context: additionalContext }) : "";
  },

  writeDecision(event: string, decision: HookDecision, reason?: string): string {
    if (event === "beforeSubmitPrompt") {
      // No "ask" here: anything but allow holds the prompt back, and tells the user why.
      return decision === "allow"
        ? JSON.stringify({ continue: true })
        : JSON.stringify({ continue: false, user_message: reason });
    }
    const fields = CURSOR_PERMISSION_EVENTS.get(event);
    if (!fields) return "";
    // Where Cursor cannot ask the user, the action does not go ahead unasked.
    const permission = fields.values.includes(decision) ? decision : "deny";
    if (permission === "allow") return JSON.stringify({ permission });
    return JSON.stringify({
      permission,
      user_message: reason,
      agent_message: fields.agentMessage ? reason : undefined,
    });
  },

  projectDirs(event: HookEvent): string[] {
    return strings((event.payload as Record<string, unknown>).workspace_roots);
  },
};
