// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerOverridesCommand } from "../commands/overrides.js";
import { WorkspaceNotMappedError } from "../errors.js";
import {
  HIERARCHY_DEPTH, HIERARCHY_MAX_REQUESTS, HIERARCHY_MAX_TYPES, HIERARCHY_UP_MAX_TYPES, headerDeclaresBase, overrideFamily,
} from "../type-walk.js";

/**
 * `ix overrides <method>`: the other definitions of a method, read from the
 * EXTENDS and CONTAINS edges around its type. Up (`overrides`/`implements`),
 * down (`overridden_by`) and across from the root (`sibling`, via the root's
 * `Type.m`).
 */

type Node = { id: string; kind: string; name: string; attrs: Record<string, unknown> };

const { graph, target, sources, resolveError } = vi.hoisted(() => ({
  graph: { value: new Map<string, Node[]>(), calls: [] as string[] },
  target: { value: {} as Record<string, unknown> },
  sources: { value: new Map<string, string[]>() },
  resolveError: { value: undefined as Error | undefined },
}));

const client = {
  expand: async (id: string, opts: { direction: string; predicates: string[] }) => {
    const key = `${id} ${opts.direction} ${opts.predicates.join(",")}`;
    graph.calls.push(key);
    return { nodes: graph.value.get(key) ?? [], edges: [] };
  },
};

vi.mock("../../client/factory.js", () => ({ createClient: () => client }));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveFileOrReport: async () => {
    if (resolveError.value) throw resolveError.value;
    return target.value;
  },
  printResolved: () => {},
}));
vi.mock("../edge-sites.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../edge-sites.js")>(),
  SourceFiles: class {
    lines(path: string | undefined) { return (path && sources.value.get(path)) || null; }
  },
}));

const node = (id: string, kind: string, name: string, path: string, line = 1): Node =>
  ({ id, kind, name, attrs: { path, line_start: line, line_end: line + 2 } });
const type = (name: string, path: string, kind = "class"): Node => node(`t-${name}`, kind, name, path, 1);
const method = (owner: Node, name: string, line = 5, id = `m-${owner.name}.${name}`): Node =>
  node(id, "method", name, String(owner.attrs.path), line);

/** A graph with both directions of every edge, the way the backend answers expand. */
class Graph {
  readonly map = new Map<string, Node[]>();
  private add(key: string, n: Node) { this.map.set(key, [...(this.map.get(key) ?? []), n]); }
  extends(child: Node, ...parents: Node[]): this {
    for (const p of parents) {
      this.add(`${child.id} out EXTENDS`, p);
      this.add(`${p.id} in EXTENDS`, child);
    }
    return this;
  }
  contains(owner: Node, ...members: Node[]): this {
    for (const m of members) {
      this.add(`${owner.id} out CONTAINS`, m);
      this.add(`${m.id} in CONTAINS`, owner);
    }
    return this;
  }
}

// Base.m <- Mid.m <- Leaf.m, and Other.m under Base: a three-level Python family.
const BASE = type("Base", "pkg/base.py");
const MID = type("Mid", "pkg/mid.py");
const LEAF = type("Leaf", "pkg/leaf.py");
const OTHER = type("Other", "pkg/other.py");
const MID_M = method(MID, "m");
const LEAF_M = method(LEAF, "m");

function threeLevels(): Graph {
  return new Graph()
    .extends(MID, BASE).extends(LEAF, MID).extends(OTHER, BASE)
    .contains(BASE, method(BASE, "m", 3), method(BASE, "helper", 9))
    .contains(MID, MID_M)
    .contains(LEAF, LEAF_M)
    .contains(OTHER, method(OTHER, "m", 7));
}

const asTarget = (m: Node) => ({ id: m.id, kind: m.kind, name: m.name, path: m.attrs.path, resolutionMode: "exact" });

async function run(args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number }> {
  const program = new Command().name("ix").exitOverride();
  registerOverridesCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(((part: string) => { err.push(String(part)); return true; }) as never);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out, err, exitCode };
}

