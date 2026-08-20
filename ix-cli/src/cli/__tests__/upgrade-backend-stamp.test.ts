import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// stampBackendVersionAfterPull is imported dynamically below instead: it reads
// IX_HOME at module load, so it has to be loaded after the tests set one.
import {
  backendUpdateAvailable,
  composeTracksLatestBackend,
  writeVersionStamp,
} from "../commands/upgrade.js";

/**
 * What the user actually sees. Both branches of `checkForUpdate` made this
 * decision inline, so a change to one did not reach the other; it is one pure
 * function now, and this is the only coverage of the notice itself.
 */
describe("backendUpdateAvailable", () => {
  it("offers an upgrade when the release is ahead of the tracked version", () => {
    expect(backendUpdateAvailable("1.0.16", "1.0.13")).toBe(true);
  });

  it("says nothing when the tracked version is current or ahead", () => {
    expect(backendUpdateAvailable("1.0.16", "1.0.16")).toBe(false);
    expect(backendUpdateAvailable("1.0.16", "1.0.17")).toBe(false);
  });

  it("says nothing when no release is known", () => {
    // A failed or rate-limited fetch must not be read as "you are behind".
    expect(backendUpdateAvailable(undefined, "1.0.13")).toBe(false);
    expect(backendUpdateAvailable("", "1.0.13")).toBe(false);
  });

  it("offers the upgrade on a fresh install, where nothing is tracked", () => {
    // getTrackedVersion returns 0.0.0 when the file is absent or empty.
    expect(backendUpdateAvailable("1.0.16", "0.0.0")).toBe(true);
  });
});

/**
 * `.backend-version` drives the "Backend update available" notice on every
 * command. It is written at install time (install.sh, install.ps1) and by
 * `ix upgrade` — but it was not written by `ix docker start`, which pulls
 * `:latest` on every cold start, so a backend taken through that path left the
 * file naming the release that was installed while running a later one, and
 * nagged for ever.
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

  it("writes the version and reports that it did", () => {
    const file = join(home, ".backend-version");
    expect(writeVersionStamp(file, "1.0.16")).toBe(true);
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
      // The return value is the contract ("whether it was written"), and the
      // `ix upgrade` caller branches on it — so assert it, not just the file.
      expect(writeVersionStamp(file, unknown)).toBe(false);
      expect(readFileSync(file, "utf-8")).toBe("1.0.13");
    }
  });

  it("writes nothing at all rather than an empty stamp on a fresh install", () => {
    const file = join(home, ".backend-version");
    writeVersionStamp(file, null);
    expect(existsSync(file)).toBe(false);
  });

  it("reports a failed write instead of throwing", () => {
    // It must not throw: the docker-start caller has already brought containers
    // up by the time this runs. But it must not claim success either — the
    // `ix upgrade` caller turns a false into the error the user sees, which is
    // what stops it printing "Backend image updated" over a file that never
    // moved on a read-only IX_HOME. A directory where the file should be is the
    // portable way to make the write fail.
    const file = join(home, "blocked");
    mkdirSync(file, { recursive: true });
    let result: boolean | undefined;
    expect(() => {
      result = writeVersionStamp(file, "1.0.16");
    }).not.toThrow();
    expect(result).toBe(false);
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
 * `stampBackendVersionAfterPull` against a real, isolated IX_HOME.
 *
 * The module resolves BACKEND_VERSION_FILE and VERSION_CACHE from IX_HOME at
 * load, so IX_HOME is set and the module re-imported — without that, a
 * regression in the early return would have this reaching api.github.com and
 * overwriting the developer's own ~/.ix/.backend-version.
 */
