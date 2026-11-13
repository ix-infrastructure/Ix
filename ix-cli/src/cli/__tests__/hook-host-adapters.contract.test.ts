// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { autoMapProjectDirs } from "../hook/auto-map.js";
import { HOST_ADAPTERS, hostAdapter, type HookEvent, type HostAdapter } from "../hook/host.js";
import { claudeCodeAdapter } from "../hook/hosts/claude.js";
import { cursorAdapter } from "../hook/hosts/cursor.js";
import { geminiCliAdapter } from "../hook/hosts/gemini.js";

/**
 * Each host adapter's contract with its host, one block per host: the payload
 * the host writes to a hook's stdin, read into the neutral event, and the
 * exact bytes the host reads back off the hook's stdout. A key renamed,
 * reordered or wrapped is context the model never sees, or a decision the host
 * ignores, and nothing else would fail.
 *
 * The Cursor and Gemini CLI payloads are the ones the plugins' own tests feed
 * their hooks, field for field; only each test's temporary repo is spelled
 * here as a fixed path (/ws/repo).
 */

const REPO = "/ws/repo";

/**
 * ix-cursor-plugin mcp/tests/helpers/cursor-hooks.ts `commonInput`: the
 * fields every Cursor agent hook receives ("Input (all hooks)").
 */
function cursorCommon(event: string, workspaceRoots: string[] = [REPO]): Record<string, unknown> {
  return {
    conversation_id: "conv-1",
    generation_id: "gen-1",
    model: "test-model",
    hook_event_name: event,
    cursor_version: "test",
    workspace_roots: workspaceRoots,
    user_email: null,
    transcript_path: null,
  };
}

/**
 * Each event the Cursor plugin registers (its hooks/hooks.json), with the
 * event fields its tests send: mcp/tests/integration/plugin-success-loop.test.ts
 * (Write, Grep, Shell) and mcp/tests/real-ix/hooks.real-ix.ts (sessionStart,
 * afterFileEdit, stop).
 */
const CURSOR = {
  sessionStart: cursorCommon("sessionStart"),
  preToolUseGrep: {
    ...cursorCommon("preToolUse"),
    tool_name: "Grep", tool_input: { pattern: "SessionManager", path: `${REPO}/src` }, tool_use_id: "tu-2", cwd: REPO,
  },
  postToolUseGrep: {
    ...cursorCommon("postToolUse"),
    tool_name: "Grep", tool_input: { pattern: "SessionManager", path: `${REPO}/src` }, tool_use_id: "tu-2", cwd: REPO,
  },
  postToolUseWrite: {
    ...cursorCommon("postToolUse"),
    tool_name: "Write", tool_input: { file_path: `${REPO}/src/shared.ts` }, tool_use_id: "tu-1", cwd: REPO,
  },
  postToolUseShell: {
    ...cursorCommon("postToolUse"),
    tool_name: "Shell",
    tool_input: { command: "rg SessionManager src", working_directory: REPO },
    tool_output: "{\"exitCode\":0}",
    tool_use_id: "tu-3",
    cwd: REPO,
  },
  afterFileEdit: { ...cursorCommon("afterFileEdit"), file_path: `${REPO}/widget.ts` },
  stop: cursorCommon("stop", [REPO, "/ws/lib"]),
};

/**
 * ix-cursor-plugin mcp/tests/helpers/cursor-hooks.ts `OUTPUT_FIELDS`: the
 * output fields Cursor reads on each agent hook event (cursor.com/docs/hooks,
 * "Hook events"). Empty: Cursor ignores the output.
 */
const CURSOR_OUTPUT_FIELDS: Record<string, readonly string[]> = {
  sessionStart: ["env", "additional_context"],
  sessionEnd: [],
  preToolUse: ["permission", "user_message", "agent_message", "updated_input"],
  postToolUse: ["updated_mcp_tool_output", "additional_context"],
  postToolUseFailure: ["additional_context"],
  subagentStart: ["permission", "user_message"],
  subagentStop: ["followup_message"],
  beforeShellExecution: ["permission", "user_message", "agent_message"],
  afterShellExecution: [],
  beforeMCPExecution: ["permission", "user_message", "agent_message"],
  afterMCPExecution: [],
  beforeReadFile: ["permission", "user_message"],
  afterFileEdit: [],
  beforeSubmitPrompt: ["continue", "user_message"],
  preCompact: ["user_message"],
  stop: ["followup_message"],
  afterAgentResponse: [],
  afterAgentThought: [],
};