const json = (out: string[]) => JSON.parse(out.join("\n"));
const brief = (rows: any[]) => rows.map((r) => [r.relation, `${r.owner.name}.${r.name}`, r.depth, r.via]);

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  graph.value = threeLevels().map;
  graph.calls = [];
  target.value = asTarget(MID_M);
  sources.value = new Map();
  resolveError.value = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe("ix overrides on a three-level hierarchy", () => {
  it("lists the base it overrides, the override below it and the sibling via the root (json)", async () => {
    const { out, exitCode } = await run(["overrides", "m", "--path", "pkg/mid.py", "--format", "json"]);
    expect(exitCode).toBe(0);
    const body = json(out);
    expect(brief(body.rows)).toEqual([
      ["overrides", "Base.m", 1, undefined],
      ["overridden_by", "Leaf.m", 1, undefined],
      ["sibling", "Other.m", 1, "Base.m"],
    ]);
    expect(body.rows[0]).toEqual({
      name: "m", kind: "method", id: "m-Base.m", path: "pkg/base.py", lineStart: 3, lineEnd: 5,
      owner: { name: "Base", kind: "class", id: "t-Base" }, relation: "overrides", depth: 1,
    });
    expect(body).toMatchObject({
      target: "m", owner: { id: "t-Mid", name: "Mid", kind: "class", path: "pkg/mid.py" }, root: "Base.m",
      total: 3, truncated: false, diagnostics: [],
    });
    expect(body.resolvedTarget).toMatchObject({ id: MID_M.id, name: "m" });
    // About a dozen requests for a typical family, never one per row.
    expect(graph.calls.length).toBeLessThanOrEqual(11);
  });

  it("counts depth from the target's type up and down, and from the root across", async () => {
    target.value = asTarget(LEAF_M);
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(brief(body.rows)).toEqual([
      ["overrides", "Mid.m", 1, undefined],
      ["overrides", "Base.m", 2, undefined],
      ["sibling", "Other.m", 1, "Base.m"],
    ]);
  });

  it("from the root: every override below it, nothing above", async () => {
    target.value = asTarget(method(BASE, "m", 3));
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(brief(body.rows)).toEqual([
      ["overridden_by", "Mid.m", 1, undefined],
      ["overridden_by", "Other.m", 1, undefined],
      ["overridden_by", "Leaf.m", 2, undefined],
    ]);
    expect(body.root).toBeUndefined();
  });

  it("prints one override record per row (llm)", async () => {
    const { out } = await run(["overrides", "m", "--format", "llm"]);
    expect(out).toEqual([
      "overrides target=Mid.m owner=Mid root=Base.m shown=3 total=3",
      "override name=m relation=overrides owner=Base kind=method path=pkg/base.py lines=3-5 depth=1",
      "override name=m relation=overridden_by owner=Leaf kind=method path=pkg/leaf.py lines=5-7 depth=1",
      "override name=m relation=sibling owner=Other kind=method path=pkg/other.py lines=7-9 depth=1 via=Base.m",
    ]);
  });

  it("groups rows by relation with path:line (text)", async () => {
    const { out } = await run(["overrides", "m"]);
    const text = out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("Overrides of Mid.m:");
    expect(text).toMatch(/ {2}overrides\n {4}Base\.m {2}pkg\/base\.py:3-5 {2}depth 1/);
    expect(text).toMatch(/ {2}overridden by\n {4}Leaf\.m {2}pkg\/leaf\.py:5-7 {2}depth 1/);
    expect(text).toMatch(/ {2}siblings \(via Base\.m\)\n {4}Other\.m {2}pkg\/other\.py:7-9 {2}depth 1/);
  });

  it("answers under the implementations alias", async () => {
    const body = json((await run(["implementations", "m", "--format", "json"])).out);
    expect(body.total).toBe(3);
  });

  it("answers several targets in one call, grouped per target", async () => {
    const body = json((await run(["overrides", "m", "m", "--format", "json"])).out);
    expect(body.targets.map((t: any) => [t.target, t.exitCode, t.total])).toEqual([["m", 0, 3], ["m", 0, 3]]);
    expect(body.summary).toMatchObject({ total: 2, ok: 2 });
  });

  it("cuts to --limit and says so", async () => {
    const body = json((await run(["overrides", "m", "--limit", "1", "--format", "json"])).out);
    expect(body.rows).toHaveLength(1);
    expect(body).toMatchObject({ total: 3, truncated: true });
    expect(body.diagnostics.map((d: any) => d.code)).toEqual(["results_truncated"]);
  });
});

