// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parse } from "yaml";

import { saveConfig } from "../config.js";

// Isolate the Ix state directory with IX_HOME, deliberately NOT with HOME.
//
// This file used to override HOME/USERPROFILE, which worked only because
// `os.homedir()` happens to read $HOME on POSIX under vitest's default (forks)
// pool. Under `--pool=threads` a worker's `process.env` write never reaches the
// environment libuv reads, so `homedir()` returned the developer's REAL home
// and every `saveConfig` below wrote their actual ~/.ix/config.yaml -- and
// since `workspaces` is an OSS-owned key, the config object these tests pass
// (which has none) DELETED their whole workspace registry. The six failing
// assertions were the only warning. `process.env.IX_HOME` is read off the
// object by `ixHome()`, so it isolates under either pool.
let home: string;
let savedIxHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-cfgmode-"));
  savedIxHome = process.env.IX_HOME;
  // A path that does not exist yet: the first test asserts saveConfig creates it.
  process.env.IX_HOME = nodePath.join(home, ".ix");
});

afterEach(() => {
  if (savedIxHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = savedIxHome;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const cfgPath = () => nodePath.join(home, ".ix", "config.yaml");
const cfgDir = () => nodePath.dirname(cfgPath());
const readConfig = () => parse(fs.readFileSync(cfgPath(), "utf8")) as Record<string, unknown>;

// POSIX permission bits are meaningless on Windows (chmod only toggles the
// read-only bit), so statSync reports modes like 0o666 and these assertions
// can't hold. The 0600 guard protects unix-like systems; skip the checks there.
const posix = process.platform !== "win32";

describe("saveConfig persistence", () => {
  it("creates a config from a fresh home without leaving the staging file", () => {
    expect(fs.existsSync(cfgDir())).toBe(false);

    saveConfig({ endpoint: "http://localhost:8090", format: "json" });

    expect(readConfig()).toMatchObject({ endpoint: "http://localhost:8090", format: "json" });
    expect(fs.readdirSync(cfgDir())).toEqual(["config.yaml"]);
  });

  it.skipIf(!posix)("creates the config directory 0700", () => {
    // The 0600 on the file is undone by a 0755 directory beside it: the names
    // in ~/.ix are themselves a disclosure, and this is the call that creates it.
    saveConfig({ endpoint: "http://localhost:8090", format: "text" });
    expect(fs.statSync(cfgDir()).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)("creates the config 0600", () => {
    saveConfig({ endpoint: "http://localhost:8090", format: "text" });
    expect(fs.statSync(cfgPath()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("tightens a pre-existing group/world-readable config to 0600", () => {
    fs.mkdirSync(cfgDir(), { recursive: true });
    fs.writeFileSync(cfgPath(), "endpoint: http://localhost:8090\nformat: text\n", { mode: 0o644 });
    fs.chmodSync(cfgPath(), 0o644); // force 0644 regardless of umask
    saveConfig({ endpoint: "http://localhost:8090", format: "text" });
    // No group/world bits remain.
    expect(fs.statSync(cfgPath()).mode & 0o077).toBe(0);
  });

  it.skipIf(!posix)("atomically replaces an existing config and removes the staging file", () => {
    fs.mkdirSync(cfgDir(), { recursive: true });
    fs.writeFileSync(cfgPath(), "endpoint: http://old.example\nformat: text\n");
    const previousInode = fs.statSync(cfgPath()).ino;

    saveConfig({ endpoint: "http://new.example", format: "json" });

    const currentInode = fs.statSync(cfgPath()).ino;
    if (previousInode !== 0 && currentInode !== 0) expect(currentInode).not.toBe(previousInode);
    expect(fs.readdirSync(cfgDir())).toEqual(["config.yaml"]);
    expect(readConfig()).toMatchObject({ endpoint: "http://new.example", format: "json" });
  });

  it("preserves extension and user-owned fields in an existing config", () => {
    fs.mkdirSync(cfgDir(), { recursive: true });
    fs.writeFileSync(
      cfgPath(),
      [
        "endpoint: http://old.example",
        "format: text",
        "active: private-cloud",
        "instances:",
        "  private-cloud:",
        "    refresh_token: secret",
        "user:",
        "  name: Alice",
        "",
      ].join("\n"),
    );

    saveConfig({ endpoint: "http://new.example", format: "json" });

    expect(readConfig()).toEqual({
      active: "private-cloud",
      instances: { "private-cloud": { refresh_token: "secret" } },
      user: { name: "Alice" },
      endpoint: "http://new.example",
      format: "json",
    });
  });
});