/**
 * ix-cursor-plugin cursor-hooks.ts `modelVisibleText`: what of a hook's output
 * Cursor puts in front of the model on `event`.
 */
function cursorModelVisibleText(event: string, output: Record<string, unknown>): string {
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (event) {
    case "sessionStart":
    case "postToolUse":
    case "postToolUseFailure":
      return text(output.additional_context);
    case "preToolUse":
      return output.permission === "deny" ? text(output.agent_message) : "";
    default:
      return "";
  }
}

/** A hook's stdout as Cursor reads it: no output is an empty answer. */
function cursorOutput(stdout: string): Record<string, unknown> {
  return stdout === "" ? {} : JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * ix-gemini-plugin hooks/tests/test_host_protocol.py `_HookRun.run_hook`: the
 * fields under every event the plugin's tests send its hooks.
 */
const GEMINI_BASE = { session_id: "s-1", transcript_path: "", cwd: REPO, timestamp: "2026-10-01T00:00:00Z" };

/** Events from test_host_protocol.py (ContextHooksTest, NativeWriteToolsTest). */
const GEMINI = {
  sessionStart: { ...GEMINI_BASE, hook_event_name: "SessionStart", source: "startup" },
  beforeAgent: { ...GEMINI_BASE, hook_event_name: "BeforeAgent", prompt: "hi" },
  afterToolShellGrep: {
    ...GEMINI_BASE,
    hook_event_name: "AfterTool",
    tool_name: "run_shell_command",
    tool_input: { command: "grep -rn verify_token src" },
    tool_response: { llmContent: "src/x.py:1:verify_token" },
  },
  afterToolWriteFile: {
    ...GEMINI_BASE,
    hook_event_name: "AfterTool",
    tool_name: "write_file",
    tool_input: { file_path: `${REPO}/src/new.py`, content: "x = 1\n" },
    tool_response: { llmContent: "ok" },
  },
  afterToolReplace: {
    ...GEMINI_BASE,
    hook_event_name: "AfterTool",
    tool_name: "replace",
    tool_input: { file_path: `${REPO}/src/x.py`, content: "x = 1\n" },
    tool_response: { llmContent: "ok" },
  },
  afterToolReplaceRelative: {
    ...GEMINI_BASE,
    hook_event_name: "AfterTool",
    tool_name: "replace",
    tool_input: { file_path: "src/x.py", content: "x = 1\n" },
    tool_response: { llmContent: "ok" },
  },
};

function read(adapter: HostAdapter, payload: unknown): HookEvent {
  const ev = adapter.readEvent(JSON.stringify(payload));
  if (!ev) throw new Error(`${adapter.id} read nothing from ${JSON.stringify(payload)}`);
  return ev;
}

describe("host adapter registry: three hosts", () => {
  it("has Claude Code, Cursor and Gemini CLI under the names `--host` takes", () => {
    expect(HOST_ADAPTERS.map((a) => a.id)).toEqual(["claude", "cursor", "gemini"]);
    expect(hostAdapter("cursor")).toBe(cursorAdapter);
    expect(hostAdapter("gemini")).toBe(geminiCliAdapter);
    expect(hostAdapter("codex")).toBeUndefined();
  });

  it("every adapter reads nothing from input that is not a JSON object", () => {
    for (const adapter of HOST_ADAPTERS) {
      for (const raw of ["", "not json", "null", "42", '"str"', "true"]) {
        expect({ host: adapter.id, raw, ev: adapter.readEvent(raw) }).toEqual({ host: adapter.id, raw, ev: undefined });
      }
    }
  });

  it("every adapter's output on an event its host reads is one line of JSON", () => {
    const events: Record<string, { context: string; decision: string }> = {
      claude: { context: "PostToolUse", decision: "PreToolUse" },
      cursor: { context: "postToolUse", decision: "preToolUse" },
      gemini: { context: "AfterTool", decision: "BeforeTool" },
    };
    for (const adapter of HOST_ADAPTERS) {
      const { context, decision } = events[adapter.id]!;
      for (const out of [
        adapter.writeContext(context, "a\nb"),
        adapter.writeDecision(decision, "deny", "a\nb"),
        adapter.writeDecision(decision, "allow"),
      ]) {
        expect(out).not.toContain("\n");
        expect(() => JSON.parse(out) as unknown).not.toThrow();
      }
    }
  });
});

describe("Claude Code adapter: project and decision", () => {
  it("names the payload's cwd as the project, else CLAUDE_PROJECT_DIR", () => {
    expect(claudeCodeAdapter.projectDirs(read(claudeCodeAdapter, { cwd: "/ws", workspace_roots: ["/other"] }))).toEqual(["/ws"]);
    expect(claudeCodeAdapter.projectDirs(read(claudeCodeAdapter, { session_id: "s" }))).toEqual([]);
    expect(claudeCodeAdapter.projectDirEnv).toBe("CLAUDE_PROJECT_DIR");
  });

  it("writes a PreToolUse permission decision, byte for byte", () => {
    expect(claudeCodeAdapter.writeDecision("PreToolUse", "deny", "Ix: src/a.ts is generated."))
      .toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Ix: src/a.ts is generated."}}');
    expect(claudeCodeAdapter.writeDecision("PreToolUse", "allow"))
      .toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}');
  });
});

