// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerMapCommand } from "../commands/map.js";
import { canonicalMapRoot, resolveIngestRoot, resolveMapRoot } from "../map-root.js";
import { findWorkspaceForCwd, loadConfig } from "../config.js";
import { lockPathForTest } from "../single-flight.js";

const fixtures: string[] = [];
let savedHome: string | undefined;
let savedProfile: string | undefined;
let home: string;
let savedExitCode: number | string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  home = fixture();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(home, ".ix"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ix-map-root-"));
  fixtures.push(dir);
  return dir;
}

describe("map root resolution", () => {
  it("resolves an unregistered nested cwd to its git root", () => {
    const root = fixture();
    const nested = join(root, "src", "commands");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(root));
  });

  // `ix map` writes. A configured workspace outranking the repository the user
  // is standing in means a bare `ix map` re-ingests a tree nothing on screen
  // names -- and rewrites that workspace's map baseline on the way through.
  it("maps the current repository, not the configured named workspace", () => {
    const selected = fixture();
    const repo = fixture();
    const nested = join(repo, "src");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspace: selected",
      "workspaces:",
      "  - workspace_id: selected-id",
      "    workspace_name: selected",
      `    root_path: ${selected}`,
      "    default: false",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(repo));
  });

  it("maps the current repository, not the default workspace", () => {
    const selected = fixture();
    const repo = fixture();
    const nested = join(repo, "src");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      "  - workspace_id: selected-id",
      "    workspace_name: selected",
      `    root_path: ${selected}`,
      "    default: true",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(repo));
  });

  it("prefers the registered workspace containing cwd over its git root", () => {
    const repo = fixture();
    const registered = join(repo, "packages", "inner");
    const nested = join(registered, "src");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      "  - workspace_id: inner-id",
      "    workspace_name: inner",
      `    root_path: ${registered}`,
      "    default: true",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(registered));
  });

  it("falls back to the default workspace when cwd has no local context", () => {
    const selected = fixture();
    const bare = fixture();
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      "  - workspace_id: selected-id",
      "    workspace_name: selected",
      `    root_path: ${selected}`,
      "    default: true",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, bare)).toBe(realpathSync.native(selected));
  });

  it.skipIf(process.platform === "win32")("canonicalizes a symlink before deriving workspace identity", () => {
    const root = fixture();
    const real = join(root, "real");
    const linked = join(root, "linked");
    mkdirSync(real);
    symlinkSync(real, linked, "dir");

    expect(canonicalMapRoot(linked)).toBe(realpathSync.native(real));
    expect(lockPathForTest(linked)).toBe(lockPathForTest(real));
  });

  it("rejects a missing path before bootstrap can register it", () => {
    const root = fixture();
    const missing = join(root, "missing");

    expect(() => resolveMapRoot(missing, root)).toThrow(`Map path does not exist: ${missing}`);
  });

  it("reports a missing map path as structured json", async () => {
    const root = fixture();
    const missing = join(root, "missing");
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => output.push(args.join(" ")));
    const program = new Command();
    registerMapCommand(program);

    await program.parseAsync(["node", "ix", "map", missing, "--format", "json"]);

    expect(JSON.parse(output.join("\n"))).toEqual({
      error: "invalid_map_path",
      message: `Map path does not exist: ${missing}`,
    });
    expect(process.exitCode).toBe(1);
  });

  it("rejects a file path before bootstrap can register it", () => {
    const root = fixture();
    const file = join(root, "file.ts");
    writeFileSync(file, "export {};\n");

    expect(() => canonicalMapRoot(file)).toThrow(`Map path is not a directory: ${file}`);
  });
});

