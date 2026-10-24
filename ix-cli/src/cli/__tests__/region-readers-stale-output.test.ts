// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

/**
 * CL-13: a region reader that finds the map deferred answers from the last
 * map. Its stderr says so; these check that its machine output does too --
 * `map_stale` (and `regions_as_of` when the marker knows it) at the top of
 * the json payload, one `diagnostic code=map_stale` record in llm, worded as
 * `ix map` words it -- and that a fresh map, the text output and the exit
 * code are left as they were.
 */

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => ({ systemId: null }),
  writeStitchScope: vi.fn(),
}));

vi.mock("../hierarchy.js", async (orig) => ({
  ...(await orig<typeof import("../hierarchy.js")>()),
  getSystemPath: async () => [],
  getEffectiveSystemPath: async () => [],
  bucketByHierarchy: async () => [],
}));

const { failing } = vi.hoisted(() => ({ failing: new Set<string>() }));

const NODE = {
  id: "node-1", kind: "function", name: "Target",
  provenance: { sourceUri: "src/a.ts" }, attrs: { line_start: 1, line_end: 3 },
};

vi.mock("../../client/api.js", () => {
  const answers: Record<string, (...a: unknown[]) => unknown> = {
    search: () => [NODE],
    entity: () => ({ node: NODE, edges: [], claims: [], decisions: [] }),
    workspaceSystem: () => ({ systemId: null }),
    stats: () => ({ nodes: { total: 10, byKind: [] }, edges: { total: 10, byPredicate: [] } }),
    currentRevision: () => 1,
    health: () => ({ status: "ok" }),
    getSubsystemMap: () => ({ file_count: 0, region_count: 0, levels: 0, map_rev: 1, regions: [], hierarchy: [] }),
  };
  class IxClient {
    endpoint = "http://127.0.0.1:1";
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop in target) return (target as any)[prop];
          if (typeof prop !== "string" || prop === "then") return undefined;
          return async (...args: unknown[]) => {
            if (failing.has(prop)) throw new Error("backend went away");
            const answer = answers[prop];
            return answer ? answer(...args) : { nodes: [], edges: [], results: [] };
          };
        },
      });
    }
  }
  return { IxClient, LocalTokenRequiredError: class extends Error {} };
});

type Register = (program: Command) => void;

const READERS: ReadonlyArray<readonly [string, string[], () => Promise<Register>]> = [
  ["overview", ["overview", "Target"], async () => (await import("../commands/overview.js")).registerOverviewCommand],
  ["impact", ["impact", "Target"], async () => (await import("../commands/impact.js")).registerImpactCommand],
  ["locate", ["locate", "Target"], async () => (await import("../commands/locate.js")).registerLocateCommand],
  ["subsystems", ["subsystems"], async () => (await import("../commands/subsystems.js")).registerSubsystemsCommand],
  ["subsystems --list", ["subsystems", "--list"], async () => (await import("../commands/subsystems.js")).registerSubsystemsCommand],
  ["explain", ["explain", "Target"], async () => (await import("../commands/explain.js")).registerExplainCommand],
];

async function run(register: Register, args: string[], format: string): Promise<{ out: string; exitCode: unknown }> {
  const program = new Command().name("ix").exitOverride();
  register(program);
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.exitCode = undefined;
  try {
    await program.parseAsync([...args, "--format", format], { from: "user" });
  } catch {
    // A backend failure the CLI's top-level handler would report.
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join("\n"), exitCode };
}

const AS_OF = { map_rev: 7, file_count: 42 };

let home = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  failing.clear();
  home = mkdtempSync(join(tmpdir(), "ix-readers-stale-"));
  for (const k of ["IX_HOME", "IX_GRAPH_HEALTH", "IX_MAP_BACKGROUND_REFRESH", "IX_LOCK_DIR"]) saved[k] = process.env[k];
  process.env.IX_LOCK_DIR = join(home, "locks");
  process.env.IX_HOME = home;
  process.env.IX_GRAPH_HEALTH = "0";
  // Stale, and nothing started in the background: the reader answers from
  // the last map and says why.
  process.env.IX_MAP_BACKGROUND_REFRESH = "0";
});

