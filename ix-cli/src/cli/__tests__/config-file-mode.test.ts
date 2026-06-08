import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

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
  fs.mkdirSync(nodePath.join(home, ".ix"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const cfgPath = () => nodePath.join(home, ".ix", "config.yaml");

// POSIX permission bits are meaningless on Windows (chmod only toggles the
// read-only bit), so statSync reports modes like 0o666 and these assertions
// can't hold. The 0600 guard protects unix-like systems; skip the checks there.
const posix = process.platform !== "win32";

describe("saveConfig file mode (credentials live in this file)", () => {
  it.skipIf(!posix)("creates the config 0600", () => {
    saveConfig({ endpoint: "http://localhost:8090", format: "text" });
    expect(fs.statSync(cfgPath()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("tightens a pre-existing group/world-readable config to 0600", () => {
    fs.writeFileSync(cfgPath(), "endpoint: http://localhost:8090\nformat: text\n", { mode: 0o644 });
    fs.chmodSync(cfgPath(), 0o644); // force 0644 regardless of umask
    saveConfig({ endpoint: "http://localhost:8090", format: "text" });
    // No group/world bits remain.
    expect(fs.statSync(cfgPath()).mode & 0o077).toBe(0);
  });
});
