// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import chalk from "chalk";

import { registerImpactCommand, impactRowJson } from "../commands/impact.js";
import { BASELINE } from "./impact-json-locations.baseline.js";

/**
 * `ix impact --format json` says where each caller, callee, bucket member and
 * container dependent is, from the nodes the command already holds. Additive
 * only: the same JSON with the new keys taken out is what the command printed
 * before, and llm and text output do not change at all (`BASELINE` was
 * captured from the command before the location fields were added).
 */

const { expand, entity, state } = vi.hoisted(() => ({
  expand: vi.fn(),
  entity: vi.fn(),
  state: { set: undefined as unknown },
}));

vi.mock("../../client/factory.js", () => ({
  createClient: () => ({
    expand: (...args: unknown[]) => expand(...args),
    entity: (...args: unknown[]) => entity(...args),
  }),
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveTargetSetOrReport: async () => state.set,
  printResolved: () => {},
}));
vi.mock("../graph-health.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph-health.js")>(),
  checkGraphHealth: async () => ({ status: "healthy" }),
}));

// ── Graph ────────────────────────────────────────────────────────────────────

const LEAF = { id: "t-verify", kind: "function", name: "verify", resolutionMode: "exact", path: "src/auth.ts" };
const FILE = { id: "t-file", kind: "file", name: "auth.ts", resolutionMode: "exact", path: "src/auth.ts" };
const CLASS = { id: "t-class", kind: "class", name: "Session", resolutionMode: "exact", path: "src/session.ts" };

// Location shapes: provenance + span, attrs.path only, a file (path only), none.
const login = { id: "a", kind: "method", name: "login", provenance: { source_uri: "src/auth/login.ts" }, attrs: { line_start: 10, line_end: 42 } };
const handle = { id: "b", kind: "function", name: "handle", attrs: { path: "src/http/handle.ts" } };
const mainFile = { id: "c", kind: "file", name: "main.ts", attrs: { path: "src/main.ts", line_start: 1, line_end: 200 } };
const orphan = { id: "d", kind: "function", name: "orphan" };
// No kind: bucketByHierarchy reads the entity for it.
const lazy = { id: "e", name: "lazy" };
const lazyEntity = { id: "e", kind: "function", name: "lazy", attrs: { path: "src/lazy.ts", line_start: 5, line_end: 6 } };
const decode = { id: "f", kind: "function", name: "decode_jwt", provenance: { source_uri: "src/jwt.ts" }, attrs: { line_start: 3, line_end: 9 } };

const appFile = { id: "x", kind: "file", name: "app.ts", attrs: { path: "src/app.ts" } };
const boot = { id: "y", kind: "function", name: "boot", provenance: { source_uri: "src/boot.ts" }, attrs: { line_start: 3, line_end: 30 } };
const httpHandle = { id: "z", kind: "method", name: "handle", attrs: { path: "src/http.ts", line_start: 7, line_end: 7 } };
const nowhere = { id: "w", kind: "function", name: "nowhere" };
const memberVerify = { id: "m1", kind: "function", name: "verify", attrs: { path: "src/auth.ts", line_start: 1, line_end: 20 } };
const memberSession = { id: "m2", kind: "class", name: "Session", attrs: { path: "src/auth.ts", line_start: 22, line_end: 80 } };

const AUTH = { id: "r1", kind: "subsystem", name: "Auth Layer" };
const CORE = { id: "r2", kind: "module", name: "Core" };

const GRAPH: Record<string, unknown[]> = {
  // leaf
  "t-verify in CALLS,REFERENCES": [login, handle, mainFile, orphan, lazy],
  "t-verify out CALLS,REFERENCES": [decode],
  "t-verify in IN_REGION": [{ id: "sys", kind: "system", name: "App" }, AUTH],
  "t-verify in DECISION_AFFECTS": [{ id: "dec1", name: "Use JWT" }],
  // file container
  "t-file out CONTAINS": [memberVerify, memberSession],
  "t-file in IMPORTS": [appFile, boot],
  "t-file in CALLS,REFERENCES": [boot, httpHandle],
  "t-file in TASK_AFFECTS": [{ id: "task1", name: "Rotate keys", attrs: { status: "open" } }],
  "m1 in CALLS,REFERENCES": [boot, httpHandle],
  "m2 in CALLS,REFERENCES": [httpHandle],
  // class container
  "t-class out CONTAINS": [memberSession],
  "t-class in IMPORTS": [boot],
  "t-class in CALLS,REFERENCES": [boot, httpHandle, nowhere],
  // regions of the dependents
  "a in IN_REGION": [AUTH],
  "b in IN_REGION": [AUTH],
  "c in IN_REGION": [AUTH],
  "d in IN_REGION": [CORE],
  "e in IN_REGION": [AUTH],
  "x in IN_REGION": [AUTH],
  "y in IN_REGION": [AUTH],
  "z in IN_REGION": [CORE],
  "w in IN_REGION": [CORE],
};

