// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerReadCommand } from "../commands/read.js";

/**
 * `ix read <file>` had no bound at all. Recorded reads ran 20,000 to 53,000
 * tokens, on a target whose size the caller cannot see before asking.
 */
describe("ix read line cap", () => {
  let root: string;
  let logs: string[];
  let errs: string[];
  let originalCwd: string;

  const BIG = Array.from({ length: 1734 }, (_, i) => `line ${i + 1}`).join("\n");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ix-read-cap-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "big.ts"), BIG);
    writeFileSync(join(root, "src", "small.ts"), "one\ntwo\nthree");
    originalCwd = process.cwd();
    process.chdir(root);
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  async function read(args: string[]): Promise<void> {
    const program = new Command();
    program.name("ix").exitOverride();
    registerReadCommand(program);
    await program.parseAsync(["read", ...args, "--root", root], { from: "user" });
  }

  it("stops at 400 lines and says how to get the next 400", async () => {
    await read(["src/big.ts", "--format", "llm"]);
    expect(logs[0]).toContain("line_start=1 line_end=400");
    expect(logs[0]).toContain("truncated=true");
    expect(logs[0]).toContain("total_lines=1734");
    expect(logs[0]).toContain("next=src/big.ts:401-800");
    expect(logs[1]).toBe("content lines=400");
  });

  it("--all restores the whole file", async () => {
    await read(["src/big.ts", "--all", "--format", "llm"]);
    expect(logs[0]).toContain("line_end=1734");
    expect(logs[0]).not.toContain("truncated=");
    expect(logs[0]).not.toContain("next=");
  });

  it("never caps a range the caller typed", async () => {
    // They said what they wanted; 900 lines is an answer to a question asked.
    await read(["src/big.ts:1-900", "--format", "llm"]);
    expect(logs[0]).toContain("line_end=900");
    expect(logs[0]).not.toContain("truncated=true");
  });

  it("leaves a file that fits alone", async () => {
    await read(["src/small.ts", "--format", "llm"]);
    expect(logs[0]).toContain("line_end=3");
    expect(logs[0]).not.toContain("truncated=");
  });

  it("carries the cursor into json", async () => {
    await read(["src/big.ts", "--format", "json"]);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload).toMatchObject({
      lineStart: 1, lineEnd: 400, truncated: true, totalLines: 1734,
      next: "src/big.ts:401-800",
    });
  });

  it("tells a person what they are missing, on stderr", async () => {
    await read(["src/big.ts"]);
    const note = errs.join("");
    expect(note).toContain("400 of 1734 lines");
    expect(note).toContain("ix read src/big.ts:401-800");
    expect(note).toContain("--all");
    // The source itself is still on stdout, all 400 lines of it.
    expect(logs).toHaveLength(400);
  });

  it("keeps the cursor relative when the root is reached through a symlink", async () => {
    // macOS resolves `/var` to `/private/var`, so `process.cwd()` and a path
    // built from `--root` disagree about a link on every temp-dir run there;
    // any repo under a `~/code` symlink does the same on Linux. A prefix match
    // against cwd misses, and the cursor used to come back absolute.
    const linked = join(originalCwd === root ? tmpdir() : tmpdir(), `ix-read-cap-link-${process.pid}`);
    rmSync(linked, { force: true });
    symlinkSync(root, linked, "dir");
    try {
      const program = new Command();
      program.name("ix").exitOverride();
      registerReadCommand(program);
      await program.parseAsync(["read", "src/big.ts", "--format", "llm", "--root", linked], { from: "user" });
      expect(logs[0]).toContain("next=src/big.ts:401-800");
    } finally {
      rmSync(linked, { force: true });
    }
  });

  it("does not offer a next page from the last one", async () => {
    await read(["src/big.ts:1400-1734", "--format", "llm"]);
    expect(logs[0]).not.toContain("next=");
  });
});
