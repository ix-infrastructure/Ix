// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerCallersCommand } from "../commands/callers.js";
import { registerContainsCommand } from "../commands/contains.js";
import { registerDependsCommand } from "../commands/depends.js";
import { registerExplainCommand } from "../commands/explain.js";
import { registerImpactCommand } from "../commands/impact.js";
import { registerLocateCommand } from "../commands/locate.js";
import { registerTraceCommand } from "../commands/trace.js";
import { answeredIds, overloadGraph, overloadOfRow, withOverloadOfRows } from "../overload-group.js";
import { OVERLOAD_EXPAND_CAP } from "../resolve/pick.js";

// Each overload of a Java method is its own node with its own edges (#1139),
// where they were one node holding every caller and callee. A name resolves
// to the first overload with the group on it, and a command that answers from
// edges answers for the whole group: one expansion per overload, merged. An
// overload given as an id is one node, and a target that is no group sends
// the requests it always sent.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search, expand, entity } = vi.hoisted(() => ({ search: vi.fn(), expand: vi.fn(), entity: vi.fn() }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
    async expandByName() { return { nodes: [], edges: [] }; }
    async resolvePrefix(p: string) { return p; }
    async entity(id: string) { return entity(id); }
    async provenance(id: string) { return { entityId: id, chain: [] }; }
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
const USES = "src/main/java/app/Uses.java";

type Row = { id: string; kind: string; name: string; attrs: Record<string, unknown>; provenance: { sourceUri: string } };
type Edge = { id: string; src: string; dst: string; predicate: string; attrs: Record<string, unknown>; createdRev: number };

const node = (id: string, kind: string, name: string, path: string, line: number, attrs: Record<string, unknown> = {}): Row => ({
  id, kind, name, attrs: { line_start: line, line_end: line + 3, ...attrs }, provenance: { sourceUri: path },
});

let nodes: Row[] = [];
let edges: Edge[] = [];
const edge = (src: string, dst: string, predicate = "CALLS"): Edge =>
  ({ id: `${src}>${predicate}>${dst}`, src, dst, predicate, attrs: {}, createdRev: 1 });

/** One hop of the mock graph, as `/v1/expand` answers it. */
function expandOnce(id: string, opts?: { direction?: string; predicates?: string[] }): any {
  const found = edges.filter((e) => (opts?.predicates ?? [e.predicate]).includes(e.predicate)
    && ((opts?.direction !== "in" && e.src === id) || (opts?.direction !== "out" && e.dst === id)));
  const ids = [...new Set(found.map((e) => (e.src === id ? e.dst : e.src)))];
  return { nodes: ids.map((n) => nodes.find((row) => row.id === n)!).filter(Boolean), edges: found };
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  registerContainsCommand(program);
  registerDependsCommand(program);
  registerExplainCommand(program);
  registerImpactCommand(program);
  registerLocateCommand(program);
  registerTraceCommand(program);
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

const storeClass = node("cls-store", "class", "Store", STORE, 1);
const PUT_1 = "c".repeat(32);
const PUT_2 = "b".repeat(32);
const PUT_3 = "a".repeat(32);
const puts = [
  node(PUT_1, "method", "put", STORE, 10, { overload_signature: "String" }),
  node(PUT_2, "method", "put", STORE, 20, { overload_of: PUT_1, overload_signature: "" }),
  node(PUT_3, "method", "put", STORE, 30, { overload_of: PUT_1, overload_signature: "String,int" }),
];
const fn = (name: string, line: number) => node(`fn-${name}`, "method", name, USES, line);
const [alpha, beta, gamma, shared, save, log, flush, solo, top] =
  ["alpha", "beta", "gamma", "shared", "save", "log", "flush", "solo", "top"].map((name, i) => fn(name, 10 * (i + 1)));

/**
 * Three overloads of Store.put, each with its own callers and callees.
 * `shared` calls two of them; `log` is called by two of them; `top` calls
 * `alpha`, one hop further out. `solo` is a method with one signature.
 */
function overloadedStore(): void {
  nodes = [storeClass, ...puts, alpha, beta, gamma, shared, save, log, flush, solo, top];
  edges = [
    ...puts.map((p) => edge(storeClass.id, p.id, "CONTAINS")),
    edge(alpha.id, PUT_1), edge(shared.id, PUT_1),
    edge(beta.id, PUT_2),
    edge(gamma.id, PUT_3), edge(shared.id, PUT_3),
    edge(PUT_1, save.id), edge(PUT_1, log.id),
    edge(PUT_2, log.id),
    edge(PUT_3, flush.id),
    edge(alpha.id, solo.id),
    edge(top.id, alpha.id),
  ];
}

/** The `expand` requests sent, as `id direction predicates`. */
const expandCalls = () => expand.mock.calls.map(([id, opts]) => `${id} ${opts?.direction} ${(opts?.predicates ?? []).join("+")}`);
const names = (rows: Array<{ name?: string }>) => rows.map((r) => r.name).sort();
const noticesOf = (stdout: string) => (JSON.parse(stdout).resolutionNotices ?? []) as Array<Record<string, any>>;

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  overloadedStore();
  search.mockReset().mockImplementation(async (term: string) => nodes.filter((n) => n.name === term));
  entity.mockReset().mockImplementation(async (id: string) => ({ node: nodes.find((n) => n.id === id) }));
  expand.mockReset().mockImplementation(async (id: string, opts?: { direction?: string; predicates?: string[] }) => expandOnce(id, opts));
});
afterEach(() => {
  process.exitCode = savedExitCode;
  delete process.env.IX_STRICT_TARGETS;
});