function graphExpand(id: string, opts: { direction: string; predicates: string[] }) {
  return { nodes: GRAPH[`${id} ${opts.direction} ${opts.predicates.join(",")}`] ?? [], edges: [] };
}

type Scenario = "leaf" | "file" | "class" | "all";
const SETS: Record<Scenario, unknown> = {
  leaf: { entities: [LEAF] },
  file: { entities: [FILE] },
  class: { entities: [CLASS] },
  all: { entities: [{ ...LEAF, n: 1 }, { ...CLASS, n: 2 }], all: { total: 2 } },
};

async function run(scenario: Scenario, args: string[]): Promise<{ out: string; exitCode: number | null }> {
  state.set = SETS[scenario];
  const program = new Command().name("ix").exitOverride();
  registerImpactCommand(program);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { lines.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(["impact", "target", ...args], { from: "user" });
    return { out: lines.join("\n"), exitCode: (process.exitCode as number | undefined) ?? null };
  } finally {
    process.exitCode = before;
  }
}

async function json(scenario: Scenario, args: string[] = []): Promise<any> {
  return JSON.parse((await run(scenario, ["--format", "json", ...args])).out);
}

/** The JSON with every key this change added taken out again. */
function withoutNewKeys(value: any): any {
  const strip = (row: any) => {
    const { path: _p, lineStart: _s, lineEnd: _e, ...rest } = row;
    return rest;
  };
  const one = (o: any) => {
    const { dependentList: _d, ...rest } = o;
    if (rest.callerList) rest.callerList = rest.callerList.map(strip);
    if (rest.calleeList) rest.calleeList = rest.calleeList.map(strip);
    if (rest.propagationBuckets) {
      rest.propagationBuckets = rest.propagationBuckets.map((b: any) => ({ ...b, members: b.members.map(strip) }));
    }
    return rest;
  };
  return value.results ? { ...value, results: value.results.map(one) } : one(value);
}

beforeAll(() => { chalk.level = 0; });
beforeEach(() => {
  expand.mockReset();
  entity.mockReset();
  expand.mockImplementation(async (id: string, opts: { direction: string; predicates: string[] }) => graphExpand(id, opts));
  entity.mockImplementation(async (id: string) => ({ node: id === "e" ? lazyEntity : { id }, claims: [], edges: [] }));
});
afterEach(() => vi.restoreAllMocks());

// ── Leaf ─────────────────────────────────────────────────────────────────────

describe("impactRowJson", () => {
  it("keeps kind and name first and adds only the location the node has", () => {
    expect(Object.keys(impactRowJson(login))).toEqual(["kind", "name", "path", "lineStart", "lineEnd"]);
    expect(impactRowJson(login)).toEqual({ kind: "method", name: "login", path: "src/auth/login.ts", lineStart: 10, lineEnd: 42 });
    expect(impactRowJson(handle)).toEqual({ kind: "function", name: "handle", path: "src/http/handle.ts" });
    expect(impactRowJson(mainFile)).toEqual({ kind: "file", name: "main.ts", path: "src/main.ts" });
    expect(impactRowJson(orphan)).toEqual({ kind: "function", name: "orphan" });
    expect(Object.keys(impactRowJson(orphan))).toEqual(["kind", "name"]);
  });
});

describe("ix impact <leaf> --format json", () => {
  it("locates every caller and callee, never with a null", async () => {
    const out = await json("leaf");
    expect(out.callerList).toEqual([
      { kind: "method", name: "login", path: "src/auth/login.ts", lineStart: 10, lineEnd: 42 },
      { kind: "function", name: "handle", path: "src/http/handle.ts" },
      { kind: "file", name: "main.ts", path: "src/main.ts" },
      { kind: "function", name: "orphan" },
      { name: "lazy" },
    ]);
    expect(out.calleeList).toEqual([
      { kind: "function", name: "decode_jwt", path: "src/jwt.ts", lineStart: 3, lineEnd: 9 },
    ]);
    for (const row of [...out.callerList, ...out.calleeList]) {
      expect(Object.keys(row).slice(0, row.kind === undefined ? 1 : 2)).toEqual(row.kind === undefined ? ["name"] : ["kind", "name"]);
      expect(Object.values(row)).not.toContain(null);
    }
  });

  it("locates bucket members, name and kind first", async () => {
    const out = await json("leaf");
    expect(out.propagationBuckets).toEqual([
      { region: "Auth Layer", regionKind: "subsystem", count: 4, members: [
        { name: "login", kind: "method", path: "src/auth/login.ts", lineStart: 10, lineEnd: 42 },
        { name: "handle", kind: "function", path: "src/http/handle.ts" },
        { name: "main.ts", kind: "file", path: "src/main.ts" },
        // Read from the entity, the one request bucketing already made for it.
        { name: "lazy", kind: "function", path: "src/lazy.ts", lineStart: 5, lineEnd: 6 },
      ] },
      { region: "Core", regionKind: "module", count: 1, members: [{ name: "orphan", kind: "function" }] },
    ]);
    for (const m of out.propagationBuckets.flatMap((b: any) => b.members)) {
      expect(Object.keys(m).slice(0, 2)).toEqual(["name", "kind"]);
    }
  });

  it("makes no request it did not make before", async () => {
    await json("leaf");
    expect(expand.mock.calls.length).toBe(BASELINE.requests.leaf.expand);
    expect(entity.mock.calls.length).toBe(BASELINE.requests.leaf.entity);
    expect(entity.mock.calls.map((c) => c[0])).toEqual(["e"]);
  });

  it("has no dependentList", async () => {
    expect(await json("leaf")).not.toHaveProperty("dependentList");
  });
});

