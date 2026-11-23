// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerCallersCommand } from "../commands/callers.js";
import { registerLocateCommand } from "../commands/locate.js";
import { laterOverloads, mayHoldOverloads, type OverloadRow } from "../resolve/pick.js";

// Each Java overload after the first is its own graph node (#1139), so a
// method name can match several nodes in one class. Those are one answer to
// the name: the first in source order, with no ambiguous_target notice and no
// exit 2 under --strict. Two same-named methods in two classes are still two.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search, expand, expandByName, entity } = vi.hoisted(() => ({
  search: vi.fn(), expand: vi.fn(), expandByName: vi.fn(), entity: vi.fn(),
}));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
    async expandByName(...args: unknown[]) { return expandByName(...args); }
    async resolvePrefix(p: string) { return p; }
    async entity(id: string) { return entity(id); }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

vi.mock("../hierarchy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hierarchy.js")>(),
  getSystemPath: async () => [],
  getEffectiveSystemPath: async () => [],
  bucketByHierarchy: async () => [],
}));

vi.mock("../miss-reason.js", () => ({
  missProbeWouldRun: () => false,
  explainSymbolMiss: async () => null,
}));

const STORE = "src/main/java/app/Store.java";
const OTHER = "src/main/java/app/Other.java";

const node = (id: string, kind: string, name: string, path: string, line: number) => ({
  id, kind, name, attrs: { line_start: line, line_end: line + 3 }, provenance: { sourceUri: path },
});
const cls = (id: string, name: string, path: string) => node(id, "class", name, path, 1);

/** What the backend holds: the nodes a name search returns and each one's CONTAINS parent. */
let nodes: Array<ReturnType<typeof node>> = [];
let parents: Record<string, ReturnType<typeof node>> = {};

function graph(rows: Array<[ReturnType<typeof node>, ReturnType<typeof node> | null]>): void {
  nodes = rows.map(([n]) => n);
  parents = Object.fromEntries(rows.filter(([, p]) => p).map(([n, p]) => [n.id, p!]));
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  registerLocateCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...parts) => { stderr.push(parts.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((part: string) => {
    stderr.push(String(part).replace(/\n$/, ""));
    return true;
  }) as never);
  process.exitCode = undefined;
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode: Number(process.exitCode ?? 0) };
}

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  nodes = [];
  parents = {};
  search.mockReset().mockImplementation(async (term: string) => nodes.filter((n) => n.name === term));
  entity.mockReset().mockImplementation(async (id: string) => ({ node: nodes.find((n) => n.id === id) }));
  expand.mockReset().mockImplementation(async (id: string) => ({
    nodes: nodes.filter((n) => parents[n.id]?.id === id),
    edges: [],
  }));
  expandByName.mockReset().mockImplementation(async (name: string) => {
    const held = nodes.filter((n) => n.name === name && parents[n.id]);
    return {
      nodes: [...new Map(held.map((n) => [parents[n.id].id, parents[n.id]])).values()],
      edges: held.map((n) => ({ id: `e-${n.id}`, src: parents[n.id].id, dst: n.id, predicate: "CONTAINS", attrs: {} })),
    };
  });
});
afterEach(() => {
  process.exitCode = savedExitCode;
  delete process.env.IX_STRICT_TARGETS;
});

const storeClass = cls("cls-store", "Store", STORE);
const cacheClass = cls("cls-cache", "Cache", STORE);

/** Three overloads of Store.put; the ids sort against the source order. */
const PUTS: Array<[ReturnType<typeof node>, ReturnType<typeof node> | null]> = [
  [node("put-c", "method", "put", STORE, 10), storeClass],
  [node("put-b", "method", "put", STORE, 20), storeClass],
  [node("put-a", "method", "put", STORE, 30), storeClass],
];

