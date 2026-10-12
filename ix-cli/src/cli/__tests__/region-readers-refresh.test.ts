// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

/**
 * CL-13: `ix map` may defer the map after an edit, so every command that reads
 * regions refreshes it first with `ensureFreshMap`. These run each reader
 * against a stub client and check three things: the refresh is asked for
 * exactly once, before the first region read, and a refresh that fails
 * changes neither the output nor the exit code.
 */

// The suite runs from a checkout no workspace covers; it is about ordering,
// not scoping, so the directory counts as mapped.
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => ({ systemId: null }),
  writeStitchScope: vi.fn(),
}));

const { events, refreshImpl } = vi.hoisted(() => ({
  events: [] as string[],
  refreshImpl: { current: async (): Promise<unknown> => undefined },
}));

vi.mock("../map-freshness.js", async (orig) => ({
  ...(await orig<typeof import("../map-freshness.js")>()),
  ensureFreshMap: vi.fn(async () => {
    events.push("refresh");
    await refreshImpl.current();
  }),
}));

vi.mock("../hierarchy.js", async (orig) => {
  const actual = await orig<typeof import("../hierarchy.js")>();
  return {
    ...actual,
    getSystemPath: async () => { events.push("region-read"); return []; },
    getEffectiveSystemPath: async () => { events.push("region-read"); return []; },
    bucketByHierarchy: async () => { events.push("region-read"); return []; },
  };
});

const NODE = {
  id: "node-1", kind: "function", name: "Target",
  provenance: { sourceUri: "src/a.ts" }, attrs: { line_start: 1, line_end: 3 },
};

/** A client that answers anything; region-shaped reads are logged. */
vi.mock("../../client/api.js", () => {
  const regionReads = new Set(["getSubsystemMap", "listSubsystems", "subsystemScores", "subsystems"]);
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
            if (regionReads.has(prop)) events.push("region-read");
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
  ["explain", ["explain", "Target"], async () => (await import("../commands/explain.js")).registerExplainCommand],
];

async function run(register: Register, args: string[]): Promise<string> {
  const program = new Command().name("ix").exitOverride();
  register(program);
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await program.parseAsync([...args, "--format", "json"], { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return out.join("\n");
}

describe.each(READERS)("ix %s refreshes a deferred map first", (_name, args, load) => {
  let home = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    events.length = 0;
    refreshImpl.current = async () => undefined;
    process.exitCode = undefined;
    home = mkdtempSync(join(tmpdir(), "ix-readers-refresh-"));
    for (const k of ["IX_HOME", "IX_GRAPH_HEALTH"]) saved[k] = process.env[k];
    process.env.IX_HOME = home;
    process.env.IX_GRAPH_HEALTH = "0";
  });

  afterEach(() => {
    process.exitCode = undefined;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("asks once, before the first region read", async () => {
    await run(await load(), args);
    expect(events.filter(e => e === "refresh")).toHaveLength(1);
    expect(events.indexOf("refresh")).toBe(0);
    expect(events, "the command did read regions").toContain("region-read");
  });

  it("answers the same, with the same exit code, when the refresh fails inside", async () => {
    const register = await load();
    const fine = await run(register, args);
    const fineExit = process.exitCode;
    expect(fine.length, "the reader printed its answer").toBeGreaterThan(0);

    // The real thing, made to fail at its first step after the marker check:
    // whatever goes wrong inside, the reader must not see it.
    const real = await vi.importActual<typeof import("../map-freshness.js")>("../map-freshness.js");
    real.markMapStale(join(home, "repo"), { ingestRev: 1 });
    let mapAsked = 0;
    refreshImpl.current = () => real.ensureFreshMap({
      root: join(home, "repo"),
      client: {
        endpoint: "http://127.0.0.1:1",
        workspaceSystem: async () => ({ systemId: null }),
        currentRevision: async () => 1,
        health: async () => ({ status: "ok" }),
        map: async () => { mapAsked++; throw new Error("500: map failed"); },
      } as any,
    });
    const failed = await run(register, args);
    expect(mapAsked, "the refresh got as far as the map").toBe(1);
    expect(failed).toBe(fine);
    expect(process.exitCode).toBe(fineExit);
  });
});