describe("Cursor adapter: input, from the plugin's payloads", () => {
  it("reads a postToolUse Write payload, naming the written file", () => {
    const p = CURSOR.postToolUseWrite;
    expect(read(cursorAdapter, p)).toStrictEqual({
      host: "cursor", event: "postToolUse", cwd: REPO, sessionId: "conv-1", toolName: "Write",
      editedPaths: [`${REPO}/src/shared.ts`], prompt: undefined, payload: p,
    });
  });

  it("reads an afterFileEdit payload, naming the edited file", () => {
    const p = CURSOR.afterFileEdit;
    expect(read(cursorAdapter, p)).toStrictEqual({
      host: "cursor", event: "afterFileEdit", cwd: REPO, sessionId: "conv-1", toolName: undefined,
      editedPaths: [`${REPO}/widget.ts`], prompt: undefined, payload: p,
    });
  });

  it("names no edited file for the plugin's Grep, Shell, sessionStart and stop payloads", () => {
    for (const [name, p] of Object.entries({
      preToolUseGrep: CURSOR.preToolUseGrep,
      postToolUseGrep: CURSOR.postToolUseGrep,
      postToolUseShell: CURSOR.postToolUseShell,
      sessionStart: CURSOR.sessionStart,
      stop: CURSOR.stop,
    })) {
      const ev = read(cursorAdapter, p);
      expect({ name, event: ev.event, cwd: ev.cwd, sessionId: ev.sessionId, editedPaths: ev.editedPaths })
        .toEqual({ name, event: (p as Record<string, unknown>).hook_event_name, cwd: REPO, sessionId: "conv-1", editedPaths: [] });
    }
    expect(read(cursorAdapter, CURSOR.postToolUseShell).toolName).toBe("Shell");
  });

  it("reads a Write tool's file from tool_input.path when file_path is missing, as the plugin's edit-impact does", () => {
    const p = { ...CURSOR.postToolUseWrite, tool_input: { path: `${REPO}/src/b.ts` } };
    expect(read(cursorAdapter, p).editedPaths).toEqual([`${REPO}/src/b.ts`]);
    expect(read(cursorAdapter, { ...p, hook_event_name: "preToolUse" }).editedPaths).toEqual([`${REPO}/src/b.ts`]);
  });

  it("names no Write file on a failed write, a non-tool event, or a tool that does not write", () => {
    const w = CURSOR.postToolUseWrite;
    expect(read(cursorAdapter, { ...w, hook_event_name: "postToolUseFailure" }).editedPaths).toEqual([]);
    expect(read(cursorAdapter, { ...w, hook_event_name: "beforeShellExecution" }).editedPaths).toEqual([]);
    expect(read(cursorAdapter, { ...w, hook_event_name: undefined }).editedPaths).toEqual([]);
    for (const tool_name of ["Read", "Delete", "Grep", "write"]) {
      expect(read(cursorAdapter, { ...w, tool_name }).editedPaths).toEqual([]);
    }
    expect(read(cursorAdapter, { ...w, tool_input: { file_path: "" } }).editedPaths).toEqual([]);
    expect(read(cursorAdapter, { ...w, tool_input: { file_path: 7 } }).editedPaths).toEqual([]);
    expect(read(cursorAdapter, { ...w, tool_input: "x" }).editedPaths).toEqual([]);
  });

  it("names a top-level file_path as edited only on a file-edit event", () => {
    for (const hook_event_name of ["beforeReadFile", "beforeShellExecution", "postToolUse", "stop", undefined]) {
      expect(read(cursorAdapter, { hook_event_name, file_path: "/ws/app/a.ts" }).editedPaths).toEqual([]);
    }
    expect(read(cursorAdapter, { hook_event_name: "afterTabFileEdit", file_path: "/ws/app/a.ts" }).editedPaths)
      .toEqual(["/ws/app/a.ts"]);
    expect(read(cursorAdapter, { hook_event_name: "afterFileEdit", file_path: "" }).editedPaths).toEqual([]);
    expect(read(cursorAdapter, { hook_event_name: "afterFileEdit", file_path: 7 }).editedPaths).toEqual([]);
  });

  it("reads a beforeSubmitPrompt prompt", () => {
    const ev = read(cursorAdapter, { ...cursorCommon("beforeSubmitPrompt"), prompt: "why does add fail?" });
    expect([ev.event, ev.prompt, ev.editedPaths]).toEqual(["beforeSubmitPrompt", "why does add fail?", []]);
  });

  it("takes the first workspace root as the cwd, else the payload's cwd", () => {
    expect(read(cursorAdapter, { ...cursorCommon("postToolUse", ["/ws/app", "/ws/lib"]), cwd: "/ws/lib" }).cwd).toBe("/ws/app");
    expect(read(cursorAdapter, { hook_event_name: "beforeShellExecution", cwd: "/ws/x" }).cwd).toBe("/ws/x");
    expect(read(cursorAdapter, { workspace_roots: [7, "/ws/y"], cwd: "/ws/x" }).cwd).toBe("/ws/y");
    expect(read(cursorAdapter, { cwd: 7 }).cwd).toBeUndefined();
  });

  it("keys a non-string conversation id as a string", () => {
    expect(read(cursorAdapter, { conversation_id: 42 }).sessionId).toBe("42");
    expect(read(cursorAdapter, { conversation_id: null }).sessionId).toBeUndefined();
  });
});

