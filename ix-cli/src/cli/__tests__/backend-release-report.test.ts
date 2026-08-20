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

import { isNewer } from "../commands/upgrade.js";

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
  const load = () => import("../backend-version.js");
  const stamp = () => join(home, ".backend-version");
  const tracked = () => (existsSync(stamp()) ? readFileSync(stamp(), "utf-8") : null);

  /** The newest release the CLI knows about, from its own version cache. */
  const FEED = "1.0.16";

  it("writes what the backend reports", async () => {
    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("1.0.16", FEED, isNewer)).toBe(true);
    expect(tracked()).toBe("1.0.16");
  });

  it("corrects a stamp that is BEHIND the running container", async () => {
    // The reported bug: pulled a newer image outside the CLI, so the file names
    // the release that was installed and the notice nags for ever.
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    recordBackendRelease("1.0.16", FEED, isNewer);
    expect(tracked()).toBe("1.0.16");
  });

  it("corrects a stamp that is AHEAD of the running container", async () => {
    // The direction no local inspection can fix, and the dangerous one: an ahead
    // stamp silences the notice through the next release the user should have
    // been told about.
    writeFileSync(stamp(), "1.0.17");
    const { recordBackendRelease } = await load();
    recordBackendRelease("1.0.16", FEED, isNewer);
    expect(tracked()).toBe("1.0.16");
  });

  it("REFUSES a container claiming to be newer than any published release", async () => {
    // The whole reason this value is bounded. A typo in a compose override, or a
    // tampered image, reporting 99.0.0 would otherwise be written straight in —
    // after which backendUpdateAvailable is false for ever and `ix upgrade`
    // reports "already on the latest version" without ever pulling, so a
    // security release can never reach that machine.
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("99.0.0", FEED, isNewer)).toBe(false);
    expect(tracked()).toBe("1.0.13");
  });

  it("still repairs an ahead stamp when no release is known yet", async () => {
    // With no cache there is no ceiling, so only corrections that do not move
    // the stamp FORWARD are taken. That still fixes the dangerous direction and
    // defers the rest until checkForUpdate populates the cache.
    writeFileSync(stamp(), "1.0.17");
    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("1.0.16", null, isNewer)).toBe(true);
    expect(tracked()).toBe("1.0.16");
  });

  it("will not move the stamp forward when no release is known yet", async () => {
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("1.0.16", null, isNewer)).toBe(false);
    expect(tracked()).toBe("1.0.13");
  });

  it("ignores a corrupt ceiling rather than trusting it", async () => {
    // readCache only checks backendLatest is a string. A garbage ceiling must
    // fall back to the no-ceiling rule, not admit anything.
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("99.0.0", "not-a-version", isNewer)).toBe(false);
    expect(tracked()).toBe("1.0.13");
  });

  it("trims before matching, so a value with a trailing newline still lands", async () => {
    // JS `$` does not match before a trailing newline. A value from an
    // --env-file or a ConfigMap carries one, and without the trim the whole
    // feature no-ops with nothing to see. getTrackedVersion already trims on
    // the way out, so the two halves have to agree.
    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("1.0.16\n", FEED, isNewer)).toBe(true);
    expect(tracked()).toBe("1.0.16");
  });

  it("writes nothing when the backend does not report a release", async () => {
    // Every backend older than Ix-memory#157, and every image not built by the
    // release pipeline. Absent must leave whatever was tracked alone.
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    for (const nothing of [undefined, null, "", "   "]) {
      expect(recordBackendRelease(nothing, FEED, isNewer)).toBe(false);
      expect(tracked()).toBe("1.0.13");
    }
  });

  it("refuses a value that is not version-shaped, or is absurdly long", async () => {
    writeFileSync(stamp(), "1.0.13");
    const { recordBackendRelease } = await load();
    for (const junk of ["latest", "not a version", "../../evil", "9.9.9/../../evil"]) {
      expect(recordBackendRelease(junk, FEED, isNewer)).toBe(false);
      expect(tracked()).toBe("1.0.13");
    }
    // Version-shaped the whole way, rejected only by length — so deleting the
    // bound is caught rather than being masked by the shape test.
    expect(recordBackendRelease("1.0.0-" + "a".repeat(100), "99.0.0", isNewer)).toBe(false);
    expect(tracked()).toBe("1.0.13");
  });

  it("accepts a release carrying a pre-release and build metadata", async () => {
    // The shape that once broke `ix upgrade`; VERSION_RE admits it deliberately
    // and the backend validates against the same pattern.
    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("0.9.0-rc.1+abc1234", "0.9.0-rc.1+abc1234", isNewer)).toBe(true);
    expect(tracked()).toBe("0.9.0-rc.1+abc1234");
  });

  it("does not rewrite a stamp that already agrees", async () => {
    // Runs on every `ix status` / `ix map`. Asserted on the MTIME, not the
    // contents: rewriting the same string leaves the contents identical, so a
    // contents check passes whether or not the write happened.
    writeFileSync(stamp(), "1.0.16");
    const pinned = new Date("2020-01-02T03:04:05Z");
    utimesSync(stamp(), pinned, pinned);
    const before = statSync(stamp()).mtimeMs;

    const { recordBackendRelease } = await load();
    expect(recordBackendRelease("1.0.16", FEED, isNewer)).toBe(false);
    expect(statSync(stamp()).mtimeMs).toBe(before);

    // ...and the control: a different version DOES rewrite it.
    recordBackendRelease("1.0.15", FEED, isNewer);
    expect(statSync(stamp()).mtimeMs).not.toBe(before);
  });

  it("never throws when the write fails", async () => {
    // Attached to commands the user actually ran — `ix status` must not fail
    // because IX_HOME is read-only.
    mkdirSync(stamp(), { recursive: true }); // a directory where the file goes
    const { recordBackendRelease } = await load();
    expect(() => recordBackendRelease("1.0.16", FEED, isNewer)).not.toThrow();
  });
});

