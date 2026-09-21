// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { updateCheckEnabled } from "../commands/upgrade.js";

/** A terminal session with nothing special set. */
const tty = (argv: string[], env: NodeJS.ProcessEnv = {}) => updateCheckEnabled(argv, env, true);
/** Anything capturing stderr: an agent, a pipe, a CI log. */
const captured = (argv: string[], env: NodeJS.ProcessEnv = {}) => updateCheckEnabled(argv, env, false);

describe("updateCheckEnabled", () => {
  it("runs for an ordinary command at a terminal", () => {
    expect(tty(["status"])).toBe(true);
    expect(tty(["context", "resolveWorkspaceRoot"])).toBe(true);
  });

  it("does not run when stderr is captured", () => {
    // The case that matters: an agent runs `ix <cmd> 2>&1` and the notice
    // lands at the top of every tool result it reads.
    expect(captured(["status"])).toBe(false);
  });

  it("does not run when a machine-readable format was asked for", () => {
    for (const format of ["llm", "json"]) {
      expect(tty(["search", "Widget", "--format", format])).toBe(false);
      expect(tty(["search", "Widget", `--format=${format}`])).toBe(false);
    }
  });

  it("still runs for an explicit --format text", () => {
    expect(tty(["search", "Widget", "--format", "text"])).toBe(true);
    expect(tty(["search", "Widget", "--format=text"])).toBe(true);
  });

  it("leaves the check on when --format has no value to read", () => {
    // commander reports the error; the gate should not guess.
    expect(tty(["search", "Widget", "--format"])).toBe(true);
  });

  it("honours IX_NO_UPDATE_CHECK", () => {
    for (const value of ["1", "true", "TRUE", "yes"]) {
      expect(tty(["status"], { IX_NO_UPDATE_CHECK: value })).toBe(false);
    }
  });

  it("treats an empty or falsy IX_NO_UPDATE_CHECK as unset", () => {
    for (const value of ["", "0", "false", " "]) {
      expect(tty(["status"], { IX_NO_UPDATE_CHECK: value })).toBe(true);
    }
  });

  it("keeps the existing exemptions", () => {
    // `upgrade` reports versions itself; `mcp` speaks JSON-RPC on stdio, where
    // a stray notice is a protocol error.
    expect(tty(["upgrade"])).toBe(false);
    expect(tty(["mcp"])).toBe(false);
    expect(tty(["status"], { IX_MCP_CHILD: "1" })).toBe(false);
  });

  it("does not mistake another flag's value for a format", () => {
    expect(tty(["text", "--format-ish", "json"])).toBe(true);
    expect(tty(["search", "--path", "--format"])).toBe(true);
  });
});
