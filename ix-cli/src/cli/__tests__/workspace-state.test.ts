// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as statePaths from "../state-paths.js";
import {
  WORKSPACE_STATE_FILES,
  clearIngestMtimeCache,
  clearMapBaseline,
  ingestMtimeCachePath,
  ingestOrphanSweepPath,
  ingestRebuildPath,
  mapBaselinePath,
  mapRefreshOutcomePath,
  mapResultCachePath,
  mapStalePath,
  verifyRecordPath,
} from "../state-paths.js";
import { readState, writeFileAtomic, writeStateAtomic } from "../workspace-state.js";
import { loadIngestBaseline, loadOrphanSweepPending, loadRebuildProgress, saveIngestBaseline, saveOrphanSweepPending, saveRebuildProgress } from "../ingest-baseline.js";
import { loadMapBaseline, saveMapBaseline } from "../map-baseline.js";
import { markMapStale, readMapStale } from "../map-freshness.js";
import { loadIngestSymbols, saveIngestSymbols } from "../ingest-symbols.js";
import { loadVerifyRecord, saveVerifyRecord, type VerifyRecord } from "../verify.js";
import { ingestSymbolsPath } from "../config.js";

let home: string;
let root: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ix-wsstate-")));
  process.env.IX_HOME = path.join(home, ".ix");
  root = path.join(home, "repo");
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  delete process.env.IX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf-8"));
const raw = (file: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

describe("the workspace state registry", () => {
  it("registers every per-root path state-paths.ts builds, once", () => {
    const built = Object.entries(statePaths)
      .filter(([name, fn]) => typeof fn === "function" && /Path$/.test(name))
      .map(([, fn]) => (fn as (root: string) => string)(root))
      .sort();
    const registered = WORKSPACE_STATE_FILES.map((f) => f.path(root)).sort();
    expect(registered).toEqual(built);
    expect(new Set(WORKSPACE_STATE_FILES.map((f) => f.name)).size).toBe(WORKSPACE_STATE_FILES.length);
  });

  it("clearIngestMtimeCache removes every ingest and map file, and keeps only the kept group", () => {
    for (const f of WORKSPACE_STATE_FILES) raw(f.path(root), {});
    clearIngestMtimeCache(root);
    for (const f of WORKSPACE_STATE_FILES) {
      expect(fs.existsSync(f.path(root)), `${f.name} (${f.group})`).toBe(f.group === "kept");
    }
  });

  it("clearMapBaseline removes the map group and leaves the ingest group", () => {
    for (const f of WORKSPACE_STATE_FILES) raw(f.path(root), {});
    clearMapBaseline(root);
    for (const f of WORKSPACE_STATE_FILES) {
      expect(fs.existsSync(f.path(root)), `${f.name} (${f.group})`).toBe(f.group !== "map");
    }
  });
});

describe("readState / writeStateAtomic", () => {
  const file = () => path.join(home, "state", "s.json");
  const opts = { version: 2, validate: (d: Record<string, unknown>, v: number) => ({ ...d, v }) };

  it("writes formatVersion and reads it back", () => {
    writeStateAtomic(file(), 2, { a: 1 });
    expect(read(file())).toEqual({ formatVersion: 2, a: 1 });
    expect(readState(file(), opts)).toEqual({ formatVersion: 2, a: 1, v: 2 });
    expect(fs.readdirSync(path.dirname(file()))).toEqual(["s.json"]);
  });

  it("reads a file with no formatVersion as version 0", () => {
    raw(file(), { a: 1 });
    expect(readState(file(), opts)).toEqual({ a: 1, v: 0 });
  });

  it("reads an unknown version, a malformed file or a non-object as absent", () => {
    raw(file(), { formatVersion: 3, a: 1 });
    expect(readState(file(), opts)).toBeNull();
    raw(file(), { formatVersion: "2", a: 1 });
    expect(readState(file(), opts)).toBeNull();
    raw(file(), [1]);
    expect(readState(file(), opts)).toBeNull();
    fs.writeFileSync(file(), "{\"formatVersion\":2,\"a\"");
    expect(readState(file(), opts)).toBeNull();
    expect(readState(path.join(home, "missing.json"), opts)).toBeNull();
  });

  it("leaves no temp file and keeps the old contents when the rename fails", () => {
    writeFileAtomic(file(), "old");
    // A directory at the target makes the rename fail.
    const dir = path.join(home, "state", "d.json");
    fs.mkdirSync(path.join(dir, "x"), { recursive: true });
    expect(() => writeFileAtomic(dir, "new")).toThrow();
    expect(fs.readdirSync(path.dirname(file())).sort()).toEqual(["d.json", "s.json"]);
  });
});

describe("every per-root state file carries a format version", () => {
  it("ingest baseline, rebuild progress, orphan sweeps", () => {
    saveIngestBaseline(root, new Map([["a.ts", 1]]), 4, new Date(), new Map(), "ext");
    saveRebuildProgress(root, "ext", new Map([["a.ts", 1]]));
    saveOrphanSweepPending(root, new Map([["ext", null]]));
    for (const p of [ingestMtimeCachePath(root), ingestRebuildPath(root), ingestOrphanSweepPath(root)]) {
      expect(read(p).formatVersion, p).toBe(1);
    }
    expect(loadIngestBaseline(root)?.currentRev).toBe(4);
    expect(loadRebuildProgress(root, "ext")?.get("a.ts")).toBe(1);
    expect(loadOrphanSweepPending(root).get("ext")).toBeNull();
  });

  it("map baseline, stale marker, verify record, symbol table", () => {
    expect(saveMapBaseline(root, 7)).toBe(true);
    markMapStale(root, { since: 1, ingestRev: 2 });
    const record: VerifyRecord = {
      root, at: "2026-01-01T00:00:00.000Z", lastIngestAt: null, graph: "clean",
      files: 1, stale: 0, diverged: 0, unverified: 0, divergedFiles: [], fix: null,
    };
    expect(saveVerifyRecord(record)).toBe(true);
    const table = new Map([["a.ts", { hash: "h", summary: { filePath: "a.ts" } }]]);
    saveIngestSymbols(root, "ext", table);
    for (const p of [mapBaselinePath(root), mapStalePath(root), verifyRecordPath(root)]) {
      expect(read(p).formatVersion, p).toBe(1);
    }
    expect(read(ingestSymbolsPath(root)).formatVersion).toBe(3);
    expect(loadMapBaseline(root)).toEqual({ sourceRev: 7 });
    expect(readMapStale(root)).toEqual({ since: 1, ingestRev: 2 });
    expect(loadVerifyRecord(root)).toEqual(record);
    expect(loadIngestSymbols(root, "ext").get("a.ts")?.hash).toBe("h");
  });

  it("files written before formatVersion still load", () => {
    raw(ingestMtimeCachePath(root), { root, files: { "a.ts": 1 }, currentRev: 3, lastIngestAt: "2026-01-01T00:00:00.000Z" });
    raw(mapBaselinePath(root), { root, sourceRev: 3 });
    raw(mapStalePath(root), { since: 5, ingestRev: null });
    raw(ingestRebuildPath(root), { root, extractor: "ext", files: { "a.ts": 1 } });
    raw(ingestOrphanSweepPath(root), { root, pending: { ext: ["a.ts"] } });
    raw(mapRefreshOutcomePath(root), { startedAt: 1, pid: 2 });
    raw(ingestSymbolsPath(root), { version: 3, root, extractor: "ext", gen: "ab", files: { "a.ts": { hash: "h", summary: { filePath: "a.ts" } } } });
    const baseline = loadIngestBaseline(root);
    expect(baseline?.currentRev).toBe(3);
    // Presence rules are unchanged for a legacy file.
    expect(baseline?.tracksMapBaseline).toBe(false);
    expect(baseline?.extractor).toBeNull();
    expect(loadMapBaseline(root)).toEqual({ sourceRev: 3 });
    expect(readMapStale(root)).toEqual({ since: 5, ingestRev: null });
    expect(loadRebuildProgress(root, "ext")?.get("a.ts")).toBe(1);
    expect([...(loadOrphanSweepPending(root).get("ext") ?? [])]).toEqual(["a.ts"]);
    expect(loadIngestSymbols(root, "ext").get("a.ts")?.hash).toBe("h");
    // A legacy table of an older shape is still ignored.
    raw(ingestSymbolsPath(root), { version: 2, root, extractor: "ext", gen: "ab", files: { "a.ts": { hash: "h", summary: { filePath: "a.ts" } } } });
    expect(loadIngestSymbols(root, "ext").size).toBe(0);
  });

  it("a file from a newer format reads as absent", () => {
    raw(ingestMtimeCachePath(root), { formatVersion: 99, root, files: { "a.ts": 1 }, currentRev: 3 });
    raw(mapBaselinePath(root), { formatVersion: 99, root, sourceRev: 3 });
    raw(mapStalePath(root), { formatVersion: 99, since: 5, ingestRev: null });
    raw(mapResultCachePath(root), { formatVersion: 99, root });
    raw(verifyRecordPath(root), { formatVersion: 99, root, at: "x", graph: "clean" });
    raw(ingestSymbolsPath(root), { formatVersion: 99, root, extractor: "ext", gen: "ab", files: { "a.ts": { hash: "h", summary: { filePath: "a.ts" } } } });
    expect(loadIngestBaseline(root)).toBeNull();
    expect(loadMapBaseline(root)).toBeNull();
    expect(readMapStale(root)).toBeNull();
    expect(loadVerifyRecord(root)).toBeNull();
    expect(loadIngestSymbols(root, "ext").size).toBe(0);
  });
});