describe("interfaces", () => {
  const RUNNABLE = type("Runnable", "src/Runnable.ts", "interface");
  const TASK = type("Task", "src/Task.ts");
  const RUN = method(TASK, "run");

  it("an interface that declares the method gives an implements row", async () => {
    graph.value = new Graph().extends(TASK, RUNNABLE).contains(RUNNABLE, method(RUNNABLE, "run", 2)).contains(TASK, RUN).map;
    target.value = asTarget(RUN);
    const body = json((await run(["overrides", "run", "--format", "json"])).out);
    expect(brief(body.rows)).toEqual([["implements", "Runnable.run", 1, undefined]]);
  });

  it("a supertype whose kind the graph gives as class is overridden, not implemented", async () => {
    // Languages without an interface kind (Python ABCs, C++ pure virtual bases,
    // a struct-kind Go interface) store the base as a class: the row says
    // `overrides`, which is still the definition that moves with the target.
    const abstract = type("Runnable", "src/Runnable.ts", "class");
    graph.value = new Graph().extends(TASK, abstract).contains(abstract, method(abstract, "run", 2)).contains(TASK, RUN).map;
    target.value = asTarget(RUN);
    const body = json((await run(["overrides", "run", "--format", "json"])).out);
    expect(brief(body.rows)).toEqual([["overrides", "Runnable.run", 1, undefined]]);
  });

  it("siblings of an interface method are the other implementations", async () => {
    const other = type("Job", "src/Job.ts");
    graph.value = new Graph()
      .extends(TASK, RUNNABLE).extends(other, RUNNABLE)
      .contains(RUNNABLE, method(RUNNABLE, "run", 2)).contains(TASK, RUN).contains(other, method(other, "run"))
      .map;
    target.value = asTarget(RUN);
    const body = json((await run(["overrides", "run", "--format", "json"])).out);
    expect(brief(body.rows)).toEqual([
      ["implements", "Runnable.run", 1, undefined],
      ["sibling", "Job.run", 1, "Runnable.run"],
    ]);
  });
});

describe("no family to report", () => {
  it("a free function: exit 0, no rows, no_owner_type", async () => {
    const fn = node("f-helper", "function", "helper", "pkg/util.py");
    graph.value = new Map([[`${fn.id} in CONTAINS`, [node("file-util", "file", "util.py", "pkg/util.py")]]]);
    target.value = asTarget(fn);
    const { out, exitCode } = await run(["overrides", "helper", "--format", "json"]);
    expect(exitCode).toBe(0);
    const body = json(out);
    expect(body).toMatchObject({ rows: [], total: 0, truncated: false });
    expect(body.owner).toBeUndefined();
    expect(body.diagnostics.map((d: any) => d.code)).toEqual(["no_owner_type"]);
    expect(graph.calls).toEqual([`${fn.id} in CONTAINS`]);

    const llm = await run(["overrides", "helper", "--format", "llm"]);
    expect(llm.exitCode).toBe(0);
    expect(llm.out[0]).toBe("overrides target=helper shown=0 total=0");
    expect(llm.out[1]).toMatch(/^diagnostic code=no_owner_type message=/);

    const text = await run(["overrides", "helper"]);
    expect(text.out.join("\n")).toContain("is not a member of a class");
  });

  it("a class with no heritage costs three requests", async () => {
    const alone = type("Alone", "pkg/alone.py");
    const m = method(alone, "m");
    graph.value = new Graph().contains(alone, m).map;
    target.value = asTarget(m);
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(body).toMatchObject({ rows: [], total: 0, diagnostics: [] });
    expect(graph.calls).toHaveLength(3);
  });

  it("an unmapped workspace keeps its own code (4) per target", async () => {
    resolveError.value = new WorkspaceNotMappedError("/elsewhere", "Run `ix map`.");
    const body = json((await run(["overrides", "a", "b", "--format", "json"])).out);
    expect(body.targets.map((t: any) => [t.exitCode, t.error])).toEqual([[4, "workspace_not_mapped"], [4, "workspace_not_mapped"]]);
    // One target: the error reaches the process boundary (renderCliError), which exits 4.
    await expect(run(["overrides", "a", "--format", "json"])).rejects.toBeInstanceOf(WorkspaceNotMappedError);
  });
});