describe("Cursor adapter: project", () => {
  it("names every workspace root the payload lists, else CURSOR_PROJECT_DIR", () => {
    expect(cursorAdapter.projectDirs(read(cursorAdapter, CURSOR.stop))).toEqual([REPO, "/ws/lib"]);
    expect(cursorAdapter.projectDirs(read(cursorAdapter, { workspace_roots: ["/ws/a", 7, null, "rel"], cwd: "/ws/c" })))
      .toEqual(["/ws/a", "rel"]);
    // A shell command's cwd is not a statement about where the project is.
    expect(cursorAdapter.projectDirs(read(cursorAdapter, { cwd: "/ws/c" }))).toEqual([]);
    expect(cursorAdapter.projectDirs(read(cursorAdapter, { workspace_roots: "/ws/a" }))).toEqual([]);
    expect(cursorAdapter.projectDirEnv).toBe("CURSOR_PROJECT_DIR");
  });
});

describe("Cursor adapter: output, against the fields Cursor reads per event", () => {
  it("writes additional_context on sessionStart and postToolUse(Failure), byte for byte", () => {
    expect(cursorAdapter.writeContext("postToolUse", "Ix: you changed add."))
      .toBe('{"additional_context":"Ix: you changed add."}');
    expect(cursorAdapter.writeContext("sessionStart", "a\n\"b\""))
      .toBe('{"additional_context":"a\\n\\"b\\""}');
    expect(cursorAdapter.writeContext("postToolUseFailure", "x")).toBe('{"additional_context":"x"}');
  });

  it("writes nothing for context on an event where Cursor reads none", () => {
    for (const event of ["preToolUse", "beforeSubmitPrompt", "afterFileEdit", "stop", "beforeShellExecution", "E"]) {
      expect({ event, out: cursorAdapter.writeContext(event, "ctx") }).toEqual({ event, out: "" });
    }
  });

  it("puts the context in front of the model exactly where Cursor shows context, on every event", () => {
    for (const event of Object.keys(CURSOR_OUTPUT_FIELDS)) {
      const output = cursorOutput(cursorAdapter.writeContext(event, "ctx"));
      const extra = Object.keys(output).filter((k) => !CURSOR_OUTPUT_FIELDS[event]!.includes(k));
      expect({ event, extra }).toEqual({ event, extra: [] });
      const shown = ["sessionStart", "postToolUse", "postToolUseFailure"].includes(event) ? "ctx" : "";
      expect({ event, text: cursorModelVisibleText(event, output) }).toEqual({ event, text: shown });
    }
  });

  it("writes only fields Cursor reads for every decision on every event", () => {
    for (const event of Object.keys(CURSOR_OUTPUT_FIELDS)) {
      for (const decision of ["allow", "deny", "ask"] as const) {
        const output = cursorOutput(cursorAdapter.writeDecision(event, decision, "why"));
        const extra = Object.keys(output).filter((k) => !CURSOR_OUTPUT_FIELDS[event]!.includes(k));
        expect({ event, decision, extra }).toEqual({ event, decision, extra: [] });
      }
    }
  });

  it("writes a preToolUse decision as allow or deny, the reason reaching the agent on deny, byte for byte", () => {
    expect(cursorAdapter.writeDecision("preToolUse", "deny", "Ix: run ix map first."))
      .toBe('{"permission":"deny","user_message":"Ix: run ix map first.","agent_message":"Ix: run ix map first."}');
    expect(cursorModelVisibleText("preToolUse", cursorOutput(cursorAdapter.writeDecision("preToolUse", "deny", "why")))).toBe("why");
    expect(cursorAdapter.writeDecision("preToolUse", "allow", "fine")).toBe('{"permission":"allow"}');
    // preToolUse cannot ask the user: the action does not go ahead unasked.
    expect(cursorAdapter.writeDecision("preToolUse", "ask", "Check this."))
      .toBe('{"permission":"deny","user_message":"Check this.","agent_message":"Check this."}');
  });

  it("keeps ask on the shell and MCP events, which take it, byte for byte", () => {
    expect(cursorAdapter.writeDecision("beforeShellExecution", "ask", "Check this."))
      .toBe('{"permission":"ask","user_message":"Check this.","agent_message":"Check this."}');
    expect(cursorAdapter.writeDecision("beforeMCPExecution", "deny", "No."))
      .toBe('{"permission":"deny","user_message":"No.","agent_message":"No."}');
  });

  it("writes no agent_message where Cursor reads none, byte for byte", () => {
    expect(cursorAdapter.writeDecision("beforeReadFile", "deny", "Ix: generated file."))
      .toBe('{"permission":"deny","user_message":"Ix: generated file."}');
    expect(cursorAdapter.writeDecision("beforeReadFile", "allow")).toBe('{"permission":"allow"}');
    expect(cursorAdapter.writeDecision("subagentStart", "ask", "x")).toBe('{"permission":"deny","user_message":"x"}');
  });

  it("answers beforeSubmitPrompt with continue and user_message, byte for byte", () => {
    expect(cursorAdapter.writeDecision("beforeSubmitPrompt", "allow")).toBe('{"continue":true}');
    expect(cursorAdapter.writeDecision("beforeSubmitPrompt", "deny", "Ix: map first."))
      .toBe('{"continue":false,"user_message":"Ix: map first."}');
  });

  it("writes nothing for a decision on an event that takes none", () => {
    for (const event of ["postToolUse", "afterFileEdit", "stop", "sessionStart", "E"]) {
      expect({ event, out: cursorAdapter.writeDecision(event, "deny", "x") }).toEqual({ event, out: "" });
    }
  });
});