describe("stampBackendVersionAfterPull, isolated", () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    priorHome = process.env.IX_HOME;
    home = mkdtempSync(join(tmpdir(), "ix-stamp-home-"));
    process.env.IX_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    // Unstub and reset BEFORE the rmSync: on Windows a just-written temp tree
    // can throw EBUSY/EPERM even with force, and anything after the throw never
    // runs — which would leave a fake global fetch installed for the rest of
    // the file. resetModules is here as well as in beforeEach because
    // beforeEach is describe-scoped: without it the NEXT behavioural describe
    // added to this file inherits this one's module instance, still bound to
    // the IX_HOME about to be deleted, and writes into a resurrected directory.
    vi.unstubAllGlobals();
    vi.resetModules();
    // vi.spyOn on an ALREADY-spied method hands back the existing mock, so
    // without this a later test's `warn` still carries the earlier test's
    // calls — which is how the console assertions below first went red.
    vi.restoreAllMocks();
    if (priorHome === undefined) delete process.env.IX_HOME;
    else process.env.IX_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Re-imported so IX_HOME above is the one the module reads. */
  const load = () => import("../commands/upgrade.js");

  it("stamps nothing, and reaches no network, when the compose cannot be read", async () => {
    // The compose read is the one call in here that can throw, and it must not
    // escape into `ix docker start`, which has already brought containers up.
    const fetchMock = feedReturns("v1.0.16");
    const mod = await load();
    await expect(
      mod.stampBackendVersionAfterPull(join(home, "no-such-compose.yml")),
    ).resolves.toBeUndefined();
    expect(existsSync(join(home, ".backend-version"))).toBe(false);
    // The half the name claims and nothing used to check: hoisting the fetch
    // above the compose guard passes every other assertion here.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** A compose the guard accepts, so the fetch-and-write path is reached. */
  const tracksLatest = () => {
    const compose = join(home, "docker-compose.yml");
    writeFileSync(
      compose,
      "services:\n  memory-layer:\n    image: ghcr.io/ix-infrastructure/ix-memory-layer:latest\n",
    );
    return compose;
  };

  /**
   * The release feed, stubbed — no test in here reaches the network. Each
   * returns the mock so a test can assert the request was (or was not) made.
   */
  const feedReturns = (tag: string) => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: tag }) }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  /** The feed answering with an error status. */
  const feedRefuses = () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  /** The feed unreachable — offline REJECTS, it does not answer !ok. */
  const feedUnreachable = () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ENOTFOUND api.github.com");
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("records the release it just pulled", async () => {
    // The behaviour this whole change exists to add. Without it, gutting the
    // write entirely leaves every other test in this file green.
    feedReturns("v1.0.16");
    const mod = await load();
    await mod.stampBackendVersionAfterPull(tracksLatest());
    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.0.16");
  });

  it("overwrites a stamp that had got ahead of the real release", async () => {
    // Self-heal in the other direction. The GHCR tag and the release feed are
    // published separately, so the file can legitimately read high; a
    // never-go-backwards rule would pin it there and silence the notice for
    // good.
    writeFileSync(join(home, ".backend-version"), "1.0.17");
    feedReturns("v1.0.16");
    const mod = await load();
    await mod.stampBackendVersionAfterPull(tracksLatest());
    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.0.16");
  });

  it("leaves the stamp alone when the release cannot be fetched", async () => {
    // Offline or rate-limited. Erring behind costs a nag; erring ahead hides a
    // stale backend, so this must not write.
    writeFileSync(join(home, ".backend-version"), "1.0.13");
    feedRefuses();
    const mod = await load();
    await mod.stampBackendVersionAfterPull(tracksLatest());
    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.0.13");
  });

  it("stamps nothing when the compose does not track :latest", async () => {
    // Stubbed so a regression in the guard is caught here rather than quietly
    // reaching the network — which is also what made this test pass offline
    // with the guard deleted.
    const fetchMock = feedReturns("v1.0.16");
    const compose = join(home, "docker-compose.yml");
    writeFileSync(compose, "services:\n  memory-layer:\n    image: ix-memory-layer:dev\n");
    const mod = await load();
    await mod.stampBackendVersionAfterPull(compose);
    expect(existsSync(join(home, ".backend-version"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the stamp alone when the feed is unreachable", async () => {
    // Offline REJECTS; it does not answer with `ok: false`. That throw is
    // caught inside fetchLatestRelease, and no test reached that path — so a
    // narrowing of its catch would escape into the outer one here, whose
    // comment says it cannot.
    writeFileSync(join(home, ".backend-version"), "1.0.13");
    const fetchMock = feedUnreachable();
    const mod = await load();
    await expect(mod.stampBackendVersionAfterPull(tracksLatest())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.0.13");
  });

  it("says why when the stamp cannot be written and the file is wrong", async () => {
    // The user is about to be nagged on every command; this is the only thing
    // that explains it. A directory where the file belongs makes the write fail
    // portably, and makes getTrackedVersion read 0.0.0.
    mkdirSync(join(home, ".backend-version"), { recursive: true });
    feedReturns("v1.0.16");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await load();
    await mod.stampBackendVersionAfterPull(tracksLatest());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(".backend-version");
  });

  it("stays quiet when the stamp cannot be written but already matches", async () => {
    // Same unwritable stamp, but nothing is out of date: tracked reads 0.0.0
    // and the feed says 0.0.0, so warning would promise a nag that never comes.
    mkdirSync(join(home, ".backend-version"), { recursive: true });
    feedReturns("v0.0.0");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await load();
    await mod.stampBackendVersionAfterPull(tracksLatest());
    expect(warn).not.toHaveBeenCalled();
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

  /**
   * Sliced to the `start` action's own body. Comparing offsets across the whole
   * file would also accept the call sitting in `docker restart`, `docker logs`
   * or the compose `up` FAILURE branch — all of which are defined after the
   * pull, and none of which pulled anything.
   */
  const startFrom = dockerSource.indexOf('.command("start")');
  const startTo = dockerSource.indexOf('.command("stop")', Math.max(startFrom, 0));
  const startAction = dockerSource.slice(startFrom, startTo);

  it("slices the start action, so the assertions below mean what they say", () => {
    // Guards the two tests that follow: if these anchors ever stop matching,
    // `slice(-1, -1)` is "" and every indexOf below would be -1.
    expect(startFrom).toBeGreaterThan(-1);
    expect(startTo).toBeGreaterThan(startFrom);
    expect(startAction).toContain('"--pull", "always"');
  });

  it("stamps AFTER the pull, not before", () => {
    const pull = startAction.indexOf('"--pull", "always"');
    const stamp = startAction.indexOf("await stampBackendVersionAfterPull(composeFile)");
    expect(pull).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(pull);
  });

  it("stamps between the pull and the health wait, on the path that always runs", () => {
    // Three positions have to be excluded, and "after the pull" excludes none
    // of them on its own:
    //   - inside the compose `up` catch, which exits 1 having started nothing;
    //   - after the health loop, which `return`s on the first healthy poll, so
    //     the stamp would run ONLY when the start timed out;
    //   - inside the loop's success branch, which is fine but not where it is.
    // Bounding it above by the loop pins the one position that always runs
    // after a successful pull.
    const stamp = startAction.indexOf("await stampBackendVersionAfterPull(composeFile)");
    const failureMessage = startAction.indexOf('"[error] Failed to start Docker containers."');
    // Asserted BEFORE it is used as a fromIndex: indexOf(x, -1) searches from 0
    // and silently finds the unrelated `!dockerAvailable()` exit higher up, so
    // an inlined search would let the stamp sit inside the failure branch.
    expect(failureMessage).toBeGreaterThan(-1);
    const failureExit = startAction.indexOf("process.exit(1)", failureMessage);
    const healthWait = startAction.indexOf("Waiting for services to become healthy");
    expect(failureExit).toBeGreaterThan(-1);
    expect(healthWait).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(failureExit);
    expect(stamp).toBeLessThan(healthWait);
  });

  it("bounds the release fetch, which is now awaited on a command", () => {
    // ix docker start awaits this. Undici's default headersTimeout is 300s, so
    // an unbounded fetch behind a captive portal or a proxy that accepts the
    // connection and never answers stalls the command for five minutes with
    // nothing printed. Not observable without a hanging server, so it is pinned
    // on the source.
    const from = upgradeSource.indexOf("async function fetchLatestRelease");
    expect(from).toBeGreaterThan(-1);
    const fn = upgradeSource.slice(from, upgradeSource.indexOf("\n}", from));

    // The signal must be INSIDE the fetch(...) argument list: building the
    // options object and then calling `fetch(url)` without it leaves the fetch
    // unbounded. The first argument is matched loosely so hoisting the URL to a
    // const does not read as a missing timeout.
    expect(fn).toMatch(
      /await fetch\(\s*[^,]+,\s*\{\s*signal:\s*AbortSignal\.timeout\(\s*timeoutMs\s*\)\s*,?\s*\}\s*,?\s*\)/,
    );
    // ...and there is only the one fetch, so the matched call is the one made.
    expect(fn.match(/\bfetch\(/g)).toHaveLength(1);

    // Matching `timeout(timeoutMs)` says nothing about the value, so pin the
    // default itself — 300_000 is undici's own, i.e. no bound at all.
    const declared = /timeoutMs: number = ([0-9_]+)/.exec(upgradeSource);
    expect(declared).not.toBeNull();
    expect(Number(declared![1].replace(/_/g, ""))).toBeLessThanOrEqual(60_000);
  });

  it("gives the stamp path its own shorter bound", () => {
    // The default is sized for `ix upgrade`, which the user chose to wait for.
    // The stamp runs behind `ix docker start` with the containers already up,
    // and an argument that is never passed is a bound that does not exist —
    // which is exactly what happened when this parameter was first added.
    const from = upgradeSource.indexOf("export async function stampBackendVersionAfterPull");
    expect(from).toBeGreaterThan(-1);
    const body = upgradeSource.slice(from, upgradeSource.indexOf("\n}", from));
    const call = /fetchLatestRelease\(\s*MEMORY_LAYER_DIST_REPO\s*,\s*([0-9_]+)\s*\)/.exec(body);
    expect(call).not.toBeNull();
    expect(Number(call![1].replace(/_/g, ""))).toBeLessThanOrEqual(15_000);
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
