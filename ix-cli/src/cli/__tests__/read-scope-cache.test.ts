// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clearStitchScopeCache, saveConfig } from "../config.js";
import { WorkspaceNotMappedError } from "../errors.js";
import { activeReadScope, ensureReadScope, resetReadScope } from "../resolve.js";

/**
 * `ix mcp` keeps the read scope for its whole session. It used to keep a "no
 * workspace here" answer too, and a stitch answer the next map invalidated, so
 * an `ix map` run from a terminal or an editor hook went unseen: the session
 * kept refusing reads, or kept answering against the pre-map scope, until it
 * was restarted.
 */

let home: string;
let repo: string;
let savedCwd: string;

function register(workspaceId: string): void {
  saveConfig({
    endpoint: "http://localhost:8090",
    format: "text",
    workspaces: [{ workspace_id: workspaceId, workspace_name: "repo", root_path: repo, default: false }],
  } as never);
}

/** A backend that answers the stitch lookup with `systemId` and counts calls. */
function client(systemId: () => string | null) {
  const calls = { n: 0 };
  return {
    calls,
    workspaceSystem: async () => {
      calls.n++;
      return { systemId: systemId() };
    },
  };
}

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ix-scope-cache-")));
  process.env.IX_HOME = path.join(home, ".ix");
  fs.mkdirSync(process.env.IX_HOME, { recursive: true });
  repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  savedCwd = process.cwd();
  process.chdir(repo);
  resetReadScope();
});

afterEach(() => {
  process.chdir(savedCwd);
  delete process.env.IX_HOME;
  resetReadScope();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("read scope cache in a long-lived process", () => {
  it("sees a workspace registered after a failed read, without resetReadScope", async () => {
    const backend = client(() => null);
    await expect(ensureReadScope(backend)).rejects.toBeInstanceOf(WorkspaceNotMappedError);
    expect(activeReadScope()).toEqual(expect.objectContaining({ workspaceId: undefined, systemId: undefined }));

    // What `ix map` in another process does to this one's world.
    register("ws-late");

    await ensureReadScope(backend);
    expect(activeReadScope().workspaceId).toBe("ws-late");
  });

  it("asks again for a stitched system once an external map clears the stitch answer", async () => {
    register("ws-1");
    let system: string | null = null;
    const backend = client(() => system);

    await ensureReadScope(backend);
    expect(activeReadScope()).toEqual(expect.objectContaining({ workspaceId: "ws-1", systemId: undefined }));

    // The map stitches the repo into a system server-side and clears the file.
    system = "sys-1";
    clearStitchScopeCache("ws-1");

    await ensureReadScope(backend);
    expect(activeReadScope()).toEqual(expect.objectContaining({ workspaceId: undefined, systemId: "sys-1" }));
  });

  it("keeps a current scope cached: one backend lookup for repeated reads", async () => {
    register("ws-2");
    const backend = client(() => null);
    await ensureReadScope(backend);
    await ensureReadScope(backend);
    await ensureReadScope(backend);
    expect(backend.calls.n).toBe(1);
    expect(activeReadScope().workspaceId).toBe("ws-2");
  });
});