describe("callers and callees of a name that is an overload group", () => {
  it("callers: the union over every overload, each caller once, totals of the merged set", async () => {
    const result = await run(["callers", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.resolvedTarget.id).toBe(PUT_1);
    expect(body.resolvedTarget).not.toHaveProperty("overloads");
    expect(names(body.results)).toEqual(["alpha", "beta", "gamma", "shared"]);
    expect(body.summary).toMatchObject({ shown: 4, total: 4, truncated: false });
    expect(body.summary).not.toHaveProperty("capped");
    // Which overload each caller calls; `shared` calls two.
    expect(Object.fromEntries(body.results.map((r: any) => [r.name, r.overload]))).toEqual({
      alpha: "put(String)", beta: "put()", gamma: "put(String,int)", shared: "put(String) | put(String,int)",
    });
    // One expansion per overload, and the class once: it is the same for all three.
    expect(expandCalls().filter((c) => c.endsWith("in CALLS+REFERENCES")).sort()).toEqual(
      [PUT_1, PUT_2, PUT_3].sort().map((id) => `${id} in CALLS+REFERENCES`),
    );
    expect(expandCalls().filter((c) => c.endsWith("in CONTAINS"))).toEqual([`${PUT_1} in CONTAINS`]);
  });

  it("the notice says the answer is for all of them", async () => {
    const result = await run(["callers", "put", "--format", "json"]);
    expect(noticesOf(result.stdout)).toEqual([{
      code: "overloaded_target",
      target: "put",
      message: `"put" has 3 overloads; answering for all 3 together. Pass one overload's id as the target to answer for it alone.`,
      chosen: { id: PUT_1, name: "put", kind: "method", path: STORE },
      candidates: [{ id: PUT_1, name: "put", kind: "method", path: STORE, rank: 1 }],
      total: 1,
      overloads: [
        { id: PUT_1, line: 10, signature: "String" },
        { id: PUT_2, line: 20, signature: "" },
        { id: PUT_3, line: 30, signature: "String,int" },
      ],
      answered: 3,
    }]);
  });

  it("a command that shows the definition still answers for the first, and says so", async () => {
    const [notice] = noticesOf((await run(["locate", "put", "--format", "json"])).stdout);
    expect(notice.answered).toBe(1);
    expect(notice.message).toContain("answering for the first, put(String)");
  });

  it("--strict: exit 0, the same union", async () => {
    for (const args of [["--strict"], []]) {
      if (args.length === 0) process.env.IX_STRICT_TARGETS = "1";
      const result = await run(["callers", "put", ...args, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(names(JSON.parse(result.stdout).results)).toEqual(["alpha", "beta", "gamma", "shared"]);
    }
  });

  it("llm: the header counts the merged rows, each ref names its overload", async () => {
    const result = await run(["callers", "put", "--format", "llm"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(/^diagnostic code=overloaded_target target=put chosen=put overloads=3 answered=3 message="\\"put\\" has 3 overloads; answering for all 3 together\./);
    expect(lines.slice(1, 4)).toEqual([
      `overload name=put(String) line=10 id=${PUT_1} chosen=true answered=true`,
      `overload name=put() line=20 id=${PUT_2} answered=true`,
      `overload name=put(String,int) line=30 id=${PUT_3} answered=true`,
    ]);
    expect(lines[4]).toBe("callers target=put shown=4 total=4 resolved=4");
    const refs = lines.filter((l) => l.startsWith("ref "));
    expect(refs).toHaveLength(4);
    expect(refs.find((l) => l.includes("name=beta"))).toMatch(/ overload=put\(\)$/);
    expect(refs.find((l) => l.includes("name=shared"))).toMatch(/ overload="put\(String\) \| put\(String,int\)"$/);
  });

  it("text: every caller, its overload beside it, every overload marked answered", async () => {
    const result = await run(["callers", "put"]);
    expect(result.exitCode).toBe(0);
    for (const name of ["alpha", "beta", "gamma", "shared"]) expect(result.stdout).toContain(name);
    expect(result.stdout).toMatch(/gamma.*\(put\(String,int\)\)/);
    expect(result.stderr).toContain('"put" has 3 overloads; answering for all 3 together.');
    expect(result.stderr.match(/\(answered\)/g)).toHaveLength(3);
  });

  it("callees: the union, each callee once", async () => {
    const result = await run(["callees", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(names(body.results)).toEqual(["flush", "log", "save"]);
    expect(body.summary).toMatchObject({ shown: 3, total: 3 });
    expect(body.results.find((r: any) => r.name === "log").overload).toBe("put(String) | put()");
    expect(noticesOf(result.stdout)[0].answered).toBe(3);
    expect(expandCalls().sort()).toEqual([PUT_1, PUT_2, PUT_3].sort().map((id) => `${id} out CALLS+REFERENCES`));
    // A call is looked for inside the overload that makes it: one span read
    // for each overload a row was first found from (`log` from the first).
    expect(entity.mock.calls.map(([id]) => id).sort()).toEqual([PUT_1, PUT_3].sort());
  });

  it("callees llm and text carry the union too", async () => {
    const llm = await run(["callees", "put", "--format", "llm"]);
    expect(llm.stdout).toContain("callees target=put shown=3 total=3 resolved=3");
    const text = await run(["callees", "put"]);
    for (const name of ["flush", "log", "save"]) expect(text.stdout).toContain(name);
  });

  it("paging runs over the merged list", async () => {
    const result = await run(["callers", "put", "--limit", "3", "--format", "json"]);
    expect(JSON.parse(result.stdout).summary).toMatchObject({ shown: 3, total: 4, truncated: true, nextOffset: 3 });
  });
});

describe("an overload given as an id is one node", () => {
  it("a later overload: its own callers and callees, no notice, no overload on the rows", async () => {
    const callers = await run(["callers", PUT_3, "--strict", "--format", "json"]);
    expect(callers.exitCode).toBe(0);
    expect(JSON.parse(callers.stdout).resolvedTarget.id).toBe(PUT_3);
    expect(names(JSON.parse(callers.stdout).results)).toEqual(["gamma", "shared"]);
    expect(JSON.parse(callers.stdout).results[0]).not.toHaveProperty("overload");
    expect(noticesOf(callers.stdout)).toEqual([]);
    expect(expandCalls().filter((c) => c.endsWith("in CALLS+REFERENCES"))).toEqual([`${PUT_3} in CALLS+REFERENCES`]);
    const callees = await run(["callees", PUT_3, "--format", "json"]);
    expect(names(JSON.parse(callees.stdout).results)).toEqual(["flush"]);
  });

  it("the first overload's id is that overload alone, not the group", async () => {
    const result = await run(["callers", PUT_1, "--format", "json"]);
    expect(names(JSON.parse(result.stdout).results)).toEqual(["alpha", "shared"]);
    expect(noticesOf(result.stdout)).toEqual([]);
    expect(expandCalls().filter((c) => c.endsWith("in CALLS+REFERENCES"))).toEqual([`${PUT_1} in CALLS+REFERENCES`]);
  });
});

describe("a target that is no overload group", () => {
  it("sends the requests it always sent and prints no overload", async () => {
    const callers = await run(["callers", "solo", "--format", "json"]);
    expect(names(JSON.parse(callers.stdout).results)).toEqual(["alpha"]);
    expect(JSON.parse(callers.stdout).results[0]).not.toHaveProperty("overload");
    expect(noticesOf(callers.stdout)).toEqual([]);
    // The callers, then the dispatch lookup's class.
    expect(expandCalls()).toEqual([`${solo.id} in CALLS+REFERENCES`, `${solo.id} in CONTAINS`]);
    expand.mockClear();
    entity.mockClear();
    await run(["callees", "alpha", "--format", "json"]);
    expect(expandCalls()).toEqual([`${alpha.id} out CALLS+REFERENCES`]);
    expect(entity.mock.calls).toEqual([[alpha.id]]);
  });

  it("overloadGraph hands back the client itself", () => {
    const client = { expand: vi.fn() };
    expect(overloadGraph(client, [{ id: "x" }, { id: "y", overloads: [{ id: "y" }] }])).toBe(client);
    expect(answeredIds(client, "x")).toEqual(["x"]);
  });
});

describe("the member cap", () => {
  it("expands the first OVERLOAD_EXPAND_CAP overloads and says the list may not be whole", async () => {
    const many = Array.from({ length: OVERLOAD_EXPAND_CAP + 2 }, (_, i) => node(
      `m${String(i).padStart(2, "0")}`.padEnd(32, "0"), "method", "emit", STORE, 100 + i,
      { overload_signature: "int,".repeat(i).slice(0, -1), ...(i > 0 ? { overload_of: "m00".padEnd(32, "0") } : {}) },
    ));
    const callersOf = many.map((m, i) => fn(`caller${i}`, 200 + i));
    nodes = [storeClass, ...many, ...callersOf];
    edges = many.flatMap((m, i) => [edge(storeClass.id, m.id, "CONTAINS"), edge(callersOf[i].id, m.id)]);
    const result = await run(["callers", "emit", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(expandCalls().filter((c) => c.endsWith("in CALLS+REFERENCES"))).toHaveLength(OVERLOAD_EXPAND_CAP);
    expect(body.results).toHaveLength(OVERLOAD_EXPAND_CAP);
    // The total is a lower bound, as when the server cuts an expansion.
    expect(body.summary).toMatchObject({ total: OVERLOAD_EXPAND_CAP, truncated: true, capped: true });
    const [notice] = body.resolutionNotices;
    expect(notice.overloads).toHaveLength(OVERLOAD_EXPAND_CAP + 2);
    expect(notice.answered).toBe(OVERLOAD_EXPAND_CAP);
    expect(notice.message).toBe(
      `"emit" has ${OVERLOAD_EXPAND_CAP + 2} overloads; answering for the first ${OVERLOAD_EXPAND_CAP} together `
      + `(at most ${OVERLOAD_EXPAND_CAP} are expanded). Pass one overload's id as the target to answer for it alone.`,
    );
  });
});

describe("--all", () => {
  it("a candidate that is an overload group is answered for all its overloads", async () => {
    const zed = node("z-put", "method", "put", "src/main/java/app/Zed.java", 5);
    const zedCaller = fn("zeta", 300);
    nodes.push(zed, zedCaller);
    edges.push(edge(zedCaller.id, zed.id));
    const result = await run(["callers", "put", "--all", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.candidates).toHaveLength(2);
    const group = body.candidates.find((c: any) => c.id === PUT_1).n;
    const byCandidate = (n: number) => names(body.results.filter((r: any) => r.candidate === n));
    expect(byCandidate(group)).toEqual(["alpha", "beta", "gamma", "shared"]);
    expect(byCandidate(group === 1 ? 2 : 1)).toEqual(["zeta"]);
    expect(body.summary).toMatchObject({ shown: 5, total: 5 });
    expect(body.results.find((r: any) => r.name === "zeta")).not.toHaveProperty("overload");
    expect(body.results.find((r: any) => r.name === "gamma").overload).toBe("put(String,int)");
  });
});

describe("depends, impact and trace", () => {
  it("depends: the root's dependents are every overload's; below it a node is walked as itself", async () => {
    const result = await run(["depends", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(names(body.tree)).toEqual(["alpha", "beta", "gamma", "shared"]);
    expect(body.tree.find((n: any) => n.name === "alpha").children.map((n: any) => n.name)).toEqual(["top"]);
    expect(noticesOf(result.stdout)[0].answered).toBe(3);
    // `top` is reached by an edge: expanded once, as one node.
    expect(expandCalls().filter((c) => c.startsWith(top.id))).toHaveLength(1);
  });

  it("depends on one overload's id walks that overload alone", async () => {
    const body = JSON.parse((await run(["depends", PUT_2, "--format", "json"])).stdout);
    expect(names(body.tree)).toEqual(["beta"]);
  });

  it("impact: callers and callees of every overload; one overload calling another is no dependent", async () => {
    edges.push(edge(PUT_2, PUT_1));
    const result = await run(["impact", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const text = result.stdout;
    for (const name of ["alpha", "beta", "gamma", "shared", "save", "log", "flush"]) expect(text).toContain(`"${name}"`);
    expect(noticesOf(text)[0].answered).toBe(3);
    const alone = JSON.parse((await run(["impact", PUT_2, "--format", "json"])).stdout);
    expect(JSON.stringify(alone)).not.toContain('"alpha"');
    expect(JSON.stringify(alone)).toContain('"beta"');
  });

  it("trace --to: a route may arrive at a later overload, or leave from one", async () => {
    const arrive = JSON.parse((await run(["trace", "gamma", "--to", "put", "--format", "json"])).stdout);
    expect(arrive.path.map((n: any) => n.name)).toEqual(["gamma", "put"]);
    expect(noticesOf(JSON.stringify(arrive))[0].answered).toBe(3);
    const leave = JSON.parse((await run(["trace", "put", "--to", "flush", "--format", "json"])).stdout);
    expect(leave.path.map((n: any) => n.name)).toEqual(["put", "flush"]);
    expect(leave.path[1].via).toBe("CALLS");
  });

  it("trace --upstream: the root is the group", async () => {
    const body = JSON.parse((await run(["trace", "put", "--upstream", "--kind", "calls", "--format", "json"])).stdout);
    expect(JSON.stringify(body)).toContain('"beta"');
    expect(JSON.stringify(body)).toContain('"top"');
  });
});

describe("one overload calling another", () => {
  // `put()` delegates to `put(String,int)`, which calls `flush`.
  beforeEach(() => { edges.push(edge(PUT_2, PUT_3)); });

  /** Every node of a tree, depth-first. */
  const flat = (tree: any[]): any[] => tree.flatMap((n) => [n, ...flat(n.children ?? [])]);

  it("callers and callees: the call inside the group is neither", async () => {
    const callers = JSON.parse((await run(["callers", "put", "--format", "json"])).stdout);
    expect(names(callers.results)).toEqual(["alpha", "beta", "gamma", "shared"]);
    expect(callers.summary).toMatchObject({ shown: 4, total: 4 });
    const callees = JSON.parse((await run(["callees", "put", "--format", "json"])).stdout);
    expect(names(callees.results)).toEqual(["flush", "log", "save"]);
    expect(callees.summary).toMatchObject({ shown: 3, total: 3 });
  });

  it("trace --downstream: the callee is at the root once, not under a sibling overload", async () => {
    const body = JSON.parse((await run(["trace", "put", "--downstream", "--kind", "calls", "--format", "json"])).stdout);
    const all = flat(body.tree ?? body.downstream);
    expect(names(body.tree ?? body.downstream)).toEqual(["flush", "log", "save"]);
    expect(all.map((n) => n.name)).not.toContain("put");
    expect(all.filter((n) => n.name === "flush")).toHaveLength(1);
    expect(all.some((n) => n.cycle)).toBe(false);
  });

  it("trace --downstream: an overload reached again further down is the root again", async () => {
    edges.push(edge(flush.id, PUT_1));
    const body = JSON.parse((await run(["trace", "put", "--downstream", "--kind", "calls", "--format", "json"])).stdout);
    const [again] = (body.tree ?? body.downstream).find((n: any) => n.name === "flush").children;
    expect(again).toMatchObject({ name: "put", cycle: true });
    expect(again.children ?? []).toEqual([]);
  });

  it("depends: the dependents are at the root, none of them a cycle", async () => {
    const body = JSON.parse((await run(["depends", "put", "--format", "json"])).stdout);
    expect(names(body.tree)).toEqual(["alpha", "beta", "gamma", "shared"]);
    expect(flat(body.tree).map((n) => n.name)).not.toContain("put");
    expect(flat(body.tree).some((n) => n.cycle)).toBe(false);
  });

  it("impact: the callers counted are the dependents", async () => {
    const body = JSON.parse((await run(["impact", "put", "--format", "json"])).stdout);
    expect(body.summary).toMatchObject({ callers: 4, callees: 3, dependents: 4 });
  });

  it("the merged expansion has no row and no edge for a member", async () => {
    const client = { expand: vi.fn(async (id: string, opts?: any) => expandOnce(id, opts)) };
    const graph = overloadGraph(client, [{ id: PUT_1, overloads: puts.map((p) => ({ id: p.id, signature: "" })) }]);
    const out = await graph.expand(PUT_1, { direction: "out", predicates: ["CALLS"] });
    expect(names(out.nodes)).toEqual(["flush", "log", "save"]);
    expect(out.edges.every((e: Edge) => e.src === PUT_1 && e.dst !== PUT_1)).toBe(true);
    const into = await graph.expand(PUT_1, { direction: "in", predicates: ["CALLS"] });
    expect(names(into.nodes)).toEqual(["alpha", "beta", "gamma", "shared"]);
    expect(into.edges.every((e: Edge) => e.dst === PUT_1 && e.src !== PUT_1)).toBe(true);
  });
});

describe("explain on an overload group", () => {
  it("the edges are the group's, the definition the first overload's", async () => {
    const result = await run(["explain", "put", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    // The definition is the first overload's.
    expect(body.facts).toMatchObject({ id: PUT_1, path: STORE, lineStart: 10, lineEnd: 13 });
    // The edges are every overload's.
    expect(body.facts).toMatchObject({ callerCount: 4, calleeCount: 3, dependentCount: 4 });
    expect(names(body.facts.calleeRefs)).toEqual(["flush", "log", "save"]);
    expect(body.rendered.context).toContain("Called by: 4 entities\nCalls: 3 entities");
    expect(noticesOf(result.stdout)[0]).toMatchObject({ code: "overloaded_target", answered: 3 });
    const alone = JSON.parse((await run(["explain", PUT_2, "--format", "json"])).stdout);
    expect(alone.facts).toMatchObject({ id: PUT_2, lineStart: 20, callerCount: 1, calleeCount: 1 });
    expect(noticesOf(JSON.stringify(alone))).toEqual([]);
  });
});

describe("a class with several constructors", () => {
  // The class node holds the first constructor; a later one is a node whose
  // `overload_of` is the class. Its body's calls are on its own node, and
  // nothing else is: it has no callers and no members of its own.
  const CTOR_2 = "d".repeat(32);
  const ctor2 = node(CTOR_2, "method", "Store", STORE, 5, { overload_of: storeClass.id, overload_signature: "int" });
  const size = node("m-size", "method", "size", STORE, 40);

  function storeWith(...extra: Row[]): void {
    nodes = [storeClass, size, alpha, beta, save, flush, ...extra];
    edges = [
      edge(storeClass.id, size.id, "CONTAINS"),
      edge(alpha.id, storeClass.id), edge(beta.id, storeClass.id, "REFERENCES"),
      edge(storeClass.id, save.id),
      ...(extra.length ? [edge(storeClass.id, CTOR_2, "CONTAINS"), edge(CTOR_2, flush.id), edge(CTOR_2, storeClass.id)] : []),
    ];
  }

  /** The command's output and requests for the class alone, then with a second constructor. */
  async function both(args: string[]) {
    const once = async () => {
      expand.mockClear();
      const result = await run(args);
      expect(result.exitCode).toBe(0);
      return { body: JSON.parse(result.stdout), requests: expandCalls().sort() };
    };
    storeWith();
    const plain = await once();
    storeWith(ctor2);
    return { plain, group: await once() };
  }

  it("contains: the requests and the rows of a plain class", async () => {
    const { plain, group } = await both(["contains", "Store", "--format", "json"]);
    expect(plain.requests).toEqual([`${storeClass.id} out CONTAINS`]);
    expect(group.requests).toEqual(plain.requests);
    expect(names(group.body.results)).toEqual(["Store", "size"]);
    for (const row of group.body.results) expect(row).not.toHaveProperty("overload");
    expect(group.body.resolutionNotices ?? []).toEqual([]);
  });

  it("callers: the requests and the answer of a plain class", async () => {
    const { plain, group } = await both(["callers", "Store", "--format", "json"]);
    expect(plain.requests).toContain(`${storeClass.id} in CALLS+REFERENCES`);
    expect(group.requests).toEqual(plain.requests);
    expect(group.body).toEqual(plain.body);
  });

  it("callees: one more request, for what the later constructor calls; no overload on a row", async () => {
    const { plain, group } = await both(["callees", "Store", "--format", "json"]);
    expect(plain.requests).toEqual([`${storeClass.id} out CALLS+REFERENCES`]);
    expect(group.requests).toEqual([`${storeClass.id} out CALLS+REFERENCES`, `${CTOR_2} out CALLS+REFERENCES`].sort());
    expect(names(plain.body.results)).toEqual(["save"]);
    // `new Store()` in the later constructor is the class calling itself.
    expect(names(group.body.results)).toEqual(["flush", "save"]);
    for (const row of group.body.results) expect(row).not.toHaveProperty("overload");
    expect(group.body.resolutionNotices ?? []).toEqual([]);
  });

  it("impact: nothing it asks is about what the class calls, so the requests of a plain class", async () => {
    const { plain, group } = await both(["impact", "Store", "--format", "json"]);
    expect(plain.requests.length).toBeGreaterThan(0);
    // The later constructor is a member, asked for its callers like `size`.
    expect(group.requests).toEqual([...plain.requests, `${CTOR_2} in CALLS+REFERENCES`].sort());
  });

  it("only the part of a question about outgoing calls and references reaches a later constructor", async () => {
    storeWith(ctor2);
    const client = { expand: vi.fn(async (id: string, opts?: any) => expandOnce(id, opts)) };
    const graph = overloadGraph(client, [{ id: storeClass.id, overloads: [{ id: storeClass.id }, { id: CTOR_2, signature: "int" }] }]);
    const sent = () => client.expand.mock.calls.map(([id, o]) => `${id} ${o?.direction} ${(o?.predicates ?? []).join("+")}`);
    for (const opts of [
      { direction: "in", predicates: ["CALLS", "REFERENCES"] },
      { direction: "in" },
      { direction: "out", predicates: ["CONTAINS"] },
      { direction: "both", predicates: ["IMPORTS", "EXTENDS"] },
    ]) {
      client.expand.mockClear();
      const result = await graph.expand(storeClass.id, opts);
      expect(client.expand.mock.calls).toEqual([[storeClass.id, opts]]);
      expect(overloadOfRow(result)).toBeUndefined();
    }
    // A mixed question: the class is asked all of it, the constructor its part.
    client.expand.mockClear();
    const mixed = await graph.expand(storeClass.id, { direction: "both", predicates: ["CALLS", "CONTAINS"], hops: 1 });
    expect(client.expand.mock.calls).toEqual([
      [storeClass.id, { direction: "both", predicates: ["CALLS", "CONTAINS"], hops: 1 }],
      [CTOR_2, { direction: "out", predicates: ["CALLS"], hops: 1 }],
    ]);
    // The constructor is a row as what the class contains, not as its caller.
    expect(names(mixed.nodes)).toEqual(["Store", "alpha", "flush", "save", "size"]);
    expect(mixed.edges.map((e: Edge) => e.id)).not.toContain(`${CTOR_2}>CALLS>${storeClass.id}`);
    expect(withOverloadOfRows(mixed, "Store")).toBe(mixed.nodes);
    expect(overloadOfRow(mixed)!(flush)).toBe(CTOR_2);
    // No filter at all asks for every edge, calls among them.
    client.expand.mockClear();
    await graph.expand(storeClass.id);
    expect(sent()).toEqual([`${storeClass.id} undefined `, `${CTOR_2} out CALLS+REFERENCES`]);
  });

  const classGraph = (client: { expand: (id: string, opts?: any) => Promise<any> }) =>
    overloadGraph(client, [{ id: storeClass.id, overloads: [{ id: storeClass.id }, { id: CTOR_2, signature: "int" }] }]);

  it("a mixed question into the class: no constructor row from `new Store()`, every other edge stays", async () => {
    storeWith(ctor2);
    edges.push(edge(gamma.id, storeClass.id, "IMPORTS"));
    nodes.push(gamma);
    const graph = classGraph({ expand: async (id, opts) => expandOnce(id, opts) });
    for (const opts of [{ direction: "in", predicates: ["CALLS", "IMPORTS", "REFERENCES"] }, { direction: "in" }]) {
      const result = await graph.expand(storeClass.id, opts as any);
      expect(names(result.nodes)).toEqual(["alpha", "beta", "gamma"]);
      expect(result.edges.map((e: any) => e.id)).not.toContain(`${CTOR_2}>CALLS>${storeClass.id}`);
      expect(result.edges.map((e: any) => e.predicate)).toContain("IMPORTS");
    }
  });

  it("a question without calls or references is the class's answer untouched", async () => {
    storeWith(ctor2);
    const answer = expandOnce(storeClass.id, { direction: "in", predicates: ["IMPORTS"] });
    const graph = classGraph({ expand: async () => answer });
    expect(await graph.expand(storeClass.id, { direction: "in", predicates: ["IMPORTS"] })).toBe(answer);
  });

  it("the class's own edge to itself is kept, on both paths", async () => {
    storeWith(ctor2);
    edges.push(edge(storeClass.id, storeClass.id));
    const graph = classGraph({ expand: async (id, opts) => expandOnce(id, opts) });
    const into = await graph.expand(storeClass.id, { direction: "in", predicates: ["CALLS"] });
    expect(into.edges.map((e: any) => e.id)).toContain(`${storeClass.id}>CALLS>${storeClass.id}`);
    expect(names(into.nodes)).toContain("Store");
    expect(into.nodes.map((n: any) => n.id)).not.toContain(CTOR_2);
    const out = await graph.expand(storeClass.id, { direction: "out", predicates: ["CALLS"] });
    expect(out.edges.filter((e: any) => e.src === storeClass.id && e.dst === storeClass.id)).toHaveLength(1);
    expect(out.nodes.map((n: any) => n.id)).toContain(storeClass.id);
    expect(out.nodes.map((n: any) => n.id)).not.toContain(CTOR_2);
  });

  it("depends, trace and explain: a later constructor's `new Store()` is no dependent or caller", async () => {
    storeWith(ctor2);
    const depends = JSON.parse((await run(["depends", "Store", "--format", "json"])).stdout);
    expect(JSON.stringify(depends)).not.toContain(CTOR_2);
    expect(JSON.stringify(depends)).toContain("alpha");
    const trace = await run(["trace", "Store", "--upstream", "--format", "json"]);
    expect(trace.exitCode).toBe(0);
    expect(trace.stdout).not.toContain(CTOR_2);
    expect(trace.stdout).toContain("alpha");
    const explain = JSON.parse((await run(["explain", "Store", "--format", "json"])).stdout);
    expect(explain.facts.callerCount).toBe(1);
    expect(explain.facts.dependentCount).toBe(2);
    expect(JSON.stringify(explain.facts.callerRefs ?? [])).not.toContain(CTOR_2);
  });
});

describe("overloadGraph", () => {
  const group = { id: PUT_1, name: "put", overloads: puts.map((p) => ({ id: p.id, signature: String(p.attrs.overload_signature) })) };

  it("merges one expansion per overload: neighbours once, edges as the one node's", async () => {
    const client = { expand: vi.fn(async (id: string, opts?: any) => expandOnce(id, opts)), entity: vi.fn() };
    const graph = overloadGraph(client, [group]);
    const result = await graph.expand(PUT_1, { direction: "in", predicates: ["CALLS"] });
    expect(client.expand).toHaveBeenCalledTimes(3);
    expect(names(result.nodes)).toEqual(["alpha", "beta", "gamma", "shared"]);
    // Every edge ends at the resolved id, and `shared`'s two are one.
    expect(result.edges.map((e: Edge) => `${e.src}>${e.dst}`).sort()).toEqual(
      [alpha, beta, gamma, shared].map((n) => `${n.id}>${PUT_1}`).sort(),
    );
    expect(overloadOfRow(result)!(gamma)).toBe(PUT_3);
    expect(overloadOfRow(result)!(shared)).toBe(PUT_1);
    expect(withOverloadOfRows(result, "put").find((r) => r.id === beta.id)).toMatchObject({ overload: "put()" });
    expect(answeredIds(graph, PUT_1)).toEqual([PUT_1, PUT_2, PUT_3]);
  });

  it("any other id, and where the method is, are one request as before", async () => {
    const client = { expand: vi.fn(async (id: string, opts?: any) => expandOnce(id, opts)) };
    const graph = overloadGraph(client, [group]);
    const single = await graph.expand(PUT_3, { direction: "in", predicates: ["CALLS"] });
    expect(names(single.nodes)).toEqual(["gamma", "shared"]);
    expect(overloadOfRow(single)).toBeUndefined();
    expect(withOverloadOfRows(single, "put")).toBe(single.nodes);
    const owner = await graph.expand(PUT_1, { direction: "in", predicates: ["CONTAINS"] });
    expect(owner.nodes).toEqual([storeClass]);
    expect(client.expand).toHaveBeenCalledTimes(2);
  });

  it("an expansion the server cut is still cut after the merge", async () => {
    const client = { expand: vi.fn(async (id: string, opts?: any) => ({ ...expandOnce(id, opts), ...(id === PUT_2 ? { truncated: true } : {}) })) };
    const result = await overloadGraph(client, [group]).expand(PUT_1, { direction: "in", predicates: ["CALLS"] });
    expect(result).toMatchObject({ truncated: true });
  });

  it("past one hop only an overload's own neighbours are its rows", async () => {
    const client = {
      expand: vi.fn(async (id: string, _opts?: unknown) => (id === PUT_1
        ? { nodes: [alpha, top], edges: [edge(alpha.id, PUT_1), edge(top.id, alpha.id)] }
        : { nodes: [], edges: [] }) as any),
    };
    const result = await overloadGraph(client, [group]).expand(PUT_1, { direction: "in", predicates: ["CALLS"], hops: 2 });
    expect(overloadOfRow(result)!(alpha)).toBe(PUT_1);
    expect(overloadOfRow(result)!(top)).toBeUndefined();
    expect(result.edges).toHaveLength(2);
  });
});
