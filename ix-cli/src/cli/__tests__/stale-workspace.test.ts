import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ingestMtimeCachePath, saveConfig } from "../config.js";
import { loadIngestBaseline } from "../ingest-baseline.js";
import { persistIngestBaselineIfClean } from "../commands/ingest.js";
import { detectStaleFiles, isFileStale } from "../stale.js";

let home: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

function writeSource(root: string, name: string, source: string): string {
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, source);
  return filePath;
}

function moveMtimeForward(filePath: string): number {
  const next = fs.statSync(filePath).mtimeMs + 2_000;
  fs.utimesSync(filePath, next / 1_000, next / 1_000);
  return fs.statSync(filePath).mtimeMs;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ix-stale-workspace-"));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("workspace-scoped staleness", () => {
  it("keeps workspace A stale after workspace B records a newer ingest", async () => {
    const rootA = path.join(home, "a");
    const rootB = path.join(home, "b");
    const fileA = writeSource(rootA, "a.js", "export const value = 'a';\n");
    const fileB = writeSource(rootB, "b.js", "export const value = 'b';\n");
    const ingestedA = new Date("2026-08-09T18:00:00.000Z");

    expect(
      persistIngestBaselineIfClean(
        rootA,
        new Map([[fileA, fs.statSync(fileA).mtimeMs]]),
        11,
        0,
        0,
        ingestedA,
      ),
    ).toBe(true);

    moveMtimeForward(fileA);
    const beforeB = detectStaleFiles(rootA);
    expect(beforeB).toEqual({
      mapCompleted: true,
      lastIngestAt: ingestedA.toISOString(),
      currentRev: 11,
      staleFiles: 1,
      sampleChangedFiles: ["a.js"],
    });

    expect(
      persistIngestBaselineIfClean(
        rootB,
        new Map([[fileB, fs.statSync(fileB).mtimeMs]]),
        12,
        0,
        0,
        new Date("2026-08-09T18:01:00.000Z"),
      ),
    ).toBe(true);

    expect(detectStaleFiles(rootA)).toEqual(beforeB);
  });

  it("loads the legacy mtime-only cache and uses its own file timestamp", async () => {
    const root = path.join(home, "legacy");
    const filePath = writeSource(root, "legacy.js", "export const value = 1;\n");
    const originalMtime = fs.statSync(filePath).mtimeMs;
    const cachePath = ingestMtimeCachePath(root);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        root,
        files: { [filePath]: originalMtime },
      }),
    );
    const legacyTimestamp = new Date("2026-08-09T17:00:00.000Z");
    fs.utimesSync(cachePath, legacyTimestamp, legacyTimestamp);
    moveMtimeForward(filePath);

    const result = detectStaleFiles(root);
    expect(result.currentRev).toBe(0);
    expect(result.lastIngestAt).toBe(fs.statSync(cachePath).mtime.toISOString());
    expect(result.staleFiles).toBe(1);
    expect(result.sampleChangedFiles).toEqual(["legacy.js"]);
  });

  it("returns the unmapped state when the workspace has no baseline", async () => {
    const root = path.join(home, "unmapped");
    writeSource(root, "new.js", "export const value = 1;\n");

    expect(detectStaleFiles(root)).toEqual({
      mapCompleted: false,
      lastIngestAt: null,
      currentRev: 0,
      staleFiles: 0,
      sampleChangedFiles: [],
    });
  });

  it("reports a mapped file that was deleted after ingest", async () => {
    const root = path.join(home, "deleted-file");
    const filePath = writeSource(root, "deleted.js", "export const value = 1;\n");
    const ingestedAt = new Date("2026-08-09T18:00:00.000Z");
    persistIngestBaselineIfClean(
      root,
      new Map([[filePath, fs.statSync(filePath).mtimeMs]]),
      14,
      0,
      0,
      ingestedAt,
    );
    saveConfig({
      endpoint: "http://localhost:8090",
      format: "text",
      workspaces: [
        {
          workspace_id: "dead0001",
          workspace_name: "deleted-file",
          root_path: root,
          default: true,
        },
      ],
    });

    fs.unlinkSync(filePath);

    expect(detectStaleFiles(root)).toEqual({
      mapCompleted: true,
      lastIngestAt: ingestedAt.toISOString(),
      currentRev: 14,
      staleFiles: 1,
      sampleChangedFiles: ["deleted.js"],
    });
    expect(isFileStale(filePath)).toBe(true);
    expect(isFileStale(path.join(root, "never-mapped.js"))).toBe(false);
  });

  it("persists an empty baseline after the last mapped file is deleted", () => {
    const root = path.join(home, "empty-after-delete");
    const filePath = writeSource(root, "deleted.js", "export const value = 1;\n");
    persistIngestBaselineIfClean(
      root,
      new Map([[filePath, fs.statSync(filePath).mtimeMs]]),
      14,
      0,
      0,
      new Date("2026-08-09T18:00:00.000Z"),
    );

    const completedAt = new Date("2026-08-09T18:01:00.000Z");
    const deletedFiles = new Map([[filePath, ["caller.js"]]]);
    expect(
      persistIngestBaselineIfClean(root, new Map(), 15, 0, 0, completedAt, deletedFiles),
    ).toBe(true);

    expect(loadIngestBaseline(root)).toEqual({
      files: new Map(),
      deletedFiles,
      currentRev: 15,
      lastIngestAt: completedAt.toISOString(),
    });
  });

  it("refuses an empty baseline when nothing was deleted", () => {
    // An empty mtime map with no deletions is a discovery failure — an
    // over-broad ignore rule, the wrong cwd — and persisting it silently
    // discards the baseline, forcing a full re-ingest next run.
    const root = path.join(home, "discovery-failure");
    const filePath = writeSource(root, "kept.js", "export const value = 1;\n");
    persistIngestBaselineIfClean(
      root,
      new Map([[filePath, fs.statSync(filePath).mtimeMs]]),
      20,
      0,
      0,
      new Date("2026-08-10T18:00:00.000Z"),
    );

    expect(persistIngestBaselineIfClean(root, new Map(), 21, 0, 0)).toBe(false);
    expect(loadIngestBaseline(root)?.files.size).toBe(1);
    expect(loadIngestBaseline(root)?.currentRev).toBe(20);
  });

  it("uses ingest time for files absent from the mtime cache", async () => {
    const root = path.join(home, "partial-cache");
    const mappedFile = writeSource(root, "mapped.js", "export const mapped = true;\n");
    const uncachedFile = writeSource(root, "uncached.js", "");
    const ingestedAt = new Date("2026-08-09T18:00:00.000Z");
    fs.utimesSync(
      uncachedFile,
      new Date(ingestedAt.getTime() - 1_000),
      new Date(ingestedAt.getTime() - 1_000),
    );
    persistIngestBaselineIfClean(
      root,
      new Map([[mappedFile, fs.statSync(mappedFile).mtimeMs]]),
      13,
      0,
      0,
      ingestedAt,
    );

    expect((detectStaleFiles(root)).staleFiles).toBe(0);

    fs.utimesSync(
      uncachedFile,
      new Date(ingestedAt.getTime() + 1_000),
      new Date(ingestedAt.getTime() + 1_000),
    );
    expect(detectStaleFiles(root)).toMatchObject({
      staleFiles: 1,
      sampleChangedFiles: ["uncached.js"],
    });
  });

  it.each([
    { parseErrors: 1, commitErrors: 0 },
    { parseErrors: 0, commitErrors: 1 },
  ])("does not advance the baseline when a map fails", async ({ parseErrors, commitErrors }) => {
    const root = path.join(home, "failed-map");
    const filePath = writeSource(root, "index.js", "export const value = 1;\n");
    const oldMtime = fs.statSync(filePath).mtimeMs;
    const oldTimestamp = new Date("2026-08-09T16:00:00.000Z");
    persistIngestBaselineIfClean(root, new Map([[filePath, oldMtime]]), 7, 0, 0, oldTimestamp);

    const changedMtime = moveMtimeForward(filePath);
    expect(
      persistIngestBaselineIfClean(
        root,
        new Map([[filePath, changedMtime]]),
        8,
        parseErrors,
        commitErrors,
        new Date("2026-08-09T16:01:00.000Z"),
      ),
    ).toBe(false);

    const baseline = loadIngestBaseline(root);
    expect(baseline?.currentRev).toBe(7);
    expect(baseline?.lastIngestAt).toBe(oldTimestamp.toISOString());
    expect(baseline?.files.get(filePath)).toBe(oldMtime);
    expect((detectStaleFiles(root)).staleFiles).toBe(1);
  });
});
