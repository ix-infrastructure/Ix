// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capSpan, registerReadCommand } from "../commands/read.js";

// Symbol reads resolve through the graph; these stand in for it. The spreads
// keep every other export real, so the file-read cases below are unaffected.
const graph = vi.hoisted(() => ({ node: {} as Record<string, unknown> }));

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

vi.mock("../resolve.js", async (orig) => ({
  ...(await orig<typeof import("../resolve.js")>()),
  resolveEntityFull: vi.fn(async () => ({ resolved: true, entity: { id: "e1" } })),
  ensureReadScope: async () => {},
  activeReadScope: () => ({}),
}));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async entity() { return { node: graph.node, claims: [], edges: [] }; }
  },
}));

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
    expect(logs[0]).not.toContain("span_end=");
    expect(logs[1]).toBe("content lines=400 numbered=true");
    expect(logs[2]).toMatch(/^1\t/);
    expect(logs[401]).toMatch(/^400\t/);
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

  it("names a file cursor from the workspace root when run from a subdirectory", async () => {
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "big.ts"), BIG);
    writeFileSync(join(root, "big.ts"), "decoy");
    process.chdir(join(root, "lib"));
    await read(["lib/big.ts", "--format", "llm"]);
    expect(logs[0]).toContain("next=lib/big.ts:401-800");
    logs = [];
    await read(["lib/big.ts:401-800", "--format", "llm"]);
    expect(logs[2]).toBe("401\tline 401");
  });

  it("does not offer a next page from the last one", async () => {
    await read(["src/big.ts:1400-1734", "--format", "llm"]);
    expect(logs[0]).not.toContain("next=");
  });
});