describe("bounds", () => {
  it("stops at the supertype cap, says so, and keeps requests bounded", async () => {
    const owner = type("Owner", "src/Owner.java");
    const target_m = method(owner, "m");
    const g = new Graph().contains(owner, target_m);
    const parents = Array.from({ length: 40 }, (_, i) => type(`P${String(i).padStart(2, "0")}`, `src/P${i}.java`));
    const children = Array.from({ length: 60 }, (_, i) => type(`C${String(i).padStart(2, "0")}`, `src/C${i}.java`));
    for (const p of parents) g.extends(owner, p).contains(p, method(p, "m"));
    for (const c of children) g.extends(c, owner).contains(c, method(c, "m"));
    // Every parent has 10 more subtypes, all candidates for siblings.
    parents.forEach((p, i) => {
      for (let j = 0; j < 10; j++) {
        const s = type(`S${i}_${j}`, `src/S${i}_${j}.java`);
        g.extends(s, p).contains(s, method(s, "m"));
      }
    });
    graph.value = g.map;
    target.value = asTarget(target_m);

    const body = json((await run(["overrides", "m", "--limit", "500", "--format", "json"])).out);
    const up = body.rows.filter((r: any) => r.relation === "overrides");
    expect(up).toHaveLength(HIERARCHY_UP_MAX_TYPES);
    const owners = new Set(body.rows.map((r: any) => r.owner.id));
    expect(owners.size).toBeLessThanOrEqual(HIERARCHY_MAX_TYPES - 1);
    expect(body.truncated).toBe(true);
    expect(body.diagnostics).toContainEqual(expect.objectContaining({ code: "hierarchy_truncated", cap: "types" }));
    expect(graph.calls.length).toBeLessThanOrEqual(HIERARCHY_MAX_REQUESTS);
    expect(HIERARCHY_MAX_REQUESTS).toBeLessThanOrEqual(82);
  });

  it("stays within the request bound on a dense, cyclic graph", async () => {
    // 300 types, each extending three others picked by a fixed LCG: cycles,
    // diamonds and wide levels in every direction.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 300;
    const types = Array.from({ length: 300 }, (_, i) => type(`T${i}`, `src/T${i}.java`));
    const g = new Graph();
    types.forEach((t, i) => {
      g.contains(t, method(t, "m"));
      for (let k = 0; k < 3; k++) {
        const p = next();
        if (p !== i) g.extends(t, types[p]);
      }
    });
    graph.value = g.map;
    target.value = asTarget(method(types[0], "m"));
    const body = json((await run(["overrides", "m", "--limit", "500", "--format", "json"])).out);
    const owners = body.rows.map((r: any) => r.owner.id);
    expect(new Set(owners).size).toBe(owners.length);
    expect(owners).not.toContain(types[0].id);
    expect(owners.length).toBeLessThanOrEqual(HIERARCHY_MAX_TYPES - 1);
    expect(body.truncated).toBe(true);
    expect(graph.calls.length).toBeLessThanOrEqual(HIERARCHY_MAX_REQUESTS);
    // No expand is ever sent twice for the same node and direction.
    expect(new Set(graph.calls).size).toBe(graph.calls.length);
  });

  it("stops at the depth cap and says so", async () => {
    const chain = Array.from({ length: HIERARCHY_DEPTH + 3 }, (_, i) => type(`L${i}`, `pkg/l${i}.py`));
    const g = new Graph();
    chain.forEach((t, i) => {
      g.contains(t, method(t, "m"));
      if (i > 0) g.extends(chain[i - 1], t);
    });
    graph.value = g.map;
    target.value = asTarget(method(chain[0], "m"));
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(body.rows.map((r: any) => r.depth)).toEqual([1, 2, 3, 4, 5]);
    expect(body.diagnostics).toEqual([expect.objectContaining({ code: "hierarchy_truncated", cap: "depth" })]);
  });

  it("a hierarchy exactly as deep as the cap is not truncated", async () => {
    const chain = Array.from({ length: HIERARCHY_DEPTH + 1 }, (_, i) => type(`L${i}`, `pkg/l${i}.py`));
    const g = new Graph();
    chain.forEach((t, i) => {
      g.contains(t, method(t, "m"));
      if (i > 0) g.extends(chain[i - 1], t);
    });
    graph.value = g.map;
    target.value = asTarget(method(chain[0], "m"));
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(body.rows).toHaveLength(HIERARCHY_DEPTH);
    expect(body.truncated).toBe(false);
  });

  it("terminates on an EXTENDS cycle and lists each type once", async () => {
    const a = type("A", "pkg/a.py");
    const b = type("B", "pkg/b.py");
    const c = type("C", "pkg/c.py");
    const am = method(a, "m");
    // A -> B -> C -> A, all declaring m.
    graph.value = new Graph().extends(a, b).extends(b, c).extends(c, a)
      .contains(a, am).contains(b, method(b, "m")).contains(c, method(c, "m")).map;
    target.value = asTarget(am);
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    const owners = body.rows.map((r: any) => r.owner.name);
    expect(new Set(owners).size).toBe(owners.length);
    expect(owners.sort()).toEqual(["B", "C"]);
    expect(graph.calls.length).toBeLessThan(20);
  });

  it("a diamond lists the shared base once", async () => {
    const base = type("Base", "pkg/base.py");
    const left = type("Left", "pkg/left.py");
    const right = type("Right", "pkg/right.py");
    const leaf = type("Leaf", "pkg/leaf.py");
    const m = method(leaf, "m");
    graph.value = new Graph().extends(left, base).extends(right, base).extends(leaf, left, right)
      .contains(base, method(base, "m")).contains(leaf, m).map;
    target.value = asTarget(m);
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(brief(body.rows)).toEqual([["overrides", "Base.m", 2, undefined]]);
  });

  it("matches types by id: a same-named class elsewhere is not in the family", async () => {
    const base = type("Base", "pkg/base.py");
    const otherBase = { ...type("Base", "vendor/base.py"), id: "t-Base-vendor" };
    const kid = type("Kid", "pkg/kid.py");
    const m = method(kid, "m");
    graph.value = new Graph().extends(kid, base).contains(base, method(base, "m"))
      .contains(otherBase, method(otherBase, "m", 5, "m-vendor-Base.m")).contains(kid, m).map;
    target.value = asTarget(m);
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(body.rows.map((r: any) => r.id)).toEqual(["m-Base.m"]);
  });
});

