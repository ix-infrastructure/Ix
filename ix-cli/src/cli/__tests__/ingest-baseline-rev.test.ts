import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ingestMtimeCachePath } from "../config.js";
import { loadIngestBaseline, saveIngestBaseline } from "../ingest-baseline.js";
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
