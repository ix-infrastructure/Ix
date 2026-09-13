import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parse } from "yaml";

import { ixHome } from "../ix-home.js";
import { ingestMtimeCachePath, mapBaselinePath, saveConfig, stitchScopeCachePath } from "../config.js";

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
    saveConfig({ endpoint: "http://ix-home.example", format: "json" });

    const written = nodePath.join(home, "config.yaml");
    expect(fs.existsSync(written)).toBe(true);
    expect(parse(fs.readFileSync(written, "utf8"))).toMatchObject({
      endpoint: "http://ix-home.example",
      format: "json",
    });
    // And nothing landed in the real one.
    expect(fs.existsSync(nodePath.join(os.homedir(), ".ix", "config.yaml.tmp"))).toBe(false);
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
