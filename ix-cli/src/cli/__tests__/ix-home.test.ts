// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parse } from "yaml";

import { ixHome } from "../ix-home.js";
import { ingestMtimeCachePath, mapBaselinePath, saveConfig, stitchScopeCachePath } from "../config.js";
import { ensureLocalConfig } from "../bootstrap.js";

// IX_HOME, not HOME. `os.homedir()` answers from the process environment that
// libuv sees, which a worker thread's `process.env` write never reaches -- so a
// HOME override silently does nothing under vitest's threads pool while
// `process.env.IX_HOME` is read straight off the object and works in either.
let home: string;
let savedIxHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-home-"));
  savedIxHome = process.env.IX_HOME;
  process.env.IX_HOME = home;
});

afterEach(() => {
  if (savedIxHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = savedIxHome;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("ixHome", () => {
  it("is IX_HOME when set", () => {
    expect(ixHome()).toBe(home);
  });

  it("falls back to ~/.ix when IX_HOME is unset", () => {
    delete process.env.IX_HOME;
    expect(ixHome()).toBe(nodePath.join(os.homedir(), ".ix"));
  });

  it("is re-read on every call, so a module imported earlier still sees a change", () => {
    const first = ixHome();
    const second = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-home-2-"));
    process.env.IX_HOME = second;
    try {
      expect(ixHome()).toBe(second);
      expect(ixHome()).not.toBe(first);
    } finally {
      process.env.IX_HOME = home;
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});

describe("state that follows IX_HOME", () => {
  // The regression this file exists for: every one of these used a bare
  // `homedir()`, so setting IX_HOME isolated the CLI install and nothing else.
  // A benchmark harness that set it still read its endpoint from, and
  // registered its throwaway worktrees in, the developer's real ~/.ix.
  it("writes config.yaml under IX_HOME, not under the real home", () => {
    // Snapshot the real file (or its absence) so "nothing landed there" is a
    // comparison, not a guess about a filename that is never written.
    const real = nodePath.join(os.homedir(), ".ix", "config.yaml");
    const readReal = () => (fs.existsSync(real) ? fs.readFileSync(real, "utf8") : null);
    const before = readReal();

    saveConfig({ endpoint: "http://ix-home.example", format: "json" });

    const written = nodePath.join(home, "config.yaml");
    expect(fs.existsSync(written)).toBe(true);
    expect(parse(fs.readFileSync(written, "utf8"))).toMatchObject({
      endpoint: "http://ix-home.example",
      format: "json",
    });
    expect(readReal()).toBe(before);
  });

  it("keeps the 0700 directory / 0600 file guarantees under IX_HOME", () => {
    if (process.platform === "win32") return; // POSIX bits are meaningless there
    const nested = nodePath.join(home, "nested");
    process.env.IX_HOME = nested;
    saveConfig({ endpoint: "http://localhost:8090", format: "text" });
    expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nodePath.join(nested, "config.yaml")).mode & 0o777).toBe(0o600);
  });

  it("puts the per-project caches under IX_HOME", () => {
    for (const p of [ingestMtimeCachePath("/tmp/project"), mapBaselinePath("/tmp/project"),
                     stitchScopeCachePath("ws-1")]) {
      expect(nodePath.dirname(p)).toBe(home);
    }
  });
});

describe("ensureLocalConfig under IX_HOME", () => {
  // These need a fake "real" home with a legacy ~/.ix/config.yaml in it. A
  // HOME/USERPROFILE override is honoured by os.homedir() under vitest's
  // default forks pool only, so each test checks it took and otherwise returns
  // rather than asserting against the developer's actual home.
  let fakeHome: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-home-legacy-"));
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedProfile;
    vi.restoreAllMocks();
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("names the untouched legacy ~/.ix/config.yaml when it creates a fresh config under IX_HOME", () => {
    if (os.homedir() !== fakeHome) return;
    const legacy = nodePath.join(fakeHome, ".ix", "config.yaml");
    fs.mkdirSync(nodePath.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "endpoint: http://legacy.example\nformat: text\n");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(ensureLocalConfig()).toBe(true);

    const said = write.mock.calls.map(c => String(c[0])).join("");
    expect(said).toContain("IX_HOME is set");
    expect(said).toContain(nodePath.join(home, "config.yaml"));
    expect(said).toContain(legacy);
    // Told about, not touched.
    expect(fs.readFileSync(legacy, "utf8")).toBe("endpoint: http://legacy.example\nformat: text\n");
    // And the new file is the default one, not a copy.
    expect(parse(fs.readFileSync(nodePath.join(home, "config.yaml"), "utf8"))).not.toMatchObject({
      endpoint: "http://legacy.example",
    });
  });

  it("says nothing when there is no legacy config to point at", () => {
    if (os.homedir() !== fakeHome) return;
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(ensureLocalConfig()).toBe(true);
    expect(write.mock.calls.map(c => String(c[0])).join("")).not.toContain("IX_HOME is set");
  });

  it("says nothing on the second call, because the file already exists", () => {
    if (os.homedir() !== fakeHome) return;
    const legacy = nodePath.join(fakeHome, ".ix", "config.yaml");
    fs.mkdirSync(nodePath.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "endpoint: http://legacy.example\n");
    expect(ensureLocalConfig()).toBe(true);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(ensureLocalConfig()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
