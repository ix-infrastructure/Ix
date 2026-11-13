// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoMapDebounceMs, autoMapProjectDirs, autoMapStampPath, isWorkspaceMapped, parseAutoMapArgs,
  requestAutoMap, type AutoMapDeps,
} from "../hook/auto-map.js";
import { hookSubcommand } from "../hook/subcommands.js";
import { resetConfigMemo, saveConfig } from "../config-store.js";
import { saveIngestBaseline } from "../ingest-baseline.js";

/**
 * `ix hook auto-map`: the guarded, debounced automatic map the agent plugins
 * each kept a copy of (ix-claude-plugin's ix_request_auto_map, the Cursor
 * plugin's requestAutoMap, the Gemini plugin's request_guarded_map). The
 * order is the Claude plugin's: git root (never $HOME), debounce, stamp,
 * mapped check, then one detached `ix map <root> --silent` with IX_AUTO_MAP=1.
 */

let scratch: string;
let repo: string;
let stateDir: string;

function gitInit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  return realpathSync.native(dir);
}

interface SpawnCall { command: string; args: string[]; options: Record<string, unknown> }

function stubs(over: Partial<AutoMapDeps> = {}) {
  const spawned: SpawnCall[] = [];
  const unref = vi.fn();
  const mapped = vi.fn((_root: string) => true);
  const lockHeld = vi.fn((_root: string) => false);
  const rerun = vi.fn((_root: string) => {});
  const deps: AutoMapDeps = {
    env: { IX_HOOK_STATE_DIR: stateDir, HOME: join(scratch, "home") },
    cwd: join(scratch, "elsewhere"),
    now: () => 1_000_000_000_000,
    isMapped: mapped,
    mapLockHeld: lockHeld,
    requestMapRerun: rerun,
    entry: "/opt/ix/dist/cli/main.js",
    execArgv: [],
    spawn: (command, args, options) => {
      spawned.push({ command, args, options: options as Record<string, unknown> });
      return { on: () => {}, unref };
    },
    ...over,
  };
  return { deps, spawned, unref, mapped, lockHeld, rerun };
}

beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-auto-map-")));
  mkdirSync(join(scratch, "home"));
  mkdirSync(join(scratch, "elsewhere"));
  stateDir = join(scratch, "state");
  repo = gitInit(join(scratch, "repo"));
  mkdirSync(join(repo, "src"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("requestAutoMap", () => {
  it("maps a mapped repository: one detached `ix map <root> --silent` with IX_AUTO_MAP=1, from the root", async () => {
    const { deps, spawned, unref, mapped } = stubs();
    const out = await requestAutoMap(JSON.stringify({ cwd: join(repo, "src") }), {}, deps);
    expect(out).toEqual([{ dir: join(repo, "src"), root: repo, outcome: "spawned" }]);
    expect(mapped).toHaveBeenCalledWith(repo);
    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual(["/opt/ix/dist/cli/main.js", "map", repo, "--silent"]);
    expect(call.options).toMatchObject({ cwd: repo, detached: true, stdio: "ignore", windowsHide: true, shell: false });
    expect((call.options.env as NodeJS.ProcessEnv).IX_AUTO_MAP).toBe("1");
    expect(unref).toHaveBeenCalledOnce();
  });

  it("keeps the source loaders when the CLI runs from TypeScript", async () => {
    const { deps, spawned } = stubs({ entry: "/src/cli/main.ts", execArgv: ["--import", "tsx", "--inspect"] });
    await requestAutoMap(JSON.stringify({ cwd: repo }), {}, deps);
    expect(spawned[0].args).toEqual(["--import", "tsx", "/src/cli/main.ts", "map", repo, "--silent"]);
  });

  it("never maps an unmapped repository: it would create a workspace", async () => {
    const { deps, spawned, mapped } = stubs();
    mapped.mockReturnValue(false);
    const out = await requestAutoMap(JSON.stringify({ cwd: repo }), {}, deps);
    expect(out).toEqual([{ dir: repo, root: repo, outcome: "not-mapped" }]);
    expect(spawned).toEqual([]);
    // The stamp stands: an unmapped repository is asked once per window too.
    expect(existsSync(autoMapStampPath(repo, deps.env))).toBe(true);
  });

  it("counts a mapped check that throws as unmapped", async () => {
    const { deps, spawned } = stubs({ isMapped: () => { throw new Error("boom"); } });
    expect((await requestAutoMap(JSON.stringify({ cwd: repo }), {}, deps))[0].outcome).toBe("not-mapped");
    expect(spawned).toEqual([]);
  });

  it("never maps $HOME, even when it is a git repository (a dotfiles repo is not a project)", async () => {
    const home = gitInit(join(scratch, "dotfiles-home"));
    const { deps, spawned, mapped } = stubs();
    deps.env = { ...deps.env, HOME: home };
    const out = await requestAutoMap(JSON.stringify({ cwd: home }), {}, deps);
    expect(out).toEqual([{ dir: home, root: home, outcome: "home" }]);
    expect(mapped).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("never maps a directory outside git", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    const { deps, spawned, mapped } = stubs();
    expect(await requestAutoMap(JSON.stringify({ cwd: plain }), {}, deps)).toEqual([{ dir: plain, outcome: "not-git" }]);
    expect(mapped).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });

  it("debounces per root: stamped before the mapped check, asked again only after the window", async () => {
    let t = 1_000_000_000_000;
    const { deps, spawned, mapped } = stubs({ now: () => t });
    const stamp = autoMapStampPath(repo, deps.env);
    mapped.mockImplementation(() => {
      // The Claude plugin's order: the window is claimed before Ix is asked.
      expect(readFileSync(stamp, "utf-8")).toBe(String(t));
      return true;
    });
    const raw = JSON.stringify({ cwd: repo });

    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("spawned");
    t += 299_000;
    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("debounced");
    expect(mapped).toHaveBeenCalledTimes(1);
    t += 1_000;
    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("spawned");
    expect(spawned).toHaveLength(2);

    // Another root has its own window.
    const other = gitInit(join(scratch, "other"));
    expect((await requestAutoMap(JSON.stringify({ cwd: other }), {}, deps))[0].outcome).toBe("spawned");
  });

  it("debounces an unmapped root too, so Ix is asked at most once per window", async () => {
    let t = 1_000_000_000_000;
    const { deps, mapped } = stubs({ now: () => t });
    mapped.mockReturnValue(false);
    const raw = JSON.stringify({ cwd: repo });
    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("not-mapped");
    t += 60_000;
    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("debounced");
    expect(mapped).toHaveBeenCalledTimes(1);
  });

  it("takes the window from IX_MAP_DEBOUNCE_SECONDS", async () => {
    let t = 1_000_000_000_000;
    const { deps } = stubs({ now: () => t });
    deps.env = { ...deps.env, IX_MAP_DEBOUNCE_SECONDS: "10" };
    const raw = JSON.stringify({ cwd: repo });
    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("spawned");
    t += 9_000;
    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("debounced");
    t += 1_000;
    expect((await requestAutoMap(raw, {}, deps))[0].outcome).toBe("spawned");
  });

  it("leaves the map to a map already running, and asks it for one more pass", async () => {
    const { deps, spawned, lockHeld, rerun } = stubs();
    lockHeld.mockReturnValue(true);
    const out = await requestAutoMap(JSON.stringify({ cwd: repo }), {}, deps);
    expect(out).toEqual([{ dir: repo, root: repo, outcome: "coalesced" }]);
    expect(lockHeld).toHaveBeenCalledWith(repo);
    expect(rerun).toHaveBeenCalledWith(repo);
    expect(spawned).toEqual([]);
  });

  it("does not touch the lock for a repository it will not map", async () => {
    const { deps, lockHeld, rerun, mapped } = stubs();
    mapped.mockReturnValue(false);
    await requestAutoMap(JSON.stringify({ cwd: repo }), {}, deps);
    expect(lockHeld).not.toHaveBeenCalled();
    expect(rerun).not.toHaveBeenCalled();
  });

  it("never throws when the spawn does", async () => {
    const { deps } = stubs({ spawn: () => { throw new Error("EAGAIN"); } });
    expect(await requestAutoMap(JSON.stringify({ cwd: repo }), {}, deps))
      .toEqual([{ dir: repo, root: repo, outcome: "spawn-failed" }]);
  });

  it("still maps when the stamp cannot be written", async () => {
    const blocker = join(scratch, "not-a-dir");
    writeFileSync(blocker, "");
    const { deps, spawned } = stubs();
    deps.env = { ...deps.env, IX_HOOK_STATE_DIR: blocker };
    expect((await requestAutoMap(JSON.stringify({ cwd: repo }), {}, deps))[0].outcome).toBe("spawned");
    expect(spawned).toHaveLength(1);
  });

  it("maps a repository once however many of its directories the host names", async () => {
    const { deps, spawned } = stubs();
    const raw = JSON.stringify({ workspace_roots: [repo, join(repo, "src")] });
    const out = await requestAutoMap(raw, { host: "cursor" }, deps);
    expect(out.map((r) => r.outcome)).toEqual(["spawned"]);
    expect(spawned).toHaveLength(1);
  });
});

describe("the project directory, per host", () => {
  const env = { HOME: "/nowhere" };

  it("reads `cwd` from Claude Code, Gemini CLI and Codex, `workspace_roots` from Cursor", () => {
    for (const host of ["claude", "gemini", "codex"]) {
      expect(autoMapProjectDirs({ host }, JSON.stringify({ cwd: "/ws/a", workspace_roots: ["/ws/b"] }), env, "/proc"))
        .toEqual(["/ws/a"]);
    }
    expect(autoMapProjectDirs({ host: "cursor" }, JSON.stringify({ cwd: "/ws/a", workspace_roots: ["/ws/b", "/ws/c", 7, "rel"] }), env, "/proc"))
      .toEqual(["/ws/b", "/ws/c"]);
  });

  it("defaults to Claude Code's field names", () => {
    expect(autoMapProjectDirs({}, JSON.stringify({ cwd: "/ws/a" }), env, "/proc")).toEqual(["/ws/a"]);
  });

  it("falls back to the host's project variable, then to the hook's cwd", () => {
    expect(autoMapProjectDirs({ host: "claude" }, "", { CLAUDE_PROJECT_DIR: "/ws/env" }, "/proc")).toEqual(["/ws/env"]);
    expect(autoMapProjectDirs({ host: "gemini" }, "{}", { GEMINI_PROJECT_DIR: "/ws/env" }, "/proc")).toEqual(["/ws/env"]);
    expect(autoMapProjectDirs({ host: "cursor" }, "{}", { CURSOR_PROJECT_DIR: "/ws/env" }, "/proc")).toEqual(["/ws/env"]);
    // Another host's variable is not this host's project.
    expect(autoMapProjectDirs({ host: "codex" }, "{}", { CLAUDE_PROJECT_DIR: "/ws/env" }, "/proc")).toEqual(["/proc"]);
    expect(autoMapProjectDirs({ host: "claude" }, "not json", {}, "/proc")).toEqual(["/proc"]);
  });

  it("ignores a relative or non-string payload directory", () => {
    expect(autoMapProjectDirs({ host: "claude" }, JSON.stringify({ cwd: "rel/dir" }), {}, "/proc")).toEqual(["/proc"]);
    expect(autoMapProjectDirs({ host: "claude" }, JSON.stringify({ cwd: 7 }), {}, "/proc")).toEqual(["/proc"]);
  });

  it("takes --root over everything", () => {
    expect(autoMapProjectDirs({ host: "cursor", root: "/ws/root" }, JSON.stringify({ workspace_roots: ["/ws/b"] }), {}, "/proc"))
      .toEqual([resolve("/ws/root")]);
  });

  it("reads an unknown host's payload as `cwd`", () => {
    expect(autoMapProjectDirs({ host: "other" }, JSON.stringify({ cwd: "/ws/a" }), {}, "/proc")).toEqual(["/ws/a"]);
  });
});

describe("settings", () => {
  it("debounces 300 s by default, IX_MAP_DEBOUNCE_SECONDS otherwise", () => {
    expect(autoMapDebounceMs({})).toBe(300_000);
    expect(autoMapDebounceMs({ IX_MAP_DEBOUNCE_SECONDS: "60" })).toBe(60_000);
    expect(autoMapDebounceMs({ IX_MAP_DEBOUNCE_SECONDS: " 0 " })).toBe(0);
    for (const bad of ["", "-1", "5m", "abc", "1e3"]) expect(autoMapDebounceMs({ IX_MAP_DEBOUNCE_SECONDS: bad })).toBe(300_000);
  });

  it("keeps its stamps under <IX_HOME>/hook-state", () => {
    expect(autoMapStampPath("/ws", { IX_HOME: "/h" }).startsWith(join("/h", "hook-state", "auto-map") + sep)).toBe(true);
    expect(autoMapStampPath("/ws", { IX_HOOK_STATE_DIR: "/s" }).startsWith(join("/s", "auto-map"))).toBe(true);
    expect(autoMapStampPath("/a", {})).not.toBe(autoMapStampPath("/b", {}));
  });

  it("parses --host and --root, and ignores anything else", () => {
    expect(parseAutoMapArgs(["--host", "cursor", "--root=/ws", "--bogus", "x"])).toEqual({ host: "cursor", root: "/ws" });
    expect(parseAutoMapArgs(["--host=gemini"])).toEqual({ host: "gemini" });
    expect(parseAutoMapArgs([])).toEqual({});
  });

  it("is an `ix hook` subcommand", () => {
    expect(hookSubcommand("auto-map")).toBeTypeOf("function");
  });
});

describe("isWorkspaceMapped (in process, no `ix status` child)", () => {
  const saved = process.env.IX_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.IX_HOME; else process.env.IX_HOME = saved;
    resetConfigMemo();
  });

  it("is true only for a registered workspace whose last graph ingest completed", async () => {
    process.env.IX_HOME = join(scratch, "ixhome");
    resetConfigMemo();
    expect(await isWorkspaceMapped(repo)).toBe(false);

    saveConfig({ endpoint: "http://127.0.0.1:1", format: "text", workspaces: [
      { workspace_id: "w1", workspace_name: "repo", root_path: repo, default: true },
    ] });
    resetConfigMemo();
    // Registered, never ingested: `ix status` says graphCompleted false.
    expect(await isWorkspaceMapped(repo)).toBe(false);

    saveIngestBaseline(repo, new Map([[join(repo, "a.ts"), 1]]), 1);
    expect(await isWorkspaceMapped(repo)).toBe(true);

    // A baseline with no registered workspace is not one to map automatically.
    saveConfig({ endpoint: "http://127.0.0.1:1", format: "text", workspaces: [] });
    resetConfigMemo();
    expect(await isWorkspaceMapped(repo)).toBe(false);
  });
});

describe("`ix hook auto-map` as a process", () => {
  const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "../main.ts");
  const TSX = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("tsx")).href;

  it("exits 0, prints nothing, and stamps an unmapped repository without mapping it", () => {
    const home = join(scratch, "ixhome");
    const env: NodeJS.ProcessEnv = { ...process.env, IX_HOME: home, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1", IX_ENDPOINT: "http://127.0.0.1:1" };
    for (const k of ["FORCE_COLOR", "IX_FORMAT", "IX_HOOK_STATE_DIR", "IX_HOOK_DEBUG", "IX_HOOK_LOG", "IX_MAP_DEBOUNCE_SECONDS"]) delete env[k];
    for (const [args, input] of [
      [["hook", "auto-map"], JSON.stringify({ cwd: repo })],
      [["hook", "auto-map", "--host", "cursor"], JSON.stringify({ workspace_roots: [repo] })],
      [["hook", "auto-map", "--host", "bogus"], "not json"],
    ] as const) {
      const r = spawnSync(process.execPath, ["--import", TSX, MAIN, ...args], { input, env, cwd: scratch, encoding: "utf-8", timeout: 60_000 });
      expect({ args, status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ args, status: 0, stdout: "", stderr: "" });
    }
    expect(readdirSync(join(home, "hook-state", "auto-map"))).toHaveLength(1);
    // Never mapped: no workspace was created.
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
  }, 120_000);
});
