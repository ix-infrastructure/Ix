// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerHookCommand } from "../commands/hook.js";
import { HOST_ADAPTERS, hostAdapter } from "../hook/host.js";
import { claudeCodeAdapter } from "../hook/hosts/claude.js";
import { postToolUseOutput } from "../hook/io.js";
import { hookStateDir, statePath } from "../hook/session.js";
import { HOOK_SUBCOMMANDS, hookSubcommand } from "../hook/subcommands.js";

/**
 * The hook layer's contract with the agent hosts. Claude Code reads exactly
 * `{"hookSpecificOutput":{"hookEventName":...,"additionalContext":...}}` off a
 * hook's stdout; a key renamed, reordered or wrapped is context the model
 * never sees, and nothing else would fail.
 */

describe("Claude Code adapter: output", () => {
  it("writes additional context as hookSpecificOutput, byte for byte", () => {
    expect(claudeCodeAdapter.writeContext("PostToolUse", "Ix: you changed add."))
      .toBe('{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Ix: you changed add."}}');
    expect(claudeCodeAdapter.writeContext("UserPromptSubmit", "a\n\"b\""))
      .toBe('{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"a\\n\\"b\\""}}');
  });

  it("is one JSON object with exactly that shape", () => {
    const parsed = JSON.parse(claudeCodeAdapter.writeContext("PostToolUse", "x")) as Record<string, unknown>;
    expect(parsed).toStrictEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } });
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput as object)).toEqual(["hookEventName", "additionalContext"]);
  });

  it("is what claude-post-edit prints", () => {
    expect(postToolUseOutput("ctx")).toBe(claudeCodeAdapter.writeContext("PostToolUse", "ctx"));
  });
});

describe("Claude Code adapter: input", () => {
  it("reads a PostToolUse payload into the neutral event", () => {
    const payload = {
      session_id: "s1", hook_event_name: "PostToolUse", cwd: "/ws", tool_name: "Edit",
      tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
      tool_response: { filePath: "/ws/src/a.ts" },
    };
    expect(claudeCodeAdapter.readEvent(JSON.stringify(payload))).toStrictEqual({
      host: "claude", event: "PostToolUse", cwd: "/ws", sessionId: "s1", toolName: "Edit",
      editedPaths: ["src/a.ts"], prompt: undefined, payload,
    });
  });

  it("takes the edited path from the tool response when the input has none", () => {
    const ev = claudeCodeAdapter.readEvent(JSON.stringify({ tool_name: "Write", tool_response: { filePath: "/ws/b.ts" } }));
    expect(ev?.editedPaths).toEqual(["/ws/b.ts"]);
  });

  it("names no edited path for a tool that does not edit", () => {
    for (const tool_name of ["Read", "Bash", "Grep"]) {
      expect(claudeCodeAdapter.readEvent(JSON.stringify({ tool_name, tool_input: { file_path: "/ws/a.ts" } }))?.editedPaths)
        .toEqual([]);
    }
  });

  it("reads a UserPromptSubmit prompt", () => {
    const ev = claudeCodeAdapter.readEvent(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "fix it" }));
    expect(ev?.prompt).toBe("fix it");
    expect(ev?.event).toBe("UserPromptSubmit");
  });

  it("keys a non-string session id as claude-post-edit always has", () => {
    expect(claudeCodeAdapter.readEvent('{"session_id":42}')?.sessionId).toBe("42");
    expect(claudeCodeAdapter.readEvent('{"session_id":null}')?.sessionId).toBeUndefined();
  });

  it("reads nothing from input that is not a JSON object, or has a cwd that is not a path", () => {
    for (const raw of ["", "not json", "null", "42", '"str"', '{"cwd":7}']) {
      expect(claudeCodeAdapter.readEvent(raw)).toBeUndefined();
    }
    // An array is an object to the hook, as it always was: it just carries no fields.
    expect(claudeCodeAdapter.readEvent("[]")?.editedPaths).toEqual([]);
  });
});

describe("host adapter registry", () => {
  it("finds each adapter by its id, and nothing else", () => {
    for (const adapter of HOST_ADAPTERS) expect(hostAdapter(adapter.id)).toBe(adapter);
    expect(hostAdapter("claude")).toBe(claudeCodeAdapter);
    expect(hostAdapter("nope")).toBeUndefined();
    expect(hostAdapter("toString")).toBeUndefined();
    expect(new Set(HOST_ADAPTERS.map((a) => a.id)).size).toBe(HOST_ADAPTERS.length);
  });
});

describe("hook subcommands: one list", () => {
  it("main.ts dispatches exactly the subcommands `ix hook` registers", () => {
    const program = new Command();
    registerHookCommand(program);
    const hook = program.commands.find((c) => c.name() === "hook")!;
    expect(hook.commands.map((c) => c.name()).sort()).toEqual(Object.keys(HOOK_SUBCOMMANDS).sort());
  });

  it("knows claude-post-edit, and no inherited or unknown name", () => {
    expect(hookSubcommand("claude-post-edit")).toBeTypeOf("function");
    for (const name of [undefined, "", "bogus", "toString", "__proto__", "constructor"]) {
      expect(hookSubcommand(name)).toBeUndefined();
    }
  });
});

describe("hook state", () => {
  it("lives under <IX_HOME>/hook-state unless IX_HOOK_STATE_DIR says otherwise", () => {
    expect(hookStateDir({ IX_HOME: "/h" })).toBe(join("/h", "hook-state"));
    expect(hookStateDir({ IX_HOME: "/h", IX_HOOK_STATE_DIR: "/s" })).toBe("/s");
    expect(statePath("s1", "/ws", { IX_HOME: "/h" }).startsWith(join("/h", "hook-state"))).toBe(true);
  });
});

describe("a hook subcommand as a process", () => {
  const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "../main.ts");
  const TSX = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("tsx")).href;

  function run(args: string[], input: string, home: string, cwd: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, IX_HOME: home, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1", IX_ENDPOINT: "http://127.0.0.1:1" };
    for (const k of ["FORCE_COLOR", "IX_FORMAT", "IX_HOOK_STATE_DIR", "IX_HOOK_DEBUG", "IX_HOOK_LOG"]) delete env[k];
    return spawnSync(process.execPath, ["--import", TSX, MAIN, ...args], { input, env, cwd, encoding: "utf-8", timeout: 60_000 });
  }

  it("exits 0 and prints nothing for any input it has nothing to say about", () => {
    const home = mkdtempSync(join(tmpdir(), "ix-hook-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "ix-hook-cwd-"));
    try {
      for (const input of ["", "not json", "{}", '{"cwd":7}', JSON.stringify({ session_id: "s", cwd, tool_name: "Bash" })]) {
        const r = run(["hook", "claude-post-edit"], input, home, cwd);
        expect({ input, status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ input, status: 0, stdout: "", stderr: "" });
      }
      // Nothing was edited, so nothing was remembered.
      expect(readdirSync(home).filter((n) => n === "hook-state")).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
