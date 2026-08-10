import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ingestMtimeCachePath } from "../config.js";
import { loadIngestBaseline, saveIngestBaseline } from "../ingest-baseline.js";

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
// insisted it be a non-negative integer; saveIngestBaseline used to accept
// whatever arrived. Anything that clears a bare `> 0` but is not an integer got
// written, was then rejected on the next read, and reset the rev to 0 — a full
// re-ingest every run, silently.
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

  it("still records the rest of the baseline when the rev is rejected", () => {
    const root = path.join(home, "p");
    saveIngestBaseline(root, files, Number.NaN);

    // A bad rev must not cost the mtime cache — that is the part that makes the
    // next map fast, and it never came from the backend at all.
    expect(loadIngestBaseline(root)?.files.get("a.ts")).toBe(1_000);
    expect(loadIngestBaseline(root)?.currentRev).toBe(0);
  });
});