// ── Container ────────────────────────────────────────────────────────────────

describe("ix impact <container> --format json", () => {
  it("file target: dependentList is importers then dependents, deduped, the first expand winning `via`", async () => {
    const out = await json("file");
    expect(out.dependentList).toEqual([
      { kind: "file", name: "app.ts", path: "src/app.ts", via: "importer" },
      { kind: "function", name: "boot", path: "src/boot.ts", lineStart: 3, lineEnd: 30, via: "importer" },
      { kind: "method", name: "handle", path: "src/http.ts", lineStart: 7, lineEnd: 7, via: "dependent" },
    ]);
    // Placed after propagationBuckets, before the decisions/tasks/bugs tail.
    const keys = Object.keys(out);
    expect(keys.indexOf("dependentList")).toBe(keys.indexOf("propagationBuckets") + 1);
    expect(keys.indexOf("tasks")).toBe(keys.indexOf("dependentList") + 1);
  });

  it("class target: a node from both expands appears once, as an importer", async () => {
    const out = await json("class");
    expect(out.dependentList).toEqual([
      { kind: "function", name: "boot", path: "src/boot.ts", lineStart: 3, lineEnd: 30, via: "importer" },
      { kind: "method", name: "handle", path: "src/http.ts", lineStart: 7, lineEnd: 7, via: "dependent" },
      { kind: "function", name: "nowhere", via: "dependent" },
    ]);
    expect(out.summary).toEqual({ members: 1, directImporters: 1, directDependents: 3, memberLevelCallers: 1 });
  });

  it("--limit does not cut dependentList", async () => {
    const out = await json("class", ["--limit", "1"]);
    expect(out.dependentList).toHaveLength(3);
  });

  it("locates container bucket members", async () => {
    const out = await json("file");
    expect(out.propagationBuckets).toEqual([
      { region: "Auth Layer", regionKind: "subsystem", count: 2, members: [
        { name: "app.ts", kind: "file", path: "src/app.ts" },
        { name: "boot", kind: "function", path: "src/boot.ts", lineStart: 3, lineEnd: 30 },
      ] },
      { region: "Core", regionKind: "module", count: 1, members: [
        { name: "handle", kind: "method", path: "src/http.ts", lineStart: 7, lineEnd: 7 },
      ] },
    ]);
  });

  it("omits dependentList when nothing depends on the target", async () => {
    expand.mockImplementation(async (id: string, opts: { direction: string; predicates: string[] }) =>
      opts.predicates.includes("IMPORTS") || (id === "t-file" && opts.predicates.includes("CALLS"))
        ? { nodes: [], edges: [] }
        : graphExpand(id, opts));
    const out = await json("file");
    expect(out).not.toHaveProperty("dependentList");
    expect(out).not.toHaveProperty("propagationBuckets");
  });

  it("makes no request it did not make before", async () => {
    await json("file");
    expect(expand.mock.calls.length).toBe(BASELINE.requests.file.expand);
    expect(entity.mock.calls.length).toBe(BASELINE.requests.file.entity);
  });
});

// ── Additive only ────────────────────────────────────────────────────────────

describe("additive only", () => {
  for (const scenario of ["leaf", "file", "class", "all"] as const) {
    it(`${scenario}: json without the new keys is the old json, key order included`, async () => {
      const { out, exitCode } = await run(scenario, ["--format", "json"]);
      const now = withoutNewKeys(JSON.parse(out));
      expect(now).toEqual(BASELINE.json[scenario]);
      expect(JSON.stringify(now)).toBe(JSON.stringify(BASELINE.json[scenario]));
      expect(exitCode).toBe(BASELINE.exitCode[scenario].json);
    });

    for (const format of ["llm", "text"] as const) {
      it(`${scenario}: ${format} output is byte-identical`, async () => {
        const { out, exitCode } = await run(scenario, ["--format", format]);
        expect(out).toBe(BASELINE[format][scenario]);
        expect(exitCode).toBe(BASELINE.exitCode[scenario][format]);
      });
    }
  }

  it("--all: every candidate's analysis carries the new fields", async () => {
    const out = await json("all");
    expect(out.results[0].callerList[0]).toEqual({ kind: "method", name: "login", path: "src/auth/login.ts", lineStart: 10, lineEnd: 42 });
    expect(out.results[1].dependentList[0]).toEqual({ kind: "function", name: "boot", path: "src/boot.ts", lineStart: 3, lineEnd: 30, via: "importer" });
  });
});
