// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Imported statically, so the module is loaded -- and anything it computes at
// import time is fixed -- before any test below changes IX_HOME. That is the
// order the leak needed: a module that bound `$IX_HOME/.backend-version` to a
// const at load kept writing to whatever home was current then, however a
// later test isolated itself.
import { backendVersionFile, recordBackendRelease } from "../backend-version.js";
import { backendCeiling } from "../commands/upgrade.js";

const isNewer = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { numeric: true }) > 0;

let loadHome: string | undefined;
let home: string;

beforeEach(() => {
  loadHome = process.env.IX_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "ix-bv-home-")));
});

afterEach(() => {
  if (loadHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = loadHome;
  rmSync(home, { recursive: true, force: true });
});

describe("the backend-version stamp follows IX_HOME at call time", () => {
  it("writes the stamp under an IX_HOME set after the module was imported", () => {
    process.env.IX_HOME = home;

    expect(backendVersionFile()).toBe(join(home, ".backend-version"));
    expect(recordBackendRelease("1.2.3", "1.2.3", isNewer)).toBe(true);

    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.2.3");
    // ...and not in the home that was current when the module loaded.
    if (loadHome) expect(existsSync(join(loadHome, ".backend-version"))).toBe(false);
  });

  it("is re-resolved on every call", () => {
    process.env.IX_HOME = home;
    const first = backendVersionFile();
    const second = join(home, "second");
    process.env.IX_HOME = second;
    expect(backendVersionFile()).toBe(join(second, ".backend-version"));
    expect(backendVersionFile()).not.toBe(first);
  });

  it("upgrade.ts reads its release cache from the IX_HOME current at call time", () => {
    // The same leak in upgrade.ts: its `.version-check.json` (the ceiling a
    // container's reported version is held to) was bound at import too.
    process.env.IX_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".version-check.json"),
      JSON.stringify({ latest: "1.0.0", backendLatest: "3.4.5", checkedAt: Date.now() }),
    );
    expect(backendCeiling()).toBe("3.4.5");

    process.env.IX_HOME = join(home, "empty");
    expect(backendCeiling()).toBeNull();
  });

  it("falls back to ~/.ix when IX_HOME is unset, as the CLI always has", () => {
    delete process.env.IX_HOME;
    expect(backendVersionFile()).toBe(join(homedir(), ".ix", ".backend-version"));
  });
});
