// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The old project helper scripts were replaced by `ix map` / `ix mcp install`
 * and `scripts/backend.sh`. Keep them from creeping back, and keep the dev
 * setup script from pointing at them.
 */

const repoFile = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

const REMOVED = [
  "scripts/connect.sh",
  "scripts/disconnect.sh",
  "scripts/ingest.sh",
  "scripts/init-project.sh",
  "scripts/dev/shutdown.sh",
];

describe("removed legacy helper scripts", () => {
  it.each(REMOVED)("%s does not exist", (path) => {
    expect(existsSync(repoFile(path))).toBe(false);
  });

  it("scripts/dev/setup.sh does not reference them", () => {
    const setup = readFileSync(repoFile("scripts/dev/setup.sh"), "utf8");

    for (const path of REMOVED) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      expect(setup, name).not.toContain(name);
    }
  });
});
