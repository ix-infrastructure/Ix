import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isPathInside, isReadablePath, readableRoots } from "../config.js";
import { registerReadCommand } from "../commands/read.js";

// `ix read` used to hand back any absolute path that existed on disk: no
// workspace containment, no graph lookup. These cover the boundary itself
// rather than the command, so they hold regardless of which of the four
// resolution steps reaches the filesystem.

let home: string;
let workspace: string;
let outside: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ix-read-home-"));
  workspace = mkdtempSync(join(tmpdir(), "ix-read-ws-"));
  outside = mkdtempSync(join(tmpdir(), "ix-read-outside-"));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  mkdirSync(join(home, ".ix"), { recursive: true });
  writeFileSync(
    join(home, ".ix", "config.yaml"),
    ["endpoint: http://localhost:8090", "format: text", ""].join("\n"),
  );
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "main.ts"), "export const answer = 42;\n");
  writeFileSync(join(outside, "secret.txt"), "SENTINEL\n");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  for (const dir of [home, workspace, outside]) rmSync(dir, { recursive: true, force: true });
});

describe("isPathInside", () => {
  it("accepts the root itself and anything under it", () => {
    expect(isPathInside(workspace, workspace)).toBe(true);
    expect(isPathInside(workspace, join(workspace, "src", "main.ts"))).toBe(true);
  });

  it("rejects a sibling whose path shares a string prefix with the root", () => {
    // The bug a startsWith() containment check would have: `/ws-evil` is not
    // inside `/ws`, but its path does start with it.
    expect(isPathInside("/home/ws", "/home/ws-evil/secret")).toBe(false);
  });

  it("rejects traversal out of the root", () => {
    expect(isPathInside(workspace, join(workspace, "..", "elsewhere"))).toBe(false);
    expect(isPathInside(workspace, outside)).toBe(false);
  });
});

describe("isReadablePath", () => {
  it("allows a file inside the workspace passed as --root", () => {
    expect(isReadablePath(join(workspace, "src", "main.ts"), workspace)).toBe(true);
  });

  it("refuses an absolute path outside every readable root", () => {
    expect(isReadablePath(join(outside, "secret.txt"), workspace)).toBe(false);
  });

  it("refuses a traversal that climbs out of the workspace", () => {
    expect(isReadablePath(join(workspace, "..", "..", "etc", "passwd"), workspace)).toBe(false);
  });

  it("refuses a symlink planted inside the workspace that points outside it", () => {
    const link = join(workspace, "src", "escape.txt");
    symlinkSync(join(outside, "secret.txt"), link);
    // Lexically the link is inside the workspace; only resolving it reveals
    // that reading it hands back a file that is not.
    expect(isPathInside(workspace, link)).toBe(true);
    expect(isReadablePath(link, workspace)).toBe(false);
  });

  it("still allows an ordinary read when the workspace root is itself a symlink", () => {
    // Resolving only the candidate would break this: the real file sits under
    // the link's target, which is not lexically inside the root the caller gave.
    const linkedRoot = join(outside, "linked-root");
    symlinkSync(workspace, linkedRoot);
    expect(isReadablePath(join(linkedRoot, "src", "main.ts"), linkedRoot)).toBe(true);
  });

  it("allows a file in another registered workspace", () => {
    const other = mkdtempSync(join(tmpdir(), "ix-read-other-"));
    try {
      writeFileSync(join(other, "shared.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(home, ".ix", "config.yaml"),
        [
          "endpoint: http://localhost:8090",
          "format: text",
          "workspaces:",
          "  - workspace_id: '1'",
          "    workspace_name: other",
          `    root_path: ${other}`,
          "    default: false",
          "",
        ].join("\n"),
      );

      // Reads legitimately span registered workspaces (a stitched system,
      // ix view --all), and every one of them is a path the user configured.
      expect(readableRoots(workspace).map(r => resolve(r))).toContain(resolve(other));
      expect(isReadablePath(join(other, "shared.ts"), workspace)).toBe(true);
      expect(isReadablePath(join(outside, "secret.txt"), workspace)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// The cases above pin the boundary. These pin that `ix read` is actually behind
// it — delete the guard call sites and everything above still passes, because a
// helper nobody calls is still a correct helper.
describe("ix read enforces the boundary", () => {
  async function runRead(target: string, root: string): Promise<{ out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as never);
    try {
      const program = new Command();
      program.exitOverride();
      registerReadCommand(program);
      await program.parseAsync(["read", target, "--root", root, "--format", "json"], { from: "user" });
      return { out: out.join("\n"), err: err.join("") };
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  }

  it("reads a file inside the workspace", async () => {
    const { out } = await runRead(join(workspace, "src", "main.ts"), workspace);
    expect(out).toContain("export const answer = 42;");
  });

  it("refuses a file outside it, and emits no content", async () => {
    const { out, err } = await runRead(join(outside, "secret.txt"), workspace);
    // The refusal names the boundary; an agent that cannot see it just retries.
    expect(err).toContain("Refusing to read file outside the workspace");
    expect(err).toContain("allowed root:");
    expect(out).not.toContain("SENTINEL");
    expect(out).toBe("");
  });

  it("refuses a symlink inside the workspace that points outside it", async () => {
    const link = join(workspace, "src", "escape.txt");
    symlinkSync(join(outside, "secret.txt"), link);
    const { out, err } = await runRead(link, workspace);
    expect(err).toContain("Refusing to read file outside the workspace");
    expect(out).not.toContain("SENTINEL");
  });
});
