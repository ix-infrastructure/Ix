// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerCallersCommand } from "../commands/callers.js";

/**
 * `ix callers` on a Java method also lists the callers of the same-named
 * method on each supertype (interface or superclass): a call typed against
 * the supertype may run this implementation. Those rows carry `via` (json) /
 * `via=` (llm); everything else about the output stays as it was.
 */

type Node = { id: string; kind: string; name: string; attrs: Record<string, unknown> };

const { graph, target, rgMatches } = vi.hoisted(() => ({
  graph: { value: new Map<string, unknown[]>(), calls: [] as string[] },
  target: { value: {} as Record<string, unknown> },
  rgMatches: { value: [] as Array<[string, number, string]> },
}));

vi.mock("../../client/factory.js", () => ({
  createClient: () => ({
    expand: async (id: string, opts: { direction: string; predicates: string[] }) => {
      const key = `${id} ${opts.direction} ${opts.predicates.join(",")}`;
      graph.calls.push(key);
      return { nodes: graph.value.get(key) ?? [], edges: [] };
    },
  }),
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveTargetSetOrReport: async (_client: unknown, _symbol: string, opts: { all?: boolean }) =>
    opts.all ? { entities: [{ ...target.value, n: 1 }], all: { total: 1 } } : { entities: [target.value] },
  printResolved: () => {},
}));
vi.mock("../graph-health.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph-health.js")>(),
  checkGraphHealth: async () => ({ status: "healthy" }),
}));
vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  resolveWorkspaceRoot: () => "/ws",
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
    const stdout = rgMatches.value.map(([path, line, text]) => JSON.stringify({
      type: "match", data: { path: { text: path }, line_number: line, lines: { text: `${text}\n` } },
    })).join("\n");
    cb(null, { stdout, stderr: "" });
  },
}));

const node = (id: string, kind: string, name: string, path: string, line: number): Node =>
  ({ id, kind, name, attrs: { path, line_start: line, line_end: line + 2 } });

const IMPL = { id: "impl-getUrl", kind: "method", name: "getUrl", path: "src/rpc/TimeoutInvoker.java", resolutionMode: "exact" };
const OWNER = node("cls-TimeoutInvoker", "class", "TimeoutInvoker", "src/rpc/TimeoutInvoker.java", 3);
const ABSTRACT = node("cls-AbstractInvoker", "class", "AbstractInvoker", "src/rpc/AbstractInvoker.java", 3);
const IFACE = node("ifc-Invoker", "interface", "Invoker", "src/rpc/Invoker.java", 3);
const NODE = node("ifc-Node", "interface", "Node", "src/common/Node.java", 3);
const FILTER = node("m-Filter.invoke", "method", "invoke", "src/rpc/Filter.java", 10);
const WRAP = node("m-Base.wrap", "method", "wrap", "src/rpc/Base.java", 20);
const SELECT = node("m-Cluster.select", "method", "select", "src/cluster/Cluster.java", 30);

function javaGraph(): Map<string, unknown[]> {
  return new Map<string, unknown[]>([
    // Direct callers of the implementation.
    [`${IMPL.id} in CALLS,REFERENCES`, [FILTER]],
    [`${IMPL.id} in CONTAINS`, [OWNER]],
    // TimeoutInvoker extends AbstractInvoker implements Invoker; AbstractInvoker implements Invoker; Invoker extends Node.
    [`${OWNER.id} out EXTENDS`, [IFACE, ABSTRACT]],
    [`${ABSTRACT.id} out EXTENDS`, [IFACE]],
    [`${IFACE.id} out EXTENDS`, [NODE]],
    [`${ABSTRACT.id} out CONTAINS`, [node("m-AbstractInvoker.getUrl", "method", "getUrl", "src/rpc/AbstractInvoker.java", 5)]],
    [`${IFACE.id} out CONTAINS`, [node("m-Invoker.getUrl", "method", "getUrl", "src/rpc/Invoker.java", 4), node("m-Invoker.invoke", "method", "invoke", "src/rpc/Invoker.java", 5)]],
    [`${NODE.id} out CONTAINS`, [node("m-Node.isAvailable", "method", "isAvailable", "src/common/Node.java", 4)]],
    // FILTER also calls through the superclass: it stays a direct row.
    ["m-AbstractInvoker.getUrl in CALLS", [WRAP, FILTER]],
    ["m-Invoker.getUrl in CALLS", [SELECT, WRAP]],
  ]);
}