describe("laterOverloads", () => {
  const row = (id: string, over: Partial<OverloadRow> = {}): OverloadRow => ({
    id, name: "put", kind: "method", path: STORE, line: 10, parent: "cls-store", ...over,
  });

  it("keeps the first of one type's overloads in source order", () => {
    const rows = [row("z", { line: 30 }), row("m", { line: 10 }), row("a", { line: 20 })];
    expect([...laterOverloads(rows)].sort()).toEqual(["a", "z"]);
  });

  it("breaks an equal line by id, and puts a row with no line last", () => {
    expect([...laterOverloads([row("b"), row("a")])]).toEqual(["b"]);
    expect([...laterOverloads([row("a", { line: undefined }), row("b", { line: 99 })])]).toEqual(["a"]);
  });

  it("never folds across types, files, kinds or names, or without a type", () => {
    expect(laterOverloads([row("a"), row("b", { parent: "cls-cache" })]).size).toBe(0);
    expect(laterOverloads([row("a"), row("b", { path: OTHER })]).size).toBe(0);
    expect(laterOverloads([row("a"), row("b", { kind: "function" })]).size).toBe(0);
    expect(laterOverloads([row("a"), row("b", { name: "get" })]).size).toBe(0);
    expect(laterOverloads([row("a", { parent: undefined }), row("b", { parent: undefined })]).size).toBe(0);
  });

  it("folds only member kinds, in a language with overloads", () => {
    expect(laterOverloads([row("a", { kind: "class" }), row("b", { kind: "class" })]).size).toBe(0);
    expect(laterOverloads([row("a", { path: "app/store.py" }), row("b", { path: "app/store.py" })]).size).toBe(0);
    expect(laterOverloads([row("a", { path: "app/Store.kt" }), row("b", { path: "app/Store.kt" })]).size).toBe(1);
  });

  it("mayHoldOverloads: two member rows of one name in one file, whatever holds them", () => {
    const bare = (id: string, over: Partial<OverloadRow> = {}) => row(id, { parent: undefined, ...over });
    expect(mayHoldOverloads([bare("a"), bare("b")])).toBe(true);
    expect(mayHoldOverloads([bare("a"), bare("a")])).toBe(false);
    expect(mayHoldOverloads([bare("a"), bare("b", { path: OTHER })])).toBe(false);
    expect(mayHoldOverloads([bare("a", { kind: "class" }), bare("b", { kind: "class" })])).toBe(false);
    expect(mayHoldOverloads([bare("a", { path: "x.py" }), bare("b", { path: "x.py" })])).toBe(false);
  });
});

describe("overloads of one method are one target", () => {
  for (const strict of [true, false]) {
    it(`resolves to the first in source order, no notice, exit 0 (${strict ? "strict" : "default"})`, async () => {
      if (strict) process.env.IX_STRICT_TARGETS = "1";
      graph(PUTS);
      const result = await run(["locate", "put", "--format", "json"]);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.resolvedTarget.id).toBe("put-c");
      expect(result.stdout + result.stderr).not.toContain("ambiguous_target");
      expect(body).not.toHaveProperty("candidates");
      // One request for the name, not one per overload.
      expect(expandByName).toHaveBeenCalledTimes(1);
    });
  }

  it("callers --strict answers for the first overload", async () => {
    graph(PUTS);
    const result = await run(["callers", "put", "--strict", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("ambiguous_target");
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe("put-c");
  });

  it("Class.method resolves to the first overload of that class", async () => {
    graph([...PUTS, [storeClass, null]]);
    const result = await run(["locate", "Store.put", "--strict", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe("put-c");
    expect(result.stdout + result.stderr).not.toContain("ambiguous_target");
  });
});

describe("what is still ambiguous", () => {
  beforeEach(() => { process.env.IX_STRICT_TARGETS = "1"; });

  const ids = (stdout: string) => JSON.parse(stdout).candidates.map((c: { id: string }) => c.id);

  it("two same-named methods in two classes of one file", async () => {
    graph([
      [node("store-put", "method", "put", STORE, 10), storeClass],
      [node("cache-put", "method", "put", STORE, 50), cacheClass],
    ]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual(["store-put", "cache-put"]);
  });

  it("an overload group and a same-named method in another file: the group is one candidate", async () => {
    graph([...PUTS, [node("other-put", "method", "put", OTHER, 5), cls("cls-other", "Other", OTHER)]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(ids(result.stdout)).toEqual(["other-put", "put-c"]);
    expect(body.total).toBe(2);
    // The default answer names the same two, and resolves as it does for any tie.
    delete process.env.IX_STRICT_TARGETS;
    const lenient = await run(["locate", "put", "--format", "json"]);
    expect(lenient.exitCode).toBe(0);
    expect(lenient.stdout).toContain("ambiguous_target");
  });

  it("an overload group and a same-named method in another class of the file", async () => {
    graph([...PUTS, [node("cache-put", "method", "put", STORE, 50), cacheClass]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual(["put-c", "cache-put"]);
  });

  it("kinds that are not members, even in one type", async () => {
    graph([
      [node("k1", "constant", "LIMIT", STORE, 10), storeClass],
      [node("k2", "constant", "LIMIT", STORE, 20), storeClass],
    ]);
    const result = await run(["locate", "LIMIT", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual(["k1", "k2"]);
  });

  it("a language without overloads, where no type is asked for before the pick", async () => {
    const py = "app/store.py";
    const pyClass = cls("cls-py", "Store", py);
    graph([[node("p1", "method", "put", py, 10), pyClass], [node("p2", "method", "put", py, 20), pyClass]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual(["p1", "p2"]);
    // Only the ambiguous record's own container lookup.
    expect(expandByName).toHaveBeenCalledTimes(1);
  });

  it("methods the backend names no type for", async () => {
    graph(PUTS);
    expandByName.mockRejectedValue(new Error("500: boom"));
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual(["put-c", "put-b", "put-a"]);
  });
});

describe("no request where nothing can be an overload", () => {
  it("one method of the name per file", async () => {
    graph([[node("only", "method", "put", STORE, 10), storeClass]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(expandByName).not.toHaveBeenCalled();
  });
});
