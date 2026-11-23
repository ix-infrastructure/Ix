// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerCallersCommand } from "../commands/callers.js";
import { registerLocateCommand } from "../commands/locate.js";
import { foldOverloads } from "../resolve/pick.js";

// Each Java overload after the first is its own graph node (#1139), so a
// method name can match several nodes in one class. Ingest writes
// `overload_of` (the first overload's node id) on each later one, and a row
// whose `overload_of` is another row of the same candidate set is folded into
// it: the name is one target, its first overload, with an `overloaded_target`
// notice listing the others by id. The fold reads the rows' own attributes and
// makes no request. Two same-named methods in two classes are still two.

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

type Row = { id: string; kind: string; name: string; attrs: Record<string, unknown>; provenance: { sourceUri: string } };

const node = (id: string, kind: string, name: string, path: string, line: number, attrs: Record<string, unknown> = {}): Row => ({
  id, kind, name, attrs: { line_start: line, line_end: line + 3, ...attrs }, provenance: { sourceUri: path },
});
const cls = (id: string, name: string, path: string) => node(id, "class", name, path, 1);

/** What the backend holds: the nodes a name search returns and each one's CONTAINS parent. */
let nodes: Row[] = [];
let parents: Record<string, Row> = {};

function graph(rows: Array<[Row, Row | null]>): void {
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

// Three overloads of Store.put as ingest writes them. The ids are ids a
// command takes as a target, and sort against the source order.
const PUT_1 = "c".repeat(32);
const PUT_2 = "b".repeat(32);
const PUT_3 = "a".repeat(32);
const PUTS: Array<[Row, Row | null]> = [
  [node(PUT_3, "method", "put", STORE, 30, { overload_of: PUT_1, overload_signature: "String,int" }), storeClass],
  [node(PUT_1, "method", "put", STORE, 10, { overload_signature: "String" }), storeClass],
  [node(PUT_2, "method", "put", STORE, 20, { overload_of: PUT_1, overload_signature: "" }), storeClass],
];
const GROUP = [
  { id: PUT_1, line: 10, signature: "String" },
  { id: PUT_2, line: 20, signature: "" },
  { id: PUT_3, line: 30, signature: "String,int" },
];
/** The same three nodes as a graph mapped before the attributes holds them. */
const OLD_PUTS: Array<[Row, Row | null]> = PUTS.map(([n, parent]) => [node(n.id, n.kind, n.name, STORE, Number(n.attrs.line_start)), parent]);

const noticesOf = (stdout: string) => (JSON.parse(stdout).resolutionNotices ?? []) as Array<Record<string, any>>;
const candidatesOf = (stdout: string) => JSON.parse(stdout).candidates as Array<Record<string, any>>;

describe("foldOverloads", () => {
  const rows = () => PUTS.map(([n]) => n);

  it("leaves out the later overloads and lists the group first-then-source-order", () => {
    const { nodes: kept, groups } = foldOverloads(rows());
    expect(kept.map((n) => n.id)).toEqual([PUT_1]);
    expect([...groups]).toEqual([[PUT_1, GROUP]]);
  });

  it("returns rows without the attribute as they came", () => {
    const old = OLD_PUTS.map(([n]) => n);
    const { nodes: kept, groups } = foldOverloads(old);
    expect(kept).toBe(old);
    expect(groups.size).toBe(0);
  });

  it("folds nothing when the first overload is not among the rows", () => {
    const later = rows().filter((n) => n.id !== PUT_1);
    expect(foldOverloads(later).nodes).toBe(later);
  });

  it("reads the attribute alone: any kind, any language, and never a file or a name", () => {
    const first = node("f", "function", "area", "shape.kt", 3);
    const second = node("s", "function", "area", "shape.kt", 9, { overload_of: "f" });
    expect(foldOverloads([second, first]).nodes).toEqual([first]);
    // Same name, file, kind and type, and no attribute: two candidates.
    expect(foldOverloads([first, node("s", "function", "area", "shape.kt", 9)]).nodes).toHaveLength(2);
  });

  it("omits a signature the node does not carry, and a line it does not have", () => {
    const first = { id: "f", attrs: {} };
    const second = { id: "s", attrs: { overload_of: "f", line_start: 4 } };
    expect(foldOverloads([first, second]).groups.get("f")).toEqual([{ id: "f" }, { id: "s", line: 4 }]);
  });

  it("ignores a node that names itself, a chain, and a repeated row", () => {
    const self = { id: "a", attrs: { overload_of: "a" } };
    expect(foldOverloads([self]).nodes).toEqual([self]);
    const chain = [{ id: "a", attrs: {} }, { id: "b", attrs: { overload_of: "a" } }, { id: "c", attrs: { overload_of: "b" } }];
    expect(foldOverloads(chain).nodes.map((n) => n.id)).toEqual(["a", "c"]);
    const twice = [...rows(), ...rows()];
    expect(foldOverloads(twice).groups.get(PUT_1)).toEqual(GROUP);
  });
});

describe("overloads of one method are one target", () => {
  for (const strict of [true, false]) {
    it(`resolves to the first overload with a notice, exit 0, no request (${strict ? "strict" : "default"})`, async () => {
      if (strict) process.env.IX_STRICT_TARGETS = "1";
      graph(PUTS);
      const result = await run(["locate", "put", "--format", "json"]);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.resolvedTarget.id).toBe(PUT_1);
      // The answer's own keys are what they were; the group is in the notice.
      expect(body.resolvedTarget).not.toHaveProperty("overloads");
      expect(body).not.toHaveProperty("candidates");
      expect(result.stdout + result.stderr).not.toContain("ambiguous_target");
      expect(body.resolutionNotices).toEqual([{
        code: "overloaded_target",
        target: "put",
        message: `"put" has 3 overloads; answering for the first, put(String) (${STORE}:10). Pass another overload's id as the target to answer for it.`,
        chosen: { id: PUT_1, name: "put", kind: "method", path: STORE },
        candidates: [{ id: PUT_1, name: "put", kind: "method", path: STORE, rank: 1 }],
        total: 1,
        overloads: GROUP,
      }]);
      expect(expandByName).not.toHaveBeenCalled();
    });
  }

  it("callers --strict answers for the first overload", async () => {
    graph(PUTS);
    const result = await run(["callers", "put", "--strict", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe(PUT_1);
    expect(JSON.parse(result.stdout).resolvedTarget).not.toHaveProperty("overloads");
    expect(noticesOf(result.stdout).map((n) => n.code)).toEqual(["overloaded_target"]);
    expect(expandByName).not.toHaveBeenCalled();
  });

  it("llm: a diagnostic and one `overload` record each, with full ids", async () => {
    graph(PUTS);
    const result = await run(["locate", "put", "--format", "llm"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(/^diagnostic code=overloaded_target target=put chosen=put overloads=3 message="/);
    expect(lines.slice(1, 4)).toEqual([
      `overload name=put(String) line=10 id=${PUT_1} chosen=true`,
      `overload name=put() line=20 id=${PUT_2}`,
      `overload name=put(String,int) line=30 id=${PUT_3}`,
    ]);
    expect(result.stdout).not.toMatch(/^(error|candidate|hint) /m);
  });

  it("text: the notice and the overloads on stderr", async () => {
    graph(PUTS);
    const result = await run(["locate", "put"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('"put" has 3 overloads; answering for the first, put(String)');
    expect(result.stderr).toMatch(new RegExp(`${PUT_1}\\s+line 10\\s+put\\(String\\)\\s+\\(answered\\)`));
    expect(result.stderr).toMatch(new RegExp(`${PUT_3}\\s+line 30\\s+put\\(String,int\\)`));
    expect(result.stderr).not.toContain("--pick");
  });

  it("a later overload is addressed by its id", async () => {
    graph(PUTS);
    const result = await run(["locate", PUT_3, "--strict", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe(PUT_3);
    expect(noticesOf(result.stdout)).toEqual([]);
  });

  it("--pick does not count overloads: the name is one candidate", async () => {
    graph(PUTS);
    const result = await run(["locate", "put", "--pick", "2", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe(PUT_1);
  });

  it("Class.method resolves to the first overload of that class, with the notice", async () => {
    graph([...PUTS, [storeClass, null]]);
    const result = await run(["locate", "Store.put", "--strict", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe(PUT_1);
    expect(result.stdout + result.stderr).not.toContain("ambiguous_target");
    const [notice] = noticesOf(result.stdout);
    expect(notice).toMatchObject({ code: "overloaded_target", target: "Store.put", overloads: GROUP });
    expect(expandByName).not.toHaveBeenCalled();
  });

  it("a later constructor folds into its class, which holds the first one", async () => {
    const point = cls("cls-point", "Point", STORE);
    graph([
      [point, null],
      [node("ctor-2", "method", "Point", STORE, 9, { overload_of: "cls-point", overload_signature: "int" }), point],
    ]);
    const result = await run(["locate", "Point", "--strict", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe("cls-point");
    expect(noticesOf(result.stdout)[0].overloads).toEqual([{ id: "cls-point", line: 1 }, { id: "ctor-2", line: 9, signature: "int" }]);
  });
});

describe("what is still ambiguous", () => {
  beforeEach(() => { process.env.IX_STRICT_TARGETS = "1"; });

  const ids = (stdout: string) => candidatesOf(stdout).map((c) => c.id);

  it("two same-named methods in two classes of one file: no attribute joins them", async () => {
    graph([
      [node("store-put", "method", "put", STORE, 10), storeClass],
      [node("cache-put", "method", "put", STORE, 50), cacheClass],
    ]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual(["store-put", "cache-put"]);
    // The ambiguous record's own container lookup, and nothing before it.
    expect(expandByName).toHaveBeenCalledTimes(1);
  });

  it("an overload group and a same-named method in another file: one row per group, its overloads on the row", async () => {
    graph([...PUTS, [node("other-put", "method", "put", OTHER, 5), cls("cls-other", "Other", OTHER)]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(ids(result.stdout)).toEqual(["other-put", PUT_1]);
    expect(body.total).toBe(2);
    expect(body.candidates[0]).not.toHaveProperty("overloads");
    expect(body.candidates[1].overloads).toEqual(GROUP);
    expect(expandByName).toHaveBeenCalledTimes(1);
  });

  it("answered by default for the top candidate; --pick <n> counts the folded list", async () => {
    delete process.env.IX_STRICT_TARGETS;
    graph([...PUTS, [node("other-put", "method", "put", OTHER, 5), cls("cls-other", "Other", OTHER)]]);
    const lenient = await run(["locate", "put", "--format", "json"]);
    expect(lenient.exitCode).toBe(0);
    expect(JSON.parse(lenient.stdout).resolvedTarget.id).toBe("other-put");
    const [tie, ...rest] = noticesOf(lenient.stdout);
    expect(rest).toEqual([]);
    expect(tie.code).toBe("ambiguous_target");
    expect(tie.candidates.map((c: { id: string }) => c.id)).toEqual(["other-put", PUT_1]);
    expect(tie.candidates[1].overloads).toEqual(GROUP);

    const picked = await run(["locate", "put", "--pick", "2", "--format", "json"]);
    expect(picked.exitCode).toBe(0);
    expect(JSON.parse(picked.stdout).resolvedTarget.id).toBe(PUT_1);
    expect(noticesOf(picked.stdout).map((n) => n.code)).toEqual(["overloaded_target"]);
    expect(noticesOf(picked.stdout)[0].overloads).toEqual(GROUP);

    // The list has two rows, not four.
    const past = await run(["locate", "put", "--pick", "3", "--format", "json"]);
    expect(past.exitCode).toBe(2);
    expect(past.stderr).toContain("--pick 3 is out of range (1-2).");
  });

  it("answered for the group when it is the top candidate: both notices", async () => {
    delete process.env.IX_STRICT_TARGETS;
    graph([...PUTS, [node("z-put", "method", "put", "src/main/java/app/Zed.java", 5), cls("cls-zed", "Zed", "src/main/java/app/Zed.java")]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe(PUT_1);
    expect(noticesOf(result.stdout).map((n) => n.code)).toEqual(["ambiguous_target", "overloaded_target"]);
  });

  it("an overload group and a same-named method in another class of the file", async () => {
    graph([...PUTS, [node("cache-put", "method", "put", STORE, 50), cacheClass]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual([PUT_1, "cache-put"]);
    expect(candidatesOf(result.stdout).map((c) => c.container)).toEqual(["Store", "Cache"]);
  });

  it("a graph mapped before the attribute: every overload is a candidate, as without the fold", async () => {
    graph(OLD_PUTS);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(ids(result.stdout)).toEqual([PUT_1, PUT_2, PUT_3]);
    expect(candidatesOf(result.stdout).some((c) => "overloads" in c)).toBe(false);
    expect(expandByName).toHaveBeenCalledTimes(1);
    // Class.method too.
    graph([...OLD_PUTS, [storeClass, null]]);
    const qualified = await run(["locate", "Store.put", "--format", "json"]);
    expect(ids(qualified.stdout)).toEqual([PUT_1, PUT_2, PUT_3]);
  });
});

describe("the container lookup is the ambiguous record's alone", () => {
  it("one method of the name: resolved, no request, no notice", async () => {
    graph([[node("only", "method", "put", STORE, 10), storeClass]]);
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(noticesOf(result.stdout)).toEqual([]);
    expect(expandByName).not.toHaveBeenCalled();
  });

  it("a backend that cannot name containers changes nothing about overloads", async () => {
    process.env.IX_STRICT_TARGETS = "1";
    graph(PUTS);
    expandByName.mockRejectedValue(new Error("500: boom"));
    const result = await run(["locate", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).resolvedTarget.id).toBe(PUT_1);
  });
});
