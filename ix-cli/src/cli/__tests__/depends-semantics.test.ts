// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerDependsCommand } from "../commands/depends.js";

/**
 * `ix depends` presents results in dependency direction, walks the upstream
 * tree one hop at a time, and says what it is. Run through the registered
 * command against a fake graph, so what is checked is what a caller sees.
 */

// This suite is about the walk and its output, not about scoping.
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search, expand } = vi.hoisted(() => ({ search: vi.fn(), expand: vi.fn() }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

function node(id: string, name: string, kind: string, sourceUri: string) {
  return { id, name, kind, attrs: {}, provenance: { sourceUri } };
}

const TARGET = node("target-id", "Target", "function", "src/target.ts");
const ALPHA = node("alpha-id", "Alpha", "function", "src/alpha.ts");
const BRAVO = node("bravo-id", "Bravo", "file", "src/bravo.ts");
const CHARLIE = node("charlie-id", "Charlie", "function", "src/charlie.ts");

/**
 * Who points at whom, keyed by `<id>|<predicate>`: Target <-CALLS- Alpha,
 * Target <-IMPORTS- Bravo, Alpha <-CALLS- Charlie, Charlie <-CALLS- Alpha
 * (a cycle back to Alpha).
 */
const INBOUND: Record<string, unknown[]> = {
  "target-id|CALLS": [ALPHA],
  "target-id|IMPORTS": [BRAVO],
  "alpha-id|CALLS": [CHARLIE],
  "charlie-id|CALLS": [ALPHA],
};

const ANSI = /\x1b\[[0-9;]*m/g;

async function run(args: string[]): Promise<{ stdout: string; stderr: string; command: Command }> {
  const program = new Command().name("ix").exitOverride();
  registerDependsCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...parts) => { stderr.push(parts.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((part: string) => {
    stderr.push(String(part));
    return true;
  }) as never);
  try {
    await program.parseAsync(["depends", ...args], { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  const command = program.commands.find((c) => c.name() === "depends")!;
  return { stdout: stdout.join("\n").replace(ANSI, ""), stderr: stderr.join("\n").replace(ANSI, ""), command };
}

async function runJson(args: string[]): Promise<any> {
  return JSON.parse((await run([...args, "--format", "json"])).stdout);
}

function findChild(nodes: any[] | undefined, name: string): any {
  const found = (nodes ?? []).find((n) => n.name === name);
  expect(found, `child ${name}`).toBeDefined();
  return found;
}

let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  search.mockReset().mockImplementation(async (term: string, opts?: { kind?: string }) =>
    [TARGET].filter((n) => n.name.toLowerCase().includes(term.toLowerCase()) && (!opts?.kind || n.kind === opts.kind)));
  expand.mockReset().mockImplementation(async (id: string, opts: { predicates: string[] }) =>
    ({ nodes: INBOUND[`${id}|${opts.predicates[0]}`] ?? [], edges: [] }));
});

afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

// ── Direction semantics ─────────────────────────────────────────────

describe("depends direction semantics", () => {
  it("description says upstream dependents", async () => {
    const { command } = await run(["Target", "--format", "json"]);
    expect(command.description()).toContain("upstream dependents");
    expect(command.description()).not.toContain("reverse CALLS");
  });

  it("walks inbound edges one hop and one predicate at a time, across all five predicates", async () => {
    await run(["Target", "--format", "json"]);
    expect(expand).toHaveBeenCalled();
    for (const [, opts] of expand.mock.calls) {
      expect(opts).toMatchObject({ direction: "in", hops: 1 });
      expect(opts.predicates).toHaveLength(1);
    }
    const atRoot = new Set(expand.mock.calls.filter(([id]) => id === "target-id").map(([, opts]) => opts.predicates[0]));
    expect(atRoot).toEqual(new Set(["CALLS", "IMPORTS", "REFERENCES", "EXTENDS", "IMPLEMENTS"]));
  });

  it("text heading uses dependency-oriented language", async () => {
    const { stdout } = await run(["Target"]);
    expect(stdout).toContain("Dependents");
  });

  it("empty state message uses dependency language", async () => {
    expand.mockResolvedValue({ nodes: [], edges: [] });
    const { stdout } = await run(["Target"]);
    expect(stdout).toContain("No upstream dependents found");

    const output = await runJson(["Target"]);
    expect(output.tree).toEqual([]);
    expect(output.diagnostics[0].code).toBe("no_edges");
  });

  it("uses dependency-oriented relation values", async () => {
    const output = await runJson(["Target"]);
    expect(findChild(output.tree, "Alpha").rel).toBe("called_by");
    expect(findChild(output.tree, "Bravo").rel).toBe("imported_by");
  });
});

// ── Full-tree traversal ─────────────────────────────────────────────

describe("depends full-tree traversal", () => {
  it("expands recursively via one-hop calls", async () => {
    const output = await runJson(["Target"]);
    const charlie = findChild(findChild(output.tree, "Alpha").children, "Charlie");
    expect(charlie.rel).toBe("called_by");
    // Charlie's own dependents were asked for, one hop from Charlie.
    expect(expand.mock.calls.some(([id]) => id === "charlie-id")).toBe(true);
  });

  it("defaults to depth 3 and 100 nodes without --depth or --cap", async () => {
    const output = await runJson(["Target"]);
    expect(output.traversal.depthLimit).toBe(3);
    expect(output.traversal.nodeCap).toBe(100);
  });

  it("--depth and --cap act as limiters", async () => {
    const output = await runJson(["Target", "--depth", "1", "--cap", "5"]);
    expect(output.traversal.depthLimit).toBe(1);
    expect(output.traversal.nodeCap).toBe(5);
    expect(findChild(output.tree, "Alpha").children).toBeUndefined();
  });

  it("marks a node already on the walk as a cycle instead of following it", async () => {
    const output = await runJson(["Target"]);
    const charlie = findChild(findChild(output.tree, "Alpha").children, "Charlie");
    expect(charlie.children.some((n: any) => n.cycle === true)).toBe(true);
  });
});

// ── Nested tree output ──────────────────────────────────────────────

describe("depends nested tree structure", () => {
  it("JSON outputs a nested tree field, not flat results", async () => {
    const output = await runJson(["Target"]);
    expect(Array.isArray(output.tree)).toBe(true);
    expect(output.results).toBeUndefined();
    expect(Array.isArray(findChild(output.tree, "Alpha").children)).toBe(true);
  });

  it("JSON includes traversal metadata", async () => {
    const { traversal } = await runJson(["Target"]);
    expect(typeof traversal.nodesVisited).toBe("number");
    expect(typeof traversal.maxDepthReached).toBe("number");
    expect(typeof traversal.truncated).toBe("boolean");
  });

  it("renders text tree with box-drawing glyphs", async () => {
    const { stdout } = await run(["Target"]);
    expect(stdout).toContain("├─");
    expect(stdout).toContain("└─");
    expect(stdout).toContain("│");
  });

  it("JSON includes semantics field", async () => {
    const output = await runJson(["Target"]);
    expect(output.semantics).toBe("downstream_dependents");
  });
});