async function run(args: string[]): Promise<{ out: string[]; exitCode: number | undefined }> {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.exitCode = undefined;
  await program.parseAsync(["callers", "getUrl", ...args], { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out, exitCode: exitCode === 0 ? undefined : exitCode as number | undefined };
}

const json = (out: string[]) => JSON.parse(out.join("\n"));

describe("ix callers dispatch rows (Java)", () => {
  beforeEach(() => {
    graph.value = javaGraph();
    graph.calls = [];
    target.value = IMPL;
    rgMatches.value = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists callers through a superclass and an interface after the direct ones, flagged with via", async () => {
    const { out, exitCode } = await run(["--format", "json"]);
    const body = json(out);
    expect(body.results.map((r: any) => [r.name, r.via])).toEqual([
      ["invoke", undefined],
      ["wrap", "AbstractInvoker.getUrl"],
      ["select", "Invoker.getUrl"],
    ]);
    expect(Object.keys(body.results[0])).not.toContain("via");
    expect(body.results[1]).toMatchObject({ name: "wrap", path: "src/rpc/Base.java", lineStart: 20, via: "AbstractInvoker.getUrl" });
    expect(body.summary).toMatchObject({ shown: 3, total: 3, resolved: 3 });
    expect(body.resultSource).toBe("graph");
    expect(exitCode).toBeUndefined();
  });

  it("prints via= on dispatch ref lines only (llm)", async () => {
    const { out } = await run(["--format", "llm"]);
    expect(out[0]).toBe("callers target=getUrl shown=3 total=3 resolved=3");
    const refs = out.filter((l) => l.startsWith("ref "));
    expect(refs).toHaveLength(3);
    expect(refs[0]).not.toContain("via=");
    expect(refs[1]).toMatch(/^ref name=wrap .* via=AbstractInvoker\.getUrl$/);
    expect(refs[2]).toMatch(/^ref name=select .* via=Invoker\.getUrl$/);
  });

  it("shows a dim (via X) suffix in text", async () => {
    const { out } = await run([]);
    expect(out.find((l) => l.includes("wrap"))).toContain("(via AbstractInvoker.getUrl)");
    expect(out.find((l) => l.includes("invoke"))).not.toContain("(via");
  });

  it("answers from dispatch rows when the implementation has no direct caller, without the text fallback", async () => {
    graph.value.delete(`${IMPL.id} in CALLS,REFERENCES`);
    rgMatches.value = [["src/x.java", 1, "x.getUrl();"]];
    const body = json((await run(["--format", "json"])).out);
    expect(body.resultSource).toBe("graph");
    expect(body.results.map((r: any) => [r.name, r.via])).toEqual([
      ["wrap", "AbstractInvoker.getUrl"], ["invoke", "AbstractInvoker.getUrl"], ["select", "Invoker.getUrl"],
    ]);
  });

  it("walks a bounded, cycle-safe supertype graph", async () => {
    graph.value.set(`${NODE.id} out EXTENDS`, [OWNER, IFACE]);
    await run(["--format", "json"]);
    // One EXTENDS expand per type, each type once.
    expect(graph.calls.filter((c) => c.endsWith("out EXTENDS")).sort()).toEqual([
      `${ABSTRACT.id} out EXTENDS`, `${IFACE.id} out EXTENDS`, `${NODE.id} out EXTENDS`, `${OWNER.id} out EXTENDS`,
    ].sort());
  });

  it("applies under --all too, per candidate", async () => {
    const body = json((await run(["--all", "--format", "json"])).out);
    expect(body.results.map((r: any) => [r.name, r.candidate, r.via])).toEqual([
      ["invoke", 1, undefined],
      ["wrap", 1, "AbstractInvoker.getUrl"],
      ["select", 1, "Invoker.getUrl"],
    ]);
  });

  it("costs two requests for a Java class with no supertype, and none for another language", async () => {
    graph.value.delete(`${OWNER.id} out EXTENDS`);
    await run(["--format", "json"]);
    expect(graph.calls).toEqual([`${IMPL.id} in CALLS,REFERENCES`, `${IMPL.id} in CONTAINS`, `${OWNER.id} out EXTENDS`]);
    graph.calls = [];
    target.value = { ...IMPL, path: "src/rpc/timeout.ts" };
    await run(["--format", "json"]);
    expect(graph.calls).toEqual([`${IMPL.id} in CALLS,REFERENCES`]);
  });
});

/**
 * The output contract plugins read: unchanged by dispatch rows wherever there
 * are none. These expectations held before dispatch rows existed.
 */
describe("ix callers output contract", () => {
  beforeEach(() => {
    graph.calls = [];
    rgMatches.value = [];
    target.value = { id: "fn-foo", kind: "function", name: "getUrl", path: "src/a.ts", resolutionMode: "exact" };
  });
  afterEach(() => vi.restoreAllMocks());

  it("direct callers: json keys, llm line shapes and exit code", async () => {
    graph.value = new Map([["fn-foo in CALLS,REFERENCES", [node("m-a", "function", "main", "src/main.ts", 4)]]]);
    const j = await run(["--format", "json"]);
    const body = json(j.out);
    expect(Object.keys(body)).toEqual(["results", "resultSource", "resolvedTarget", "summary"]);
    expect(Object.keys(body.results[0])).toEqual(["name", "kind", "id", "path", "lineStart", "lineEnd"]);
    expect(Object.keys(body.summary)).toEqual(["shown", "total", "resolved", "unresolved", "truncated", "offset"]);
    expect(j.exitCode).toBeUndefined();
    const l = await run(["--format", "llm"]);
    expect(l.out).toEqual([
      "callers target=getUrl shown=1 total=1 resolved=1",
      "ref name=main kind=function path=src/main.ts lines=4-6",
    ]);
    expect(l.exitCode).toBeUndefined();
  });

  it("an unresolved caller row: json keys, llm line shape and exit code", async () => {
    graph.value = new Map([["fn-foo in CALLS,REFERENCES", [{ id: "0123abcd-0000-0000-0000-000000000000", kind: "function", name: "0123abcd-0000-0000-0000-000000000000", attrs: {} }]]]);
    const j = await run(["--format", "json"]);
    const body = json(j.out);
    expect(Object.keys(body)).toEqual(["results", "resultSource", "resolvedTarget", "diagnostics", "summary"]);
    expect(Object.keys(body.results[0])).toEqual(["kind", "resolved", "rawId", "diagnostic"]);
    expect(body.diagnostics.map((d: any) => d.code)).toEqual(["dangling_reference_filtered"]);
    expect(Object.keys(body.summary)).toEqual(["shown", "total", "resolved", "unresolved", "truncated", "offset"]);
    expect(j.exitCode).toBeUndefined();
    const l = await run(["--format", "llm"]);
    expect(l.out).toEqual(["callers target=getUrl shown=1 total=1 resolved=0 unresolved=1", "ref kind=function id=0123abcd resolved=false"]);
  });

  it("no graph callers: the text fallback keeps its keys, lines and exit code", async () => {
    graph.value = new Map();
    rgMatches.value = [["src/b.ts", 3, "getUrl();"]];
    const j = await run(["--format", "json"]);
    const body = json(j.out);
    expect(Object.keys(body)).toEqual(["results", "resultSource", "resolvedTarget", "summary", "diagnostics"]);
    expect(body.resultSource).toBe("text");
    expect(Object.keys(body.results[0])).toEqual(["id", "kind", "name", "resolved", "path", "line", "attrs"]);
    expect(Object.keys(body.summary)).toEqual(["candidatesFound", "candidatesReturned"]);
    expect(body.diagnostics.map((d: any) => d.code)).toEqual(["text_fallback_used"]);
    expect(j.exitCode).toBeUndefined();
    const l = await run(["--format", "llm"]);
    expect(l.out).toEqual([
      "callers target=getUrl source=text shown=1 total=1",
      'diagnostic code=text_fallback_used message="No graph-backed CALLS/REFERENCES edges; showing text matches."',
      "ref path=src/b.ts line=3 snippet=getUrl();",
    ]);
  });
});
