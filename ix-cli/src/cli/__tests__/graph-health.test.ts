// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assessGraphStats,
  assessTargetStructure,
  checkGraphHealth,
  clearGraphHealthCache,
  GRAPH_REBUILD_FIX,
  resetGraphHealthMemo,
  worseHealth,
} from "../graph-health.js";

// `/v1/stats` bodies measured on the local backend: the ix-bench graph for
// checkout 37f98b16 (healthy) and for 5e611d17 (hollowed by another checkout's
// ingest, Ix-memory#211). Same repository, a few commits apart.
const HEALTHY = {
  nodes: {
    total: 9064,
    byKind: [
      { kind: "chunk", count: 4050 }, { kind: "function", count: 1284 }, { kind: "module", count: 1186 },
      { kind: "config_entry", count: 859 }, { kind: "constant", count: 532 }, { kind: "file", count: 317 },
      { kind: "heading", count: 275 }, { kind: "section", count: 275 }, { kind: "interface", count: 155 },
      { kind: "method", count: 105 }, { kind: "class", count: 22 }, { kind: "frontmatter", count: 4 },
    ],
  },
  edges: {
    total: 23263,
    byPredicate: [
      { predicate: "CALLS", count: 9238 }, { predicate: "CONTAINS_CHUNK", count: 3770 },
      { predicate: "DEFINES", count: 3726 }, { predicate: "CONTAINS", count: 2942 },
      { predicate: "NEXT", count: 1821 }, { predicate: "IMPORTS", count: 1189 },
      { predicate: "REFERENCES", count: 565 }, { predicate: "EXTENDS", count: 12 },
    ],
  },
};

const HOLLOW = {
  nodes: {
    total: 9243,
    byKind: [
      { kind: "chunk", count: 4109 }, { kind: "function", count: 1315 }, { kind: "module", count: 1241 },
      { kind: "config_entry", count: 860 }, { kind: "constant", count: 538 }, { kind: "file", count: 333 },
      { kind: "heading", count: 275 }, { kind: "section", count: 275 }, { kind: "interface", count: 156 },
      { kind: "method", count: 115 }, { kind: "class", count: 22 }, { kind: "frontmatter", count: 4 },
    ],
  },
  edges: {
    total: 387,
    byPredicate: [
      { predicate: "CALLS", count: 222 }, { predicate: "CONTAINS_CHUNK", count: 39 },
      { predicate: "CONTAINS", count: 38 }, { predicate: "DEFINES", count: 38 },
      { predicate: "IMPORTS", count: 35 }, { predicate: "NEXT", count: 14 }, { predicate: "REFERENCES", count: 1 },
    ],
  },
};

describe("assessGraphStats", () => {
  it("passes a healthy graph", () => {
    const health = assessGraphStats(HEALTHY);
    expect(health.status).toBe("ok");
    expect(health.structuralEdges).toBe(3770 + 3726 + 2942);
    expect(health.symbols).toBe(9064 - 317);
  });

  it("calls a graph that kept its nodes and lost its edges degraded, with the repair", () => {
    const health = assessGraphStats(HOLLOW);
    expect(health.status).toBe("degraded");
    expect(health.reason).toBe("hollow");
    expect(health.fix).toBe(GRAPH_REBUILD_FIX);
    expect(health.message).toContain("9243 nodes but 387 edges");
    expect(health.message).toContain("1% of symbols");
  });

  it("calls a small graph with symbols and no edge at all degraded", () => {
    // What a hollowed three-file workspace looks like: 13 nodes, 0 edges.
    const health = assessGraphStats({
      nodes: { total: 13, byKind: [{ kind: "function", count: 6 }, { kind: "file", count: 3 }, { kind: "module", count: 2 }, { kind: "class", count: 1 }, { kind: "method", count: 1 }] },
      edges: { total: 0, byPredicate: [] },
    });
    expect(health.status).toBe("degraded");
  });

  it("does not judge a graph too small to judge", () => {
    const health = assessGraphStats({
      nodes: { total: 3, byKind: [{ kind: "file", count: 2 }, { kind: "function", count: 1 }] },
      edges: { total: 0, byPredicate: [] },
    });
    expect(health.status).toBe("ok");
  });

  it("reports a registered workspace with no nodes as empty, fixed by a map", () => {
    const health = assessGraphStats({ nodes: { total: 0, byKind: [] }, edges: { total: 0, byPredicate: [] } });
    expect(health).toMatchObject({ status: "empty", reason: "no_nodes", fix: "ix map" });
  });

  it("says nothing when the body carries no breakdown to judge by", () => {
    // An older backend or a stub: a missing breakdown must not read as zero edges.
    expect(assessGraphStats({ nodes: { total: 7717 }, edges: { total: 16983 } }).status).toBe("unknown");
    expect(assessGraphStats(undefined).status).toBe("unknown");
    expect(assessGraphStats({ error: "nope" }).status).toBe("unknown");
  });
});

describe("assessTargetStructure", () => {
  it("flags a definition no file contains", () => {
    const health = assessTargetStructure({ name: "parseBudgetOption", kind: "function", path: "ix-cli/src/cli/options.ts" });
    expect(health).toMatchObject({ status: "degraded", reason: "orphaned_target", fix: GRAPH_REBUILD_FIX });
    expect(health?.message).toContain("parseBudgetOption (function) in ix-cli/src/cli/options.ts");
  });

  it("says nothing about a contained definition, or a kind that is not always contained", () => {
    expect(assessTargetStructure({ name: "f", kind: "function", container: { id: "file-1" } })).toBeUndefined();
    expect(assessTargetStructure({ name: "options.ts", kind: "file" })).toBeUndefined();
    expect(assessTargetStructure({ name: "Intro", kind: "heading" })).toBeUndefined();
  });
});

