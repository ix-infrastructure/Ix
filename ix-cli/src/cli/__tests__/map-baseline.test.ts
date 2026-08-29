import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { persistIngestBaselineIfClean } from "../commands/ingest.js";
import { persistCompletedMapBaseline } from "../commands/map.js";
import { loadMapBaseline, saveMapBaseline } from "../map-baseline.js";
import { ingestMtimeCachePath } from "../config.js";
import { hasCompletedMapBaseline } from "../stale.js";

let home: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ix-map-baseline-"));
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

describe("architecture map baseline", () => {
  it("records a non-empty completed map against its source revision", () => {
    const root = path.join(home, "workspace");
    const filePath = path.join(root, "index.php");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, "<?php function value() { return 1; }\n");
    persistIngestBaselineIfClean(
      root,
      new Map([[filePath, fs.statSync(filePath).mtimeMs]]),
      12,
      0,
      0,
    );

    expect(
      persistCompletedMapBaseline(
        {
          file_count: 1,
          region_count: 1,
          regions: [],
          outcome: "full_local_completed",
        },
        root,
      ),
    ).toBe(true);

    expect(loadMapBaseline(root)).toEqual({ sourceRev: 12 });
    expect(hasCompletedMapBaseline(root)).toBe(true);
  });

  it("records a one-file workspace that has no regions to build", () => {
    // The E2E fixture: one Python file, mapped as `1 files · 0s/0ss/0m
    // regions`. There is no hierarchy to build over a single file and no
    // later run will produce one, so refusing to record completion here
    // leaves `ix doctor` unhealthy for ever, telling the user to run the
    // command that just ran. `describeRegionlessCompletedMap` is what
    // rejects a regionless map over real source; it needs two discovered
    // files, which this workspace does not have.
    const root = path.join(home, "one-file");
    const filePath = path.join(root, "billing.py");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, "class Billing:\n    pass\n");
    persistIngestBaselineIfClean(
      root,
      new Map([[filePath, fs.statSync(filePath).mtimeMs]]),
      1,
      0,
      0,
    );

    expect(
      persistCompletedMapBaseline(
        {
          file_count: 1,
          region_count: 0,
          regions: [],
          outcome: "full_local_completed",
        },
        root,
      ),
    ).toBe(true);

    expect(hasCompletedMapBaseline(root)).toBe(true);
  });

  it.each(["local_map_too_large", "local_map_not_recommended"])(
    "does not record the guardrail outcome %s",
    (outcome) => {
      const root = path.join(home, "workspace");
      const filePath = path.join(root, "index.js");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(filePath, "export const value = 1;\n");
      persistIngestBaselineIfClean(
        root,
        new Map([[filePath, fs.statSync(filePath).mtimeMs]]),
        1,
        0,
        0,
      );
      expect(
        persistCompletedMapBaseline(
          {
            file_count: 1,
            region_count: 0,
            regions: [],
            outcome,
          },
          root,
        ),
      ).toBe(false);
      expect(loadMapBaseline(root)).toBeNull();
    },
  );
});

/**
 * Every workspace that existed before the marker did has a clean ingest
 * baseline and no marker, and the CLI that wrote it reported that state as
 * map-complete. Reversing the answer on upgrade would fail `ix doctor` on all
 * of them at once, so a baseline with no `tracksMapBaseline` is grandfathered
 * until the next ingest rewrites it.
 */
describe("upgrade from a baseline written before the map marker", () => {
  function writeLegacyBaseline(root: string, filePath: string, currentRev: number): void {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, "export const value = 1;\n");
    fs.mkdirSync(path.dirname(ingestMtimeCachePath(root)), { recursive: true });
    // The exact shape 0.10.4 wrote: no `tracksMapBaseline`.
    fs.writeFileSync(ingestMtimeCachePath(root), JSON.stringify({
      root,
      files: { [filePath]: fs.statSync(filePath).mtimeMs },
      deletedFiles: {},
      currentRev,
      lastIngestAt: "2026-01-01T00:00:00.000Z",
    }));
  }

  it("reports an existing workspace as mapped rather than failing it on upgrade", () => {
    const root = path.join(home, "legacy");
    writeLegacyBaseline(root, path.join(root, "index.ts"), 7);

    expect(loadMapBaseline(root)).toBeNull();
    expect(hasCompletedMapBaseline(root)).toBe(true);
  });

  it("stops grandfathering once an ingest rewrites the baseline", () => {
    const root = path.join(home, "upgraded");
    const filePath = path.join(root, "index.ts");
    writeLegacyBaseline(root, filePath, 7);
    expect(hasCompletedMapBaseline(root)).toBe(true);

    // A 0.10.5 ingest — the map that follows it is the one that must record
    // completion, and until it does the workspace is honestly incomplete.
    persistIngestBaselineIfClean(
      root,
      new Map([[filePath, fs.statSync(filePath).mtimeMs]]),
      8,
      0,
      0,
    );

    expect(hasCompletedMapBaseline(root)).toBe(false);
  });

  it("does not grandfather past a marker that is behind the source revision", () => {
    const root = path.join(home, "stale-marker");
    writeLegacyBaseline(root, path.join(root, "index.ts"), 9);
    saveMapBaseline(root, 4);

    expect(hasCompletedMapBaseline(root)).toBe(false);
  });
});