describe("Gemini CLI adapter: input, from the plugin's payloads", () => {
  it("reads an AfterTool replace payload into the neutral event", () => {
    const p = GEMINI.afterToolReplace;
    expect(read(geminiCliAdapter, p)).toStrictEqual({
      host: "gemini", event: "AfterTool", cwd: REPO, sessionId: "s-1", toolName: "replace",
      editedPaths: [`${REPO}/src/x.py`], prompt: undefined, payload: p,
    });
  });

  it("names write_file's path, and a relative path as the host gave it", () => {
    expect(read(geminiCliAdapter, GEMINI.afterToolWriteFile).editedPaths).toEqual([`${REPO}/src/new.py`]);
    expect(read(geminiCliAdapter, GEMINI.afterToolReplaceRelative).editedPaths).toEqual(["src/x.py"]);
  });

  it("names no edited path for a tool that does not edit", () => {
    expect(read(geminiCliAdapter, GEMINI.afterToolShellGrep).editedPaths).toEqual([]);
    for (const tool_name of ["read_file", "glob", "search_file_content", "Edit"]) {
      expect(read(geminiCliAdapter, { tool_name, tool_input: { file_path: "/ws/a.ts" } }).editedPaths).toEqual([]);
    }
  });

  it("reads a BeforeAgent prompt", () => {
    const ev = read(geminiCliAdapter, GEMINI.beforeAgent);
    expect([ev.event, ev.prompt]).toEqual(["BeforeAgent", "hi"]);
  });

  it("reads a SessionStart payload", () => {
    const ev = read(geminiCliAdapter, GEMINI.sessionStart);
    expect([ev.event, ev.cwd, ev.sessionId, ev.editedPaths]).toEqual(["SessionStart", REPO, "s-1", []]);
  });

  it("ignores a cwd that is not a string", () => {
    expect(read(geminiCliAdapter, { cwd: 7 }).cwd).toBeUndefined();
  });
});

