// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clearIngestMtimeCache, ingestMtimeCachePath, ingestRebuildPath } from "../config.js";
import {
  clearRebuildProgress, extractorChanged, loadIngestBaseline, loadRebuildProgress, saveIngestBaseline, saveRebuildProgress,
} from "../ingest-baseline.js";
import { advanceRev } from "../commands/ingest.js";

let home: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

/** The rev exactly as it sits on disk — loadIngestBaseline would launder it. */
function rawRev(root: string): unknown {
  return JSON.parse(fs.readFileSync(ingestMtimeCachePath(root), "utf-8")).currentRev;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ix-baseline-rev-"));
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

// The rev comes off the backend's commit response. loadIngestBaseline has always
// insisted on a non-negative integer; saveIngestBaseline used to accept whatever
// arrived, so anything that cleared a bare `> 0` without being an integer got
// written and was then rejected on the next read. `ix status` is the only reader
// — incremental skipping runs off the mtime map — so the cost is a wrong
// Revision line, not a re-ingest.
describe("ingest baseline rev normalization", () => {
  const files = new Map<string, number>([["a.ts", 1_000]]);

  it("persists a real rev unchanged", () => {
    const root = path.join(home, "p");
    saveIngestBaseline(root, files, 7);

    expect(rawRev(root)).toBe(7);
    expect(loadIngestBaseline(root)?.currentRev).toBe(7);
  });

  it("keeps the previous rev when the backend answers with a numeric string", () => {
    const root = path.join(home, "p");
    saveIngestBaseline(root, files, 5);
    saveIngestBaseline(root, files, "9" as unknown as number);

    // "9" > 0 is true, so the old code wrote the string through. Round-tripping
    // it is what mattered: the read side drops a non-number and hands back 0.
    expect(rawRev(root)).toBe(5);
    expect(loadIngestBaseline(root)?.currentRev).toBe(5);
  });

  it("keeps the previous rev when the backend answers with a fraction", () => {
    const root = path.join(home, "p");
    saveIngestBaseline(root, files, 5);
    saveIngestBaseline(root, files, 6.5);

    expect(rawRev(root)).toBe(5);
    expect(loadIngestBaseline(root)?.currentRev).toBe(5);
  });

  it("still records the mtimes when the rev is rejected", () => {
    const root = path.join(home, "p");
    saveIngestBaseline(root, files, "9" as unknown as number);

    // A bad rev must not cost the mtime cache — that is the part that makes the
    // next map fast, and it never came from the backend at all.
    expect(loadIngestBaseline(root)?.files.get("a.ts")).toBe(1_000);
  });
});

// The save side is the last stop, not the first. The same malformed value enters
// at the accumulator, where a bare `>` compares it as a string: "9" becomes the
// max, then "10" > "9" is false and the max walks backwards. It also ships to
// the user as the `latestRev` field of `ix ingest --format json`.
describe("advanceRev", () => {
  it("takes a larger real rev", () => {
    expect(advanceRev(3, 9)).toBe(9);
  });

  it("keeps the current max when the incoming rev is smaller", () => {
    expect(advanceRev(9, 3)).toBe(9);
  });

  it("ignores a numeric string instead of letting it become the max", () => {
    // The bug this pins: "9" > 0 coerces true, so the string won and the next
    // comparison silently became lexicographic.
    expect(advanceRev(0, "9")).toBe(0);
    expect(advanceRev(9, "10")).toBe(9);
  });

  it("ignores fractions, NaN, null and undefined", () => {
    expect(advanceRev(3, 6.5)).toBe(3);
    expect(advanceRev(3, Number.NaN)).toBe(3);
    expect(advanceRev(3, null)).toBe(3);
    expect(advanceRev(3, undefined)).toBe(3);
  });
});

describe("ingest baseline extractor", () => {
  const files = new Map<string, number>([["a.ts", 1_000]]);

  it("round-trips the extractor and reads a missing one as null", () => {
    const root = path.join(home, "p");
    saveIngestBaseline(root, files, 1, new Date(), new Map(), "tree-sitter/9.9");
    expect(loadIngestBaseline(root)?.extractor).toBe("tree-sitter/9.9");

    saveIngestBaseline(root, files, 1);
    expect(loadIngestBaseline(root)?.extractor).toBeNull();
  });

  it("counts an unrecorded or different extractor as a change, and no baseline as none", () => {
    const root = path.join(home, "p");
    expect(extractorChanged(null, "tree-sitter/9.9")).toBe(false);

    saveIngestBaseline(root, files, 1, new Date(), new Map(), "tree-sitter/9.9");
    expect(extractorChanged(loadIngestBaseline(root), "tree-sitter/9.9")).toBe(false);
    expect(extractorChanged(loadIngestBaseline(root), "tree-sitter/9.10")).toBe(true);

    saveIngestBaseline(root, files, 1);
    expect(extractorChanged(loadIngestBaseline(root), "tree-sitter/9.9")).toBe(true);
  });
});

describe("extractor re-ingest progress", () => {
  const done = new Map<string, number>([["/p/a.ts", 1_000], ["/p/b.ts", 2_000]]);

  it("round-trips for the same root and extractor only", () => {
    const root = path.join(home, "p");
    saveRebuildProgress(root, "tree-sitter/9.9", done);
    expect(loadRebuildProgress(root, "tree-sitter/9.9")).toEqual(done);
    expect(loadRebuildProgress(root, "tree-sitter/9.10"), "progress toward another extractor").toBeNull();
    expect(loadRebuildProgress(path.join(home, "q"), "tree-sitter/9.9")).toBeNull();
  });

  it("reads a damaged file as no progress", () => {
    const root = path.join(home, "p");
    saveRebuildProgress(root, "tree-sitter/9.9", done);
    fs.writeFileSync(ingestRebuildPath(root), "{\"root\":");
    expect(loadRebuildProgress(root, "tree-sitter/9.9")).toBeNull();
  });

  it("is cleared on completion and with the mtime cache", () => {
    const root = path.join(home, "p");
    saveRebuildProgress(root, "tree-sitter/9.9", done);
    clearRebuildProgress(root);
    expect(fs.existsSync(ingestRebuildPath(root))).toBe(false);

    // `ix reset` and workspace migration clear the mtime cache: the progress
    // describes the same graph and must go with it.
    saveRebuildProgress(root, "tree-sitter/9.9", done);
    clearIngestMtimeCache(root);
    expect(fs.existsSync(ingestRebuildPath(root))).toBe(false);
  });
});

describe("ingest baseline atomic write", () => {
  it("leaves no temp file behind when the rename fails", () => {
    const root = path.join(home, "p");
    const target = ingestMtimeCachePath(root);
    // A directory where the baseline goes makes the rename fail.
    fs.mkdirSync(target, { recursive: true });

    saveIngestBaseline(root, new Map([["a.ts", 1_000]]), 3);

    expect(fs.readdirSync(path.dirname(target)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});