describe("nested linked worktrees", () => {
  /** A committed repository registered as a workspace, with a linked worktree at `wtPath`. */
  function repoWithWorktree(wtRelative: string): { repo: string; wt: string } {
    const repo = realpathSync.native(fixture());
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const wt = join(repo, wtRelative);
    git("worktree", "add", "-q", "-b", "feature", wt);
    register(repo);
    return { repo, wt: realpathSync.native(wt) };
  }

  function register(...roots: string[]): void {
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      ...roots.flatMap((root, i) => [
        `  - workspace_id: ws-${i}`,
        `    workspace_name: ws-${i}`,
        `    root_path: ${root}`,
        "    default: false",
      ]),
      "",
    ].join("\n"));
  }

  it("treats a worktree inside a registered repo as unmapped, and maps the worktree itself", () => {
    const { wt } = repoWithWorktree(join(".claude", "worktrees", "x"));
    const inside = join(wt, "src");
    mkdirSync(inside, { recursive: true });

    expect(findWorkspaceForCwd(wt)).toBeUndefined();
    expect(findWorkspaceForCwd(inside)).toBeUndefined();
    expect(resolveMapRoot(undefined, wt)).toBe(wt);
    expect(resolveMapRoot(undefined, inside)).toBe(wt);
  });

  it("answers for a registered nested worktree from its own workspace", () => {
    const { repo, wt } = repoWithWorktree(join(".claude", "worktrees", "y"));
    register(repo, wt);
    expect(findWorkspaceForCwd(wt)?.workspace_id).toBe("ws-1");
    expect(findWorkspaceForCwd(repo)?.workspace_id).toBe("ws-0");
  });

  it("keeps a submodule and a nested clone inside the enclosing workspace", () => {
    const { repo } = repoWithWorktree(join(".claude", "worktrees", "z"));
    // A submodule's .git file points into .git/modules/, not .git/worktrees/.
    const sub = join(repo, "vendor", "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/vendor/sub\n");
    // A nested repository with its own .git directory is not a linked worktree.
    const clone = join(repo, "third_party", "lib");
    mkdirSync(join(clone, ".git"), { recursive: true });

    expect(findWorkspaceForCwd(sub)?.workspace_id).toBe("ws-0");
    expect(findWorkspaceForCwd(clone)?.workspace_id).toBe("ws-0");
  });

  it("ingests a file in a nested worktree into the worktree, not the enclosing repo", () => {
    const { wt } = repoWithWorktree(join(".claude", "worktrees", "i"));
    expect(resolveIngestRoot(join(wt, "a.ts"), false)).toBe(wt);
  });

  it("treats a sibling worktree as unmapped while only the main checkout is registered", () => {
    const { wt } = repoWithWorktree(join("..", `sibling-${Date.now()}`));
    fixtures.push(wt);
    expect(findWorkspaceForCwd(wt)).toBeUndefined();
    expect(resolveMapRoot(undefined, wt)).toBe(wt);
  });

  it("keeps a real submodule, in the main checkout and in a registered worktree, in its workspace", () => {
    const upstream = realpathSync.native(fixture());
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], { cwd, stdio: "ignore" });
    git(upstream, "init", "-q", "-b", "main");
    git(upstream, "commit", "-q", "--allow-empty", "-m", "sub");

    const { repo } = repoWithWorktree(join(".claude", "worktrees", "s"));
    git(repo, "submodule", "add", "-q", upstream, join("libs", "sub"));
    git(repo, "commit", "-q", "-m", "submodule");
    // A worktree created after the submodule, so it checks the submodule out
    // too. Its .git file points into .git/worktrees/<wt>/modules/, which is
    // still a submodule and not a worktree boundary.
    const wt = join(repo, ".claude", "worktrees", "t");
    git(repo, "worktree", "add", "-q", "-b", "with-sub", wt);
    git(wt, "submodule", "update", "--init", "-q");
    register(repo, realpathSync.native(wt));

    expect(findWorkspaceForCwd(join(repo, "libs", "sub"))?.workspace_id).toBe("ws-0");
    expect(findWorkspaceForCwd(join(wt, "libs", "sub"))?.workspace_id).toBe("ws-1");
  });

  it("still answers for the main checkout and its subdirectories", () => {
    const { repo } = repoWithWorktree(join(".claude", "worktrees", "w"));
    expect(findWorkspaceForCwd(repo)?.workspace_id).toBe("ws-0");
    mkdirSync(join(repo, "src"), { recursive: true });
    expect(findWorkspaceForCwd(join(repo, "src"))?.workspace_id).toBe("ws-0");
  });
});

describe("ingest root resolution", () => {
  const writeWorkspaces = (...roots: string[]): void => {
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      ...roots.flatMap((root, i) => [
        `  - workspace_id: id-${i}`,
        `    workspace_name: ws-${i}`,
        `    root_path: ${root}`,
        `    default: ${i === 0}`,
      ]),
      "",
    ].join("\n"));
  };

  it("puts a file or subdirectory of a registered workspace in that workspace", () => {
    const repo = realpathSync.native(fixture());
    mkdirSync(join(repo, "src", "util"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
    writeWorkspaces(repo);

    expect(resolveIngestRoot(join(repo, "src", "a.ts"), false)).toBe(repo);
    expect(resolveIngestRoot(join(repo, "src", "util"), true)).toBe(repo);
    expect(resolveIngestRoot(repo, true)).toBe(repo);
  });

  it("prefers the nearest registered workspace over an enclosing one and over the git root", () => {
    const repo = realpathSync.native(fixture());
    const member = join(repo, "member");
    mkdirSync(join(member, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeWorkspaces(repo, member);

    expect(resolveIngestRoot(join(member, "src"), true)).toBe(member);
  });

  it("uses the git root of a path in an unregistered repository", () => {
    const repo = realpathSync.native(fixture());
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });

    expect(resolveIngestRoot(join(repo, "src"), true)).toBe(repo);
    expect(resolveIngestRoot(join(repo, "src", "a.ts"), false)).toBe(repo);
  });

  it("falls back to the directory itself, or a file's directory, outside every workspace and repo", () => {
    const loose = realpathSync.native(fixture());
    mkdirSync(join(loose, "dir"));
    writeFileSync(join(loose, "x.ts"), "export {};\n");
    // A registered default elsewhere does not claim it: the user named a path.
    writeWorkspaces(realpathSync.native(fixture()));

    expect(resolveIngestRoot(join(loose, "dir"), true)).toBe(join(loose, "dir"));
    expect(resolveIngestRoot(join(loose, "x.ts"), false)).toBe(loose);
  });

  it("does not adopt a git repository at $HOME as the workspace of a loose path", () => {
    const realHome = realpathSync.native(home);
    mkdirSync(join(realHome, "notes", "dir"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: realHome });

    expect(resolveIngestRoot(join(realHome, "notes", "dir"), true)).toBe(join(realHome, "notes", "dir"));

    // A workspace the user registered at $HOME on purpose is still used.
    writeWorkspaces(realHome);
    expect(resolveIngestRoot(join(realHome, "notes", "dir"), true)).toBe(realHome);
  });

  it("takes --root first, and refuses a path outside it", () => {
    const repo = realpathSync.native(fixture());
    const other = realpathSync.native(fixture());
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });

    expect(resolveIngestRoot(join(repo, "src"), true, join(repo, "src"))).toBe(join(repo, "src"));
    expect(() => resolveIngestRoot(join(repo, "src"), true, other)).toThrow(/is outside --root/);
  });

  it("does not register anything itself", () => {
    const repo = realpathSync.native(fixture());
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });

    resolveIngestRoot(join(repo, "src"), true);
    expect(loadConfig().workspaces ?? []).toEqual([]);
  });
});
