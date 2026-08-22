import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "ix-stitch-scope-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".ix"), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("stitch scope cache", () => {
  it("round-trips a system id", async () => {
    const c = await import("../config.js");
    c.writeStitchScope("ws-1", "sys-9");
    expect(c.readStitchScope("ws-1")).toEqual({ systemId: "sys-9" });
  });

  /**
   * "Not stitched" is the common answer and the one worth not re-asking: the
   * backend query behind it is an unindexed scan that is SLOWEST when it finds
   * nothing, because there is no match to stop early on.
   */
  it("caches a null answer rather than treating it as a miss", async () => {
    const c = await import("../config.js");
    c.writeStitchScope("ws-2", null);
    expect(c.readStitchScope("ws-2")).toEqual({ systemId: null });
  });

  it("reports a miss for a workspace it has never seen", async () => {
    const c = await import("../config.js");
    expect(c.readStitchScope("never-seen")).toBeUndefined();
  });

  it("treats a corrupt or truncated file as a miss, never as an answer", async () => {
    const c = await import("../config.js");
    writeFileSync(c.stitchScopeCachePath("ws-3"), "{not json");
    expect(c.readStitchScope("ws-3")).toBeUndefined();
  });

  it("rejects a file whose recorded workspace is not the one asked for", async () => {
    // Guards a hash collision or a hand-edited file from answering for the
    // wrong workspace, which would scope every later read to someone else.
    const c = await import("../config.js");
    writeFileSync(c.stitchScopeCachePath("ws-4"), JSON.stringify({ workspaceId: "other", systemId: "sys-x" }));
    expect(c.readStitchScope("ws-4")).toBeUndefined();
  });

  it("rejects a non-string, non-null systemId", async () => {
    const c = await import("../config.js");
    writeFileSync(c.stitchScopeCachePath("ws-5"), JSON.stringify({ workspaceId: "ws-5", systemId: 42 }));
    expect(c.readStitchScope("ws-5")).toBeUndefined();
  });

  it("clears an entry so the next read asks the backend again", async () => {
    const c = await import("../config.js");
    c.writeStitchScope("ws-6", "sys-6");
    expect(existsSync(c.stitchScopeCachePath("ws-6"))).toBe(true);
    c.clearStitchScopeCache("ws-6");
    expect(c.readStitchScope("ws-6")).toBeUndefined();
  });

  it("clearing an entry that was never written is not an error", async () => {
    const c = await import("../config.js");
    expect(() => c.clearStitchScopeCache("ws-7")).not.toThrow();
  });
});

describe("ensureReadScope uses the cache", () => {
  it("does not call the backend when a cached answer exists", async () => {
    const c = await import("../config.js");
    const bootstrap = await import("../bootstrap.js");
    vi.spyOn(bootstrap, "resolveWorkspaceId").mockReturnValue("ws-cached");
    c.writeStitchScope("ws-cached", "sys-cached");

    const { ensureReadScope, activeReadScope, resetReadScope } = await import("../resolve.js");
    resetReadScope();
    const workspaceSystem = vi.fn(async () => ({ systemId: "sys-from-backend" }));

    await ensureReadScope({ workspaceSystem } as never);

    expect(workspaceSystem).not.toHaveBeenCalled();
    expect(activeReadScope().systemId).toBe("sys-cached");
  });

  it("asks the backend on a miss and records the answer for next time", async () => {
    const c = await import("../config.js");
    const bootstrap = await import("../bootstrap.js");
    vi.spyOn(bootstrap, "resolveWorkspaceId").mockReturnValue("ws-fresh");

    const { ensureReadScope, resetReadScope } = await import("../resolve.js");
    resetReadScope();
    const workspaceSystem = vi.fn(async () => ({ systemId: "sys-fresh" }));

    await ensureReadScope({ workspaceSystem } as never);

    expect(workspaceSystem).toHaveBeenCalledOnce();
    expect(c.readStitchScope("ws-fresh")).toEqual({ systemId: "sys-fresh" });
  });
});
