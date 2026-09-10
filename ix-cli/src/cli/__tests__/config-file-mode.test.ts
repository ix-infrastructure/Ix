// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parse } from "yaml";

import { saveConfig } from "../config.js";

// Isolate ~/.ix by pointing HOME/USERPROFILE at a temp dir per test.
let home: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-cfgmode-"));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
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
