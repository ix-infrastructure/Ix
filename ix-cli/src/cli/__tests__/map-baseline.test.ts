import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { persistIngestBaselineIfClean } from "../commands/ingest.js";
import { persistCompletedMapBaseline } from "../commands/map.js";
import { loadMapBaseline } from "../map-baseline.js";
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