describe("Gemini CLI adapter: project", () => {
  it("names the payload's cwd as the project, else GEMINI_PROJECT_DIR", () => {
    expect(geminiCliAdapter.projectDirs(read(geminiCliAdapter, GEMINI.sessionStart))).toEqual([REPO]);
    expect(geminiCliAdapter.projectDirs(read(geminiCliAdapter, { workspace_roots: ["/ws/b"] }))).toEqual([]);
    expect(geminiCliAdapter.projectDirEnv).toBe("GEMINI_PROJECT_DIR");
  });
});

describe("Gemini CLI adapter: output", () => {
  /** test_host_protocol.py `model_context`: Gemini reads only hookSpecificOutput.additionalContext. */
  function geminiModelContext(output: Record<string, unknown>): string | undefined {
    const specific = output.hookSpecificOutput as Record<string, unknown> | undefined;
    const context = specific?.additionalContext;
    return typeof context === "string" ? context : undefined;
  }

  it("writes additional context as hookSpecificOutput, byte for byte", () => {
    expect(geminiCliAdapter.writeContext("AfterTool", "Ix: you changed add."))
      .toBe('{"hookSpecificOutput":{"hookEventName":"AfterTool","additionalContext":"Ix: you changed add."}}');
    expect(geminiCliAdapter.writeContext("BeforeAgent", "a\n\"b\""))
      .toBe('{"hookSpecificOutput":{"hookEventName":"BeforeAgent","additionalContext":"a\\n\\"b\\""}}');
  });

  it("passes the plugin's host-protocol check on each event that hands context to the model", () => {
    for (const event of ["SessionStart", "BeforeAgent", "AfterTool"]) {
      const output = JSON.parse(geminiCliAdapter.writeContext(event, "ctx")) as Record<string, unknown>;
      expect((output.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe(event);
      expect(output).not.toHaveProperty("additionalContext");
      expect(output).not.toHaveProperty("systemMessage");
      expect(geminiModelContext(output)).toBe("ctx");
    }
  });

  it("writes a decision with its reason, byte for byte", () => {
    expect(geminiCliAdapter.writeDecision("BeforeTool", "deny", "Ix: src/a.ts is generated."))
      .toBe('{"decision":"deny","reason":"Ix: src/a.ts is generated."}');
    expect(geminiCliAdapter.writeDecision("BeforeTool", "allow")).toBe('{"decision":"allow"}');
  });
});

describe("ix hook auto-map --host: the project, through each host's adapter", () => {
  const env = { HOME: "/nowhere" };

  it("maps the directories each host's payload names", () => {
    expect(autoMapProjectDirs({ host: "cursor" }, JSON.stringify(CURSOR.stop), env, "/proc")).toEqual([REPO, "/ws/lib"]);
    expect(autoMapProjectDirs({ host: "gemini" }, JSON.stringify(GEMINI.sessionStart), env, "/proc")).toEqual([REPO]);
    expect(autoMapProjectDirs({ host: "claude" }, JSON.stringify({ session_id: "s", cwd: REPO, hook_event_name: "Stop" }), env, "/proc"))
      .toEqual([REPO]);
  });

  it("falls back to each adapter's project variable", () => {
    for (const adapter of HOST_ADAPTERS) {
      expect(adapter.projectDirEnv).toMatch(/^[A-Z_]+_PROJECT_DIR$/);
      expect(autoMapProjectDirs({ host: adapter.id }, "{}", { [adapter.projectDirEnv!]: "/ws/env" }, "/proc")).toEqual(["/ws/env"]);
    }
  });
});