describe("isLocalEndpoint", () => {
  it("accepts the local backend the notice is about", async () => {
    const { isLocalEndpoint } = await import("../backend-version.js");
    for (const e of ["http://localhost:8090", "http://127.0.0.1:8090", "http://[::1]:8090"]) {
      expect(isLocalEndpoint(e)).toBe(true);
    }
  });

  it("rejects a remote deployment", async () => {
    // The stamp is global but the endpoint is per invocation, so
    // `IX_ENDPOINT=http://staging:8090 ix status` would otherwise record a
    // different deployment's release into the file that governs the LOCAL
    // docker image notice.
    const { isLocalEndpoint } = await import("../backend-version.js");
    for (const e of ["http://staging:8090", "https://ix.example.com", "http://10.0.0.5:8090"]) {
      expect(isLocalEndpoint(e)).toBe(false);
    }
  });

  it("rejects an unparseable endpoint rather than assuming local", async () => {
    const { isLocalEndpoint } = await import("../backend-version.js");
    expect(isLocalEndpoint("not a url")).toBe(false);
  });
});

/**
 * Recording happens inside the one function that fetches health, so forgetting
 * it is not a mistake a new call site can make. This pins that there is still
 * exactly one such function — the property that makes the design work.
 */
describe("health is fetched in exactly one place", () => {
  const SRC = join(HERE, "..");

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "__tests__" || e.name === "node_modules") return [];
      const full = join(dir, e.name);
      return e.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });

  // Any receiver, not just one literally named `client`: a renamed local would
  // otherwise drop the file out of the search entirely.
  const callers = walk(SRC)
    .map((f) => ({ file: f, src: readFileSync(f, "utf-8") }))
    .filter((f) => /\.health\s*\(\s*\)/.test(f.src))
    .map((f) => f.file.slice(SRC.length + 1).replace(/\\/g, "/"));

  it("finds the health callers at all", () => {
    // Guards the assertion below: an empty list would satisfy any comparison.
    expect(callers.length).toBeGreaterThan(0);
  });

  it("has only backend-version.ts and backend-status.ts calling .health()", () => {
    // backend-version.ts is the recording chokepoint. backend-status.ts's
    // checkBackendSchema is called only by `ix doctor`, which records through
    // its own reachable check; it cannot import the chokepoint because
    // upgrade.ts imports IT. Everything else must go through readBackendHealth.
    expect(callers.sort()).toEqual(["backend-status.ts", "backend-version.ts"]);
  });
});
