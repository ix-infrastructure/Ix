import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const searchCalls: Array<Record<string, unknown>> = [];

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async search(term: string, opts: Record<string, unknown>) {
      searchCalls.push({ term, ...opts });
      return [];
    }
    async entity() { return { node: {}, claims: [], edges: [] }; }
    async workspaceSystem() { return { systemId: null }; }
  },
}));

let root: string;

beforeEach(() => {
  vi.resetModules();
  searchCalls.length = 0;
  root = mkdtempSync(join(tmpdir(), "ix-read-local-"));
  mkdirSync(join(root, "src", "cli"), { recursive: true });
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(root, "src", "cli", "upgrade.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "node_modules", "junk", "upgrade.ts"), "module.exports = {};\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runRead(target: string): Promise<string> {
  const { registerReadCommand } = await import("../commands/read.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerReadCommand(program);
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...v: unknown[]) => { out.push(v.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...v: unknown[]) => { out.push(v.join(" ")); });
  try {
    await program.parseAsync(["read", target, "--root", root], { from: "user" });
  } catch { /* commander exitOverride */ } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return out.join("\n");
}

describe("ix read resolves filenames from disk before the graph", () => {
  it("finds a nested file by bare basename without asking the backend at all", async () => {
    const out = await runRead("upgrade");

    expect(out).toContain("export const x = 1;");
    // The whole point: zero round trips. This used to be a `kind: file` search
    // plus a nine-way fan-out over guessed extensions.
    expect(searchCalls).toEqual([]);
  });

  it("does not descend into node_modules, so the workspace copy wins", async () => {
    const out = await runRead("upgrade");
    // Assert the content that WAS rendered, not merely the absence of the other
    // file's — a run that resolves nothing would satisfy the absence alone, and
    // that is exactly what the pre-fix code does here.
    expect(out).toContain("export const x = 1;");
    expect(out).not.toContain("module.exports");
  });

  /**
   * The regression this file exists for.
   *
   * `ix read <symbol>` used to issue 12 backend calls: a `kind: file` search,
   * then NINE concurrent searches appending .scala/.ts/.tsx/.py/.rs/.go/.java/
   * .js/.md, then the symbol lookup that actually answers. All nine returned
   * empty for a symbol, and being concurrent they contended for the same
   * collection — measured at ~54s EACH instead of ~10s, so the command took
   * 60-80s before reaching the call that works.
   *
   * `ix map` ignores a strict superset of the directories this walk ignores, so
   * an exhaustive walk that finds nothing proves the graph has nothing to find
   * either.
   */
  it("asks the graph nothing about filenames for an extension-less symbol", async () => {
    await runRead("registerUpgradeCommand");

    const fileSearches = searchCalls.filter((c) => c.kind === "file");
    expect(fileSearches).toEqual([]);
    // Every guessed-extension term is gone too.
    expect(searchCalls.some((c) => String(c.term).endsWith(".scala"))).toBe(false);
    expect(searchCalls.some((c) => String(c.term).endsWith(".tsx"))).toBe(false);
  });

  it("still asks the graph when the target carries an extension", async () => {
    // A file that is ingested but not checked out locally is exactly the case
    // the graph lookup exists for, so an extension must not take the shortcut.
    await runRead("NotOnDisk.scala");

    expect(searchCalls.some((c) => c.kind === "file" && c.term === "NotOnDisk.scala")).toBe(true);
  });
});