afterEach(() => {
  process.exitCode = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

/** The root a reader with no `root` option checks, so the marker is the one it reads. */
async function readerRoot(): Promise<string> {
  const { canonicalMapRoot } = await import("../map-root.js");
  const { resolveWorkspaceRoot } = await import("../config.js");
  return canonicalMapRoot(resolveWorkspaceRoot());
}

async function markStale(regionsAsOf?: { map_rev: number; file_count: number }): Promise<void> {
  const { markMapStale } = await import("../map-freshness.js");
  markMapStale(await readerRoot(), { ingestRev: 3, ...(regionsAsOf ? { regionsAsOf } : {}) });
}

async function expectedDiagnostic(regionsAsOf?: { map_rev: number; file_count: number }): Promise<string> {
  const { llmLine } = await import("../llm.js");
  const { mapStaleNotice } = await import("../commands/map.js");
  return llmLine("diagnostic", [["code", "map_stale"], ["message", mapStaleNotice({ mapStale: true, regionsAsOf })]]);
}

const staleDiagnostics = (out: string): string[] => out.split("\n").filter((l) => /^diagnostic code=map_stale\b/.test(l));

describe.each(READERS)("ix %s says in its machine output when the map is stale", (_name, args, load) => {
  it("json: no map_stale or regions_as_of while the map is fresh", async () => {
    const { out } = await run(await load(), args, "json");
    const payload = JSON.parse(out);
    expect(payload).not.toHaveProperty("map_stale");
    expect(payload).not.toHaveProperty("regions_as_of");
  });

  it("json: map_stale and regions_as_of at the top level while it is stale", async () => {
    const register = await load();
    const fresh = JSON.parse((await run(register, args, "json")).out);
    await markStale(AS_OF);
    const stale = JSON.parse((await run(register, args, "json")).out);
    expect(stale.map_stale).toBe(true);
    expect(stale.regions_as_of).toEqual(AS_OF);
    // Only added: everything else reads as before.
    const { map_stale: _s, regions_as_of: _r, ...rest } = stale;
    expect(rest).toEqual(fresh);
  });

  it("json: map_stale without regions_as_of when the marker does not name the map", async () => {
    await markStale();
    const stale = JSON.parse((await run(await load(), args, "json")).out);
    expect(stale.map_stale).toBe(true);
    expect(stale).not.toHaveProperty("regions_as_of");
  });

  it("llm: one diagnostic code=map_stale record worded as ix map words it; none when fresh", async () => {
    const register = await load();
    const fresh = await run(register, args, "llm");
    expect(staleDiagnostics(fresh.out)).toEqual([]);
    await markStale(AS_OF);
    const stale = await run(register, args, "llm");
    expect(staleDiagnostics(stale.out)).toEqual([await expectedDiagnostic(AS_OF)]);
    // The rest of the records are the fresh run's.
    expect(stale.out.split("\n").filter((l) => !/^diagnostic code=map_stale\b/.test(l))).toEqual(fresh.out.split("\n"));
    expect(stale.exitCode).toBe(fresh.exitCode);
  });

  it("llm: no map_stale record ahead of a failure, so a leading error record stays leading", async () => {
    await markStale(AS_OF);
    for (const m of ["entity", "expand", "listSubsystems", "getSubsystemMap"]) failing.add(m);
    const { out } = await run(await load(), args, "llm");
    expect(staleDiagnostics(out)).toEqual([]);
    if (out !== "") expect(out).toMatch(/^error code=/);
  });

  it("text: stdout and the exit code are unchanged", async () => {
    const register = await load();
    const fresh = await run(register, args, "text");
    await markStale(AS_OF);
    const stale = await run(register, args, "text");
    expect(stale.out).toBe(fresh.out);
    expect(stale.exitCode).toBe(fresh.exitCode);
  });
});

describe("ix locate with several targets", () => {
  const load = async () => (await import("../commands/locate.js")).registerLocateCommand;

  it("llm: one diagnostic for the whole call", async () => {
    await markStale(AS_OF);
    const { out } = await run(await load(), ["locate", "Target", "Target"], "llm");
    expect(staleDiagnostics(out)).toEqual([await expectedDiagnostic(AS_OF)]);
  });

  it("json: each answered target carries the flag", async () => {
    await markStale(AS_OF);
    const payload = JSON.parse((await run(await load(), ["locate", "Target", "Target"], "json")).out);
    expect(payload.targets).toHaveLength(2);
    for (const t of payload.targets) {
      expect(t.map_stale).toBe(true);
      expect(t.regions_as_of).toEqual(AS_OF);
    }
  });
});