describe("ix read symbol cap", () => {
  let root: string;
  let logs: string[];
  let errs: string[];
  let originalCwd: string;

  const BIG = Array.from({ length: 1734 }, (_, i) => `line ${i + 1}`).join("\n");

  function symbolAt(start: number, end: number, content?: string): void {
    graph.node = {
      name: "bigFn",
      kind: "function",
      attrs: { line_start: start, line_end: end, ...(content ? { content } : {}) },
      provenance: { source_uri: content ? undefined : join(root, "src", "big.ts") },
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ix-read-symcap-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "big.ts"), BIG);
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
    await program.parseAsync(["read", "bigFn", ...args, "--root", root], { from: "user" });
  }

  it("cuts a symbol longer than the cap and gives a cursor", async () => {
    symbolAt(10, 1327);
    await read(["--format", "llm"]);
    expect(logs[0]).toContain("line_start=10 line_end=409");
    expect(logs[0]).toContain("truncated=true");
    expect(logs[0]).toContain("total_lines=1318");
    expect(logs[0]).toContain("span_end=1327");
    expect(logs[0]).toContain("next=src/big.ts:10-1327@410");
    expect(logs[1]).toBe("content lines=400 numbered=true");
    expect(logs[2]).toMatch(/^10\t/);
    expect(logs[401]).toMatch(/^409\t/);
  });

  it("keeps the cursor inside the symbol", async () => {
    symbolAt(1, 500);
    await read(["--format", "llm"]);
    expect(logs[0]).toContain("next=src/big.ts:1-500@401");
  });

  it("leaves a short symbol alone", async () => {
    symbolAt(5, 20);
    await read(["--format", "llm"]);
    expect(logs[0]).toContain("line_end=20");
    expect(logs[0]).not.toContain("truncated=");
    expect(logs[0]).not.toContain("next=");
  });

  it("--all prints the whole symbol", async () => {
    symbolAt(10, 1327);
    await read(["--all", "--format", "llm"]);
    expect(logs[0]).toContain("line_end=1327");
    expect(logs[0]).not.toContain("truncated=");
    expect(logs[0]).not.toContain("next=");
  });

  it("carries the cursor into json", async () => {
    symbolAt(10, 1327);
    await read(["--format", "json"]);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      targetType: "symbol", lineStart: 10, lineEnd: 409, truncated: true, totalLines: 1318,
      spanEnd: 1327, next: "src/big.ts:10-1327@410",
    });
  });

  it("tells a person what they are missing, on stderr", async () => {
    symbolAt(10, 1327);
    await read([]);
    const note = errs.join("");
    expect(note).toContain("400 of 1318 lines");
    expect(note).toContain("ix read src/big.ts:10-1327@410");
    expect(note).toContain("--all");
    expect(note).toContain("whole symbol");
    expect(logs).toHaveLength(400);
  });

  it("returns stored content with no file whole, since it cannot be paged", async () => {
    symbolAt(1, 900, Array.from({ length: 900 }, (_, i) => `c${i}`).join("\n"));
    await read(["--format", "llm"]);
    expect(logs[0]).toContain("line_end=900");
    expect(logs[0]).not.toContain("truncated=");
    expect(logs[0]).not.toContain("next=");
  });

  it("clamps a stale span that runs past EOF, so the cursor stays in the file", async () => {
    // big.ts has 1734 lines; the graph still says the symbol ends at 2000.
    symbolAt(1300, 2000);
    await read(["--format", "llm"]);
    expect(logs[0]).toContain("line_end=1699");
    expect(logs[0]).toContain("total_lines=435");
    expect(logs[0]).toContain("span_end=1734");
    expect(logs[0]).toContain("next=src/big.ts:1300-1734@1700");
  });

  it("does not report truncated when the span only overflows past EOF", async () => {
    symbolAt(1500, 2000);
    await read(["--format", "llm"]);
    expect(logs[0]).toContain("line_end=1734");
    expect(logs[0]).not.toContain("truncated=");
    expect(logs[0]).not.toContain("next=");
  });

  it("capSpan clamps the end to EOF", () => {
    const lines = ["a", "b", "c"];
    expect(capSpan(lines, 2, 9, 400)).toEqual({ content: "b\nc", lineStart: 2, lineEnd: 3 });
    expect(capSpan(lines, 1, 9, 2)).toMatchObject({ lineEnd: 2, truncated: true, totalLines: 3, lastLine: 3 });
    // Resumed from a cursor: the count is still the whole span's.
    expect(capSpan(["a", "b", "c", "d", "e"], 1, 5, 2, 3)).toMatchObject({ content: "c\nd", lineStart: 3, lineEnd: 4, totalLines: 5, lastLine: 5 });
  });

  it("--all help names symbols as well as files", () => {
    const program = new Command();
    registerReadCommand(program);
    const all = program.commands.find((c) => c.name() === "read")!.options.find((o) => o.long === "--all")!;
    expect(all.description).toContain("file or symbol");
  });

  it("follows next= from a symbol read to the symbol's last line", async () => {
    // A plain path:a-b cursor is a typed range, never capped and never given a
    // cursor, so paging used to stop after page 2. Follow every next= instead.
    symbolAt(10, 1327);
    await read(["--format", "json"]);
    const pages: Array<Record<string, unknown>> = [JSON.parse(logs.join("\n"))];
    for (let hops = 0; pages[pages.length - 1].next && hops < 10; hops++) {
      logs = [];
      const program = new Command();
      program.name("ix").exitOverride();
      registerReadCommand(program);
      await program.parseAsync(
        ["read", String(pages[pages.length - 1].next), "--format", "json", "--root", root], { from: "user" });
      pages.push(JSON.parse(logs.join("\n")));
    }
    expect(pages.map((p) => [p.lineStart, p.lineEnd])).toEqual([[10, 409], [410, 809], [810, 1209], [1210, 1327]]);
    expect(pages.map((p) => p.next)).toEqual([
      "src/big.ts:10-1327@410", "src/big.ts:10-1327@810", "src/big.ts:10-1327@1210", undefined,
    ]);
    // Every capped page names the same span: its size and where it ends.
    for (const p of pages.slice(0, 3)) expect(p).toMatchObject({ truncated: true, totalLines: 1318, spanEnd: 1327 });
    expect(pages[3].truncated).toBeUndefined();
    // Each page is 400 lines of the right source.
    expect(String(pages[1].content).split("\n")[0]).toBe("line 410");
    expect(String(pages[3].content).split("\n").pop()).toBe("line 1327");
  });

  it("pages a cursor in llm format, and --all reads the rest of the span", async () => {
    const program = () => {
      const p = new Command();
      p.name("ix").exitOverride();
      registerReadCommand(p);
      return p;
    };
    await program().parseAsync(["read", "src/big.ts:10-1327@410", "--format", "llm", "--root", root], { from: "user" });
    expect(logs[0]).toContain("line_start=410 line_end=809");
    expect(logs[0]).toContain("target=file-range");
    expect(logs[0]).toContain("total_lines=1318 span_end=1327 next=src/big.ts:10-1327@810");
    expect(logs[2]).toMatch(/^410\tline 410$/);
    logs = [];
    await program().parseAsync(["read", "src/big.ts:10-1327@410", "--all", "--format", "llm", "--root", root], { from: "user" });
    expect(logs[0]).toContain("line_start=410 line_end=1327");
    expect(logs[0]).not.toContain("next=");
  });

  it("rejects a cursor whose page start is outside its range", async () => {
    const p = new Command();
    p.name("ix").exitOverride();
    registerReadCommand(p);
    await p.parseAsync(["read", "src/big.ts:10-1327@5", "--format", "llm", "--root", root], { from: "user" });
    expect(logs[0]).toContain("invalid_line_range");
    expect(logs[0]).toContain("@n");
    process.exitCode = 0;
  });

  it("keeps the old message for an ordinary invalid range", async () => {
    const p = new Command();
    p.name("ix").exitOverride();
    registerReadCommand(p);
    await p.parseAsync(["read", "src/big.ts:20-10", "--format", "llm", "--root", root], { from: "user" });
    expect(logs[0]).toContain("Line numbers must start at 1 and the end must not precede the start.");
    expect(logs[0]).not.toContain("@n");
    process.exitCode = 0;
  });

  it("says --all on a cursor page reads the rest of the range", async () => {
    const p = new Command();
    p.name("ix").exitOverride();
    registerReadCommand(p);
    await p.parseAsync(["read", "src/big.ts:10-1327@410", "--root", root], { from: "user" });
    const note = errs.join("");
    expect(note).toContain("400 of 1318 lines");
    expect(note).toContain("ix read src/big.ts:10-1327@810");
    expect(note).toContain("--all for the rest of the range");
  });

  it("names the cursor from the workspace root, so it round-trips from a subdirectory", async () => {
    // The symbol lives in lib/big.ts; <root>/big.ts is a different file with
    // the same basename. A cwd-relative cursor (`big.ts:...`) printed from
    // lib/ resolved against the root and read the decoy.
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "big.ts"), BIG);
    writeFileSync(join(root, "big.ts"), Array.from({ length: 1734 }, (_, i) => `decoy ${i + 1}`).join("\n"));
    graph.node = {
      name: "bigFn",
      kind: "function",
      attrs: { line_start: 10, line_end: 1327 },
      provenance: { source_uri: join(root, "lib", "big.ts") },
    };
    process.chdir(join(root, "lib"));
    await read(["--format", "json"]);
    const pages: Array<Record<string, unknown>> = [JSON.parse(logs.join("\n"))];
    expect(pages[0].next).toBe("lib/big.ts:10-1327@410");
    for (let hops = 0; pages[pages.length - 1].next && hops < 10; hops++) {
      logs = [];
      const program = new Command();
      program.name("ix").exitOverride();
      registerReadCommand(program);
      await program.parseAsync(
        ["read", String(pages[pages.length - 1].next), "--format", "json", "--root", root], { from: "user" });
      pages.push(JSON.parse(logs.join("\n")));
    }
    expect(pages.map((p) => p.lineEnd)).toEqual([409, 809, 1209, 1327]);
    for (const p of pages) expect(String(p.content)).not.toContain("decoy");
    expect(String(pages[3].content).split("\n").pop()).toBe("line 1327");
  });

  it("capSpan returns an uncapped span unchanged", () => {
    const lines = ["a", "b", "c"];
    expect(capSpan(lines, 2, 3, 400)).toEqual({ content: "b\nc", lineStart: 2, lineEnd: 3 });
    expect(capSpan(lines, 1, 3, undefined)).toEqual({ content: "a\nb\nc", lineStart: 1, lineEnd: 3 });
  });
});