describe("diagnostics", () => {
  it("overloads_not_distinguished when a Java type declares the method twice", async () => {
    const base = type("Handler", "src/Handler.java");
    const impl = type("JsonHandler", "src/JsonHandler.java");
    const m = method(impl, "handle", 5);
    graph.value = new Graph().extends(impl, base)
      .contains(base, method(base, "handle", 3))
      .contains(impl, m, method(impl, "handle", 12, "m-JsonHandler.handle(String)"))
      .map;
    target.value = asTarget(m);
    const body = json((await run(["overrides", "handle", "--format", "json"])).out);
    expect(body.diagnostics).toEqual([expect.objectContaining({ code: "overloads_not_distinguished" })]);
    expect(body.diagnostics[0].message).toContain("JsonHandler");
    // The overload in the target's own type is not a row: it is not an override.
    expect(brief(body.rows)).toEqual([["overrides", "Handler.handle", 1, undefined]]);
  });

  it("no overload diagnostic for a language without overloads", async () => {
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(body.diagnostics).toEqual([]);
  });

  it("heritage_not_in_graph when the header names a base the graph has no edge for", async () => {
    const stale = type("Mid", "pkg/stale.py");
    const m = method(stale, "m");
    graph.value = new Graph().contains(stale, m).map;
    target.value = asTarget(m);
    sources.value = new Map([["pkg/stale.py", ["class Mid(Base):", "    def m(self):", "        pass"]]]);
    const body = json((await run(["overrides", "m", "--format", "json"])).out);
    expect(body.diagnostics).toEqual([expect.objectContaining({ code: "heritage_not_in_graph" })]);
    expect(body.diagnostics[0].message).toContain("pkg/stale.py:1");

    sources.value = new Map([["pkg/stale.py", ["class Mid:", "    def m(self):"]]]);
    expect(json((await run(["overrides", "m", "--format", "json"])).out).diagnostics).toEqual([]);
  });
});

describe("headerDeclaresBase", () => {
  it.each([
    ["a.py", "class A(Base):", true],
    ["a.py", "class A(object):", false],
    ["a.py", "class A():", false],
    ["a.py", "class A: pass", false],
    ["a.ts", "export class A extends B {", true],
    ["a.ts", "class A implements I<T> {", true],
    ["a.ts", "class A {", false],
    ["A.java", "public class A extends B implements C {", true],
    ["A.java", "public class A {", false],
    ["A.kt", "data class A(val x: Int)", false],
    ["A.kt", "class A(val x: Int) : Base()", true],
    ["A.cs", "public class A<T> : IThing<T>", true],
    ["a.cpp", "class A : public Base {", true],
    ["a.rb", "class A < Base", true],
    ["a.rb", "class A", false],
  ])("%s: %s -> %s", (path, line, expected) => {
    expect(headerDeclaresBase([line], 1, path)).toBe(expected);
  });
});

describe("overrideFamily", () => {
  it("reads only expand, so any client with expand will do", async () => {
    const family = await overrideFamily(client, asTarget(MID_M) as any, { lines: () => null });
    expect(family.rows.map((r) => r.relation)).toEqual(["overrides", "overridden_by", "sibling"]);
  });
});
