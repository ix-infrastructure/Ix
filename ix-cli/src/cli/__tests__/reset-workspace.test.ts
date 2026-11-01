// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";

const calls = vi.hoisted(() => ({ deleteWorkspace: [] as string[], reset: 0, resetCode: 0 }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async deleteWorkspace(id: string) { calls.deleteWorkspace.push(id); }
    async reset() { calls.reset++; return { ok: true, message: "" }; }
    async resetCode() { calls.resetCode++; return { ok: true, message: "" }; }
  },
}));

import { registerResetCommand } from "../commands/reset.js";
import { ingestMtimeCachePath, saveConfig } from "../config.js";

/**
 * `ix reset --workspace`: the repair a degraded graph points at. It must touch
 * exactly one workspace -- the registered one the caller stands in -- because
 * `ix reset` without it wipes every workspace on a shared backend.
 */

let home: string;
let mine: string;
let theirs: string;
let savedCwd: string;
let out: string[];
let err: string[];

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.name("ix").exitOverride();
  registerResetCommand(program);
  await program.parseAsync(["reset", ...args], { from: "user" });
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ix-reset-ws-")));
  process.env.IX_HOME = path.join(home, ".ix");
  mine = path.join(home, "mine");
  theirs = path.join(home, "theirs");
  fs.mkdirSync(mine, { recursive: true });
  fs.mkdirSync(theirs, { recursive: true });
  saveConfig({
    endpoint: "http://localhost:8090",
    format: "text",
    workspaces: [
      { workspace_id: "aaaa0001", workspace_name: "theirs", root_path: theirs, default: true },
      { workspace_id: "bbbb0002", workspace_name: "mine", root_path: mine, default: false },
    ],
  });
  calls.deleteWorkspace.length = 0;
  calls.reset = 0;
  calls.resetCode = 0;
  savedCwd = process.cwd();
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(savedCwd);
  process.exitCode = undefined;
  delete process.env.IX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ix reset --workspace", () => {
  it("deletes only the workspace containing cwd, and forgets its ingest state", async () => {
    const cache = ingestMtimeCachePath(mine);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, "{}");
    process.chdir(path.join(mine));

    await run(["--workspace", "--yes"]);

    expect(calls.deleteWorkspace).toEqual(["bbbb0002"]);
    expect(calls.reset + calls.resetCode).toBe(0);
    // Left in place, the rebuild would skip every file as unchanged.
    expect(fs.existsSync(cache)).toBe(false);
    expect(out.join("\n")).toContain("Workspace 'mine' (id bbbb0002) wiped. Other workspace ids untouched.");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a directory no workspace covers, rather than resetting the default one", async () => {
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    process.chdir(elsewhere);

    await run(["--workspace", "--yes"]);

    expect(calls.deleteWorkspace).toEqual([]);
    expect(err.join("\n")).toContain("is not inside a registered workspace; nothing to reset.");
    expect(process.exitCode).toBe(1);
  });

  it("refuses --code alongside it", async () => {
    process.chdir(mine);
    await run(["--workspace", "--code", "--yes"]);
    expect(calls.deleteWorkspace).toEqual([]);
    expect(calls.resetCode).toBe(0);
    expect(process.exitCode).toBe(1);
  });
});
