import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeVersionStamp } from "../commands/upgrade.js";

/**
 * `.backend-version` drives the "Backend update available" notice on every
 * command. It was written by `ix upgrade` and by nothing else, so a backend
 * taken through `ix docker start` — which pulls `:latest` every time — left the
 * file naming an older release while running the current one, and nagged for
 * ever.
 *
 * The stamp is now written wherever a pull happens, which puts the weight on
 * this function: it runs attached to an operation the user actually asked for,
 * against a directory that may not exist, with a version that may not be known.
 */
describe("writeVersionStamp", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ix-stamp-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the version", () => {
    const file = join(home, ".backend-version");
    writeVersionStamp(file, "1.0.16");
    expect(readFileSync(file, "utf-8")).toBe("1.0.16");
  });

  it("creates the directory when it does not exist yet", () => {
    // The first install has no IX_HOME. Without the mkdir the write throws
    // ENOENT into the catch, the tracked version stays at 0.0.0 for ever, and
    // every command nags with nothing to say why.
    const file = join(home, "does", "not", "exist", ".backend-version");
    expect(existsSync(join(home, "does"))).toBe(false);
    writeVersionStamp(file, "1.0.16");
    expect(readFileSync(file, "utf-8")).toBe("1.0.16");
  });

  it("leaves an existing stamp alone when the version is not known", () => {
    // Offline, rate-limited, or a release that could not be parsed. Not knowing
    // which release we are on is not the same as being on none of them, and the
    // only safe direction for this file is BEHIND: a stamp that reads new hides
    // a stale backend and stops `ix upgrade` from ever fetching it.
    const file = join(home, ".backend-version");
    writeFileSync(file, "1.0.13");
    for (const unknown of [null, undefined, ""]) {
      writeVersionStamp(file, unknown);
      expect(readFileSync(file, "utf-8")).toBe("1.0.13");
    }
  });

  it("writes nothing at all rather than an empty stamp on a fresh install", () => {
    const file = join(home, ".backend-version");
    writeVersionStamp(file, null);
    expect(existsSync(file)).toBe(false);
  });

  it("does not throw when the path cannot be written", () => {
    // Bookkeeping attached to a command the user asked for must never be the
    // reason that command reports failure. A directory where the file should be
    // is the portable way to make the write fail.
    const file = join(home, "blocked");
    mkdirSync(file, { recursive: true });
    expect(() => writeVersionStamp(file, "1.0.16")).not.toThrow();
  });
});

/**
 * The stamp only helps if the pull path actually calls it, and that call cannot
 * be exercised here — it sits behind `docker compose up`. This is a drift guard
 * on the wiring: it fails if the call is removed, and if it is moved to before
 * the pull it is meant to record.
 */
describe("ix docker start records the version it pulled", () => {
  const source = readFileSync(
    new URL("../commands/docker.ts", import.meta.url),
    "utf-8",
  );

  it("calls the stamp helper", () => {
    expect(source).toContain("stampBackendVersionAfterPull()");
  });

  it("calls it AFTER the pull, not before", () => {
    const pull = source.indexOf('"--pull", "always"');
    const stamp = source.indexOf("await stampBackendVersionAfterPull()");
    // Both must exist, or `-1 < n` would quietly satisfy the ordering.
    expect(pull).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(pull);
  });
});
