import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `.backend-version` used to be a record of what the CLI last INSTALLED, which
 * is the same thing as what is RUNNING only while nothing else moves the image.
 * Pull through docker compose and the file names an older release than the
 * container, so "Backend update available" fires on every command for ever.
 *
 * Ix#466 fixed the paths that run our code by recording at the pull.
 * Ix-memory#157 makes the container report the release it was built as, so the
 * remaining paths can be fixed by asking it. This is that consumer.
 */
describe("recordBackendRelease", () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    priorHome = process.env.IX_HOME;
    home = mkdtempSync(join(tmpdir(), "ix-release-report-"));
    process.env.IX_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (priorHome === undefined) delete process.env.IX_HOME;
    else process.env.IX_HOME = priorHome;
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Re-imported so IX_HOME above is the one the module resolves the stamp from. */
  const load = () => import("../commands/upgrade.js");
  const stamp = () => join(home, ".backend-version");
  const tracked = () => (existsSync(stamp()) ? readFileSync(stamp(), "utf-8") : null);

  it("writes what the backend reports", async () => {
    const { recordBackendRelease } = await load();
    recordBackendRelease("1.0.16");
    expect(tracked()).toBe("1.0.16");
  });

  it("corrects a stamp that is BEHIND the running container", async () => {
    // The reported bug: pulled a newer image outside the CLI, so the file names
    // the release that was installed and the notice nags for ever.
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    recordBackendRelease("1.0.16");
    expect(tracked()).toBe("1.0.16");
  });

  it("corrects a stamp that is AHEAD of the running container", async () => {
    // The direction no local inspection can fix, and the one that is dangerous:
    // an ahead stamp silences the notice through the next release the user
    // should have been told about. The container's own answer settles it.
    writeFileSync(stamp(), "1.0.17");
    const { recordBackendRelease } = await load();
    recordBackendRelease("1.0.16");
    expect(tracked()).toBe("1.0.16");
  });

  it("writes nothing when the backend does not report a release", async () => {
    // Every backend older than Ix-memory#157, and every image not built by the
    // release pipeline. Absent must leave whatever was tracked alone rather
    // than clearing it — the old behaviour is the correct fallback.
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    for (const nothing of [undefined, null, ""]) {
      recordBackendRelease(nothing);
      expect(tracked()).toBe("1.0.13");
    }
  });

  it("refuses a value that is not version-shaped", async () => {
    // It is a container env var, so an operator can set it to anything. The
    // notice compares this file against the release feed; arbitrary text in it
    // is worse than the stale value it would replace.
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    for (const junk of ["latest", "not a version", "../../evil", "9.9.9/../../evil"]) {
      recordBackendRelease(junk);
      expect(tracked()).toBe("1.0.13");
    }
  });

  it("accepts a release carrying a pre-release and build metadata", async () => {
    // The shape that once broke `ix upgrade`; VERSION_RE admits it deliberately
    // and the backend validates against the same pattern.
    const { recordBackendRelease } = await load();
    recordBackendRelease("0.9.0-rc.1+abc1234");
    expect(tracked()).toBe("0.9.0-rc.1+abc1234");
  });

  it("does not rewrite a stamp that already agrees", async () => {
    // Runs on every `ix status` / `ix map`, and the write is not atomic: a
    // needless truncate-and-rewrite on the hot path is a window for a torn read
    // in another process for no gain.
    //
    // Asserted on the MTIME, not the contents: rewriting the same string leaves
    // the contents identical, so a contents check passes whether or not the
    // write happened. The mtime is pinned to a known past value first, which a
    // write would reset to now.
    writeFileSync(stamp(), "1.0.16");
    const pinned = new Date("2020-01-02T03:04:05Z");
    utimesSync(stamp(), pinned, pinned);
    const before = statSync(stamp()).mtimeMs;

    const { recordBackendRelease } = await load();
    recordBackendRelease("1.0.16");

    expect(statSync(stamp()).mtimeMs).toBe(before);
    expect(readFileSync(stamp(), "utf-8")).toBe("1.0.16");

    // ...and the control: a DIFFERENT version does rewrite it, so the assertion
    // above is the short-circuit and not an mtime that never moves.
    recordBackendRelease("1.0.17");
    expect(statSync(stamp()).mtimeMs).not.toBe(before);
    expect(readFileSync(stamp(), "utf-8")).toBe("1.0.17");
  });

  it("never throws, whatever the stamp path is", async () => {
    // Attached to commands the user actually ran — `ix status` must not fail
    // because IX_HOME is read-only.
    mkdirSync(stamp(), { recursive: true }); // a directory where the file goes
    const { recordBackendRelease } = await load();
    expect(() => recordBackendRelease("1.0.16")).not.toThrow();
  });
});

/**
 * The recorder is only worth anything at the sites that already hold a health
 * response, and adding one is the kind of thing that gets forgotten. This
 * enumerates them from the source rather than trusting a list in a comment.
 */
describe("every site that reads /v1/health records the release", () => {
  const CMDS = join(HERE, "..", "commands");

  /** Files that call client.health(), found rather than listed. */
  const callers = readdirSync(CMDS)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, src: readFileSync(join(CMDS, f), "utf-8") }))
    .filter((f) => /\bclient\.health\(\)/.test(f.src));

  it("finds the health callers at all", () => {
    // Guards the two tests below: an empty list would satisfy any `every`.
    expect(callers.map((c) => c.file).sort()).toContain("status.ts");
    expect(callers.length).toBeGreaterThanOrEqual(2);
  });

  it("has each of them record what it read", () => {
    const missing = callers
      .filter((c) => !/recordBackendRelease\(/.test(c.src))
      .map((c) => c.file);
    expect(missing).toEqual([]);
  });

  it("keeps checkBackendSchema carrying the value out, since it cannot record it itself", () => {
    // backend-status.ts fetches health too, but importing upgrade.ts there is a
    // cycle — upgrade.ts already imports it. So it returns the value and its
    // caller records. If that stops, doctor silently loses the correction.
    const src = readFileSync(join(HERE, "..", "backend-status.ts"), "utf-8");
    expect(src).toMatch(/releaseVersion\s*:\s*string\s*\|\s*null/);
    expect(src).toMatch(/health\.release_version/);
    const doctor = readFileSync(join(CMDS, "doctor.ts"), "utf-8");
    expect(doctor).toMatch(/recordBackendRelease\(\s*s\.releaseVersion\s*\)/);
  });
});
