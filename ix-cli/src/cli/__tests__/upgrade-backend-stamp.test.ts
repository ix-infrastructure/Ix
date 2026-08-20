import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { composeTracksLatestBackend, writeVersionStamp } from "../commands/upgrade.js";

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
 * Stamping after a pull is only sound if the compose that was started actually
 * tracks `:latest`. `ix docker start` falls back to ANY docker-compose.yml in
 * the working directory, so this is what stops the stamp claiming a release for
 * a container running a pinned tag, a digest, or a local build.
 */
describe("composeTracksLatestBackend", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  it("accepts the compose file this project actually ships", () => {
    // A drift guard. If the shipped compose ever pins a version instead of
    // tracking :latest, stamping after a pull stops being true — and it would
    // stop silently, since the stamp simply never gets written.
    const shipped = readFileSync(join(REPO_ROOT, "docker-compose.standalone.yml"), "utf-8");
    expect(composeTracksLatestBackend(shipped)).toBe(true);
  });

  it("accepts a quoted image reference", () => {
    expect(
      composeTracksLatestBackend('    image: "ghcr.io/ix-infrastructure/ix-memory-layer:latest"'),
    ).toBe(true);
  });

  it("refuses a pinned version tag", () => {
    expect(
      composeTracksLatestBackend("    image: ghcr.io/ix-infrastructure/ix-memory-layer:1.0.13"),
    ).toBe(false);
  });

  it("refuses a pinned digest", () => {
    expect(
      composeTracksLatestBackend(
        "    image: ghcr.io/ix-infrastructure/ix-memory-layer@sha256:944f76887832",
      ),
    ).toBe(false);
  });

  it("refuses a locally built or third-party image", () => {
    expect(composeTracksLatestBackend("    image: ix-memory-layer:dev")).toBe(false);
    expect(composeTracksLatestBackend("    image: arangodb:3.12")).toBe(false);
  });

  it("refuses a near-miss registry name", () => {
    // The dots in the image name are not wildcards: this is compared, not
    // matched. A pattern would accept this.
    expect(
      composeTracksLatestBackend("    image: ghcrXio/ix-infrastructure/ix-memory-layer:latest"),
    ).toBe(false);
  });

  it("refuses a tag that merely starts with latest", () => {
    // `:latest-debug` is a different image that a substring test would accept.
    expect(
      composeTracksLatestBackend(
        "    image: ghcr.io/ix-infrastructure/ix-memory-layer:latest-debug",
      ),
    ).toBe(false);
  });

  it("refuses the image republished under another registry", () => {
    // Contains the wanted reference in full, so only comparing the WHOLE value
    // rejects it — and it is a different image, pulled from somewhere we have
    // made no claim about.
    expect(
      composeTracksLatestBackend(
        "    image: mirror.internal/ghcr.io/ix-infrastructure/ix-memory-layer:latest",
      ),
    ).toBe(false);
  });

  it("refuses a compose that names no image at all", () => {
    expect(composeTracksLatestBackend("services:\n  memory-layer:\n    build: .")).toBe(false);
  });
});

/**
 * The two orderings that make the stamp safe cannot be exercised here — one
 * sits behind `docker compose up`, the other behind a network fetch — so they
 * are pinned as drift guards on the source. Both assert their landmarks exist
 * before comparing positions, so neither can pass on a `-1`.
 */
describe("the stamp is wired where it is true", () => {
  const dockerSource = readFileSync(new URL("../commands/docker.ts", import.meta.url), "utf-8");
  const upgradeSource = readFileSync(new URL("../commands/upgrade.ts", import.meta.url), "utf-8");

  it("ix docker start stamps AFTER the pull, not before", () => {
    const pull = dockerSource.indexOf('"--pull", "always"');
    const stamp = dockerSource.indexOf("await stampBackendVersionAfterPull(composeFile)");
    expect(pull).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(pull);
  });

  it("stampBackendVersionAfterPull checks the compose before fetching or writing", () => {
    const from = upgradeSource.indexOf("export async function stampBackendVersionAfterPull");
    expect(from).toBeGreaterThan(-1);
    const fn = upgradeSource.slice(from);
    const body = fn.slice(0, fn.indexOf("\n}"));

    const guard = body.indexOf("composeTracksLatestBackend(");
    const fetched = body.indexOf("fetchLatestRelease(");
    const written = body.indexOf("writeVersionStamp(");
    expect(guard).toBeGreaterThan(-1);
    expect(fetched).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fetched);
    expect(guard).toBeLessThan(written);
    // ...and it must return on the guard, not merely evaluate it.
    expect(body).toMatch(/if \(!composeTracksLatestBackend\(.*\)\) return;/);
  });
});