describe("worseHealth", () => {
  it("keeps the worse verdict", () => {
    const ok = { status: "ok" as const };
    const bad = assessTargetStructure({ name: "f", kind: "function" });
    expect(worseHealth(ok, bad)).toBe(bad);
    expect(worseHealth({ status: "unknown" }, bad)).toBe(bad);
    expect(worseHealth(ok, undefined)).toBe(ok);
    expect(worseHealth(bad!, ok)).toBe(bad);
  });
});

describe("checkGraphHealth", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ix-graph-health-"));
    process.env.IX_HOME = home;
    resetGraphHealthMemo();
  });

  afterEach(() => {
    delete process.env.IX_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function client(revisions: unknown[], statsBody: unknown = HOLLOW) {
    let call = 0;
    return {
      endpoint: "http://backend.test",
      currentRevision: vi.fn(async () => revisions[Math.min(call++, revisions.length - 1)]),
      // Any body at all: `checkGraphHealth` must cope with whatever comes back.
      stats: vi.fn(async () => statsBody as never),
    };
  }

  it("asks for stats once per backend revision, bounded by its timeout", async () => {
    const c = client([3217, 3217]);
    const first = await checkGraphHealth(c, { workspaceId: "e4e3a3d1" }, {});
    const second = await checkGraphHealth(c, { workspaceId: "e4e3a3d1" }, {});
    expect(first.status).toBe("degraded");
    expect(second).toEqual(first);
    expect(c.stats).toHaveBeenCalledTimes(1);
    expect(c.stats).toHaveBeenCalledWith({ workspaceId: "e4e3a3d1", timeoutMs: 2000 });
  });

  it("asks again once the head moves -- an ingest elsewhere is what hollows a graph", async () => {
    const c = client([3217, 3218]);
    await checkGraphHealth(c, { workspaceId: "e4e3a3d1" }, {});
    await checkGraphHealth(c, { workspaceId: "e4e3a3d1" }, {});
    expect(c.stats).toHaveBeenCalledTimes(2);
  });

  it("answers a fresh process from the disk cache at the same revision", async () => {
    await checkGraphHealth(client([3217]), { workspaceId: "e4e3a3d1" }, {});
    resetGraphHealthMemo(); // a new CLI process
    const next = client([3217]);
    const health = await checkGraphHealth(next, { workspaceId: "e4e3a3d1" }, {});
    expect(health.status).toBe("degraded");
    expect(next.stats).not.toHaveBeenCalled();
    expect(fs.readdirSync(home).some((f) => f.startsWith("graph_health_"))).toBe(true);
  });

  it("is forgotten by a reset, which does not move the head revision", async () => {
    // Measured on backend 1.0.30: /v1/reset/workspace deletes the data and
    // leaves /v1/revisions/current where it was.
    await checkGraphHealth(client([3217], HEALTHY), { workspaceId: "w" }, {});
    clearGraphHealthCache();
    const after = client([3217], { nodes: { total: 0, byKind: [] }, edges: { total: 0, byPredicate: [] } });
    expect((await checkGraphHealth(after, { workspaceId: "w" }, {})).status).toBe("empty");
    expect(fs.readdirSync(home).filter((f) => f.startsWith("graph_health_"))).toHaveLength(1);
  });

  it("keeps workspaces apart", async () => {
    const c = client([3217]);
    await checkGraphHealth(c, { workspaceId: "e4e3a3d1" }, {});
    await checkGraphHealth(c, { workspaceId: "a2ebc094" }, {});
    expect(c.stats).toHaveBeenCalledTimes(2);
  });

  it("never throws: a failing backend is `unknown`, and nothing is cached", async () => {
    const c = { endpoint: "x", currentRevision: vi.fn(async () => 1), stats: vi.fn(async () => { throw new Error("aborted"); }) };
    expect((await checkGraphHealth(c, { workspaceId: "w" }, {})).status).toBe("unknown");
    expect((await checkGraphHealth(c, { workspaceId: "w" }, {})).status).toBe("unknown");
    expect(c.stats).toHaveBeenCalledTimes(2);
    // A stub without the methods (every mocked client in this suite) is the same.
    expect((await checkGraphHealth({} as never, { workspaceId: "w" }, {})).status).toBe("unknown");
  });

  it("does nothing without a scope, or when turned off", async () => {
    const c = client([1]);
    expect((await checkGraphHealth(c, {}, {})).status).toBe("unknown");
    expect((await checkGraphHealth(c, { workspaceId: "w" }, { IX_GRAPH_HEALTH: "0" })).status).toBe("unknown");
    expect(c.currentRevision).not.toHaveBeenCalled();
  });

  it("honours IX_GRAPH_HEALTH_TIMEOUT_MS", async () => {
    const c = client([1]);
    await checkGraphHealth(c, { systemId: "sys-1" }, { IX_GRAPH_HEALTH_TIMEOUT_MS: "250" });
    expect(c.stats).toHaveBeenCalledWith({ systemId: "sys-1", timeoutMs: 250 });
  });
});
