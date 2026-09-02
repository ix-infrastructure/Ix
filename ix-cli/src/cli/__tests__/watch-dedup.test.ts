import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  WatchRefreshScheduler,
  canonicalMapInvocation,
  childCliArgs,
  mapRetryDelay,
  prepareMigratedWorkspaceRefresh,
  runCanonicalMap,
  shouldWatch,
  updatePollingSnapshot,
} from "../commands/watch.js";

describe("WatchRefreshScheduler", () => {
  it("serializes refreshes and coalesces requests made while one is running", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    const refresh = vi.fn(async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (runs === 1) await first;
      active--;
    });
    const errors: unknown[] = [];
    const scheduler = new WatchRefreshScheduler(refresh, (err) => errors.push(err));

    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(refresh).toHaveBeenCalledTimes(1);

    releaseFirst();
    await scheduler.waitForIdle();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(errors).toEqual([]);
  });

  it("reports a failed refresh and remains usable", async () => {
    const failure = new Error("backend rejected patch");
    const refresh = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const scheduler = new WatchRefreshScheduler(refresh, onError);

    scheduler.request();
    await scheduler.waitForIdle();
    scheduler.request();
    await scheduler.waitForIdle();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

/**
 * Where the child-CLI test builds its throwaway `dist`.
 *
 * Two constraints pull in opposite directions and only this location satisfies
 * both -- see the long note at the call site.
 *   1. It must have the package's dependencies on its ESM resolution path, so
 *      it has to sit under `packageRoot`.
 *   2. Git must not be able to see it, because cleanup is a `finally` that a
 *      killed runner never reaches (Ix#567).
 */
function childBuildCacheRoot(packageRoot: string): string {
  return path.join(packageRoot, "node_modules", ".cache");
}

/**
 * mkdtemp prefix for the throwaway child build.
 *
 * The pid is in the name so the sweep below can tell a directory abandoned by
 * a dead run from one a LIVE run is building into right now. Two runners in
 * one checkout is ordinary -- vitest in watch mode in one terminal, `npm test`
 * in another -- and a sweep that deleted the other's tree between its emit and
 * its child spawn would manufacture exactly the intermittent single-test
 * failure this file exists to stop producing.
 */
const CHILD_BUILD_PREFIX = "ix-watch-child-runtime-";

/** Owner pid encoded in a sweep candidate, or null if it is not one of ours. */
function childBuildOwnerPid(entry: string): number | null {
  if (!entry.startsWith(CHILD_BUILD_PREFIX)) return null;
  const pid = Number.parseInt(entry.slice(CHILD_BUILD_PREFIX.length), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Is a process still running? signal 0 is an existence check, not a signal. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user -- alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

describe("canonical watch refresh", () => {
  it("builds the child CLI somewhere git cannot see, so an interrupted run leaves nothing behind", () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const cacheRoot = childBuildCacheRoot(packageRoot);

    // Assert the property that matters -- "git ignores it" -- by asking git,
    // not by matching .gitignore text. Outside a work tree (an installed
    // tarball, a downloaded source archive) there is no git answer to get, so
    // fall back to the structural half of the same claim: the build lives
    // inside node_modules, which every checkout of this repo ignores.
    const inWorkTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    if (inWorkTree.status === 0 && inWorkTree.stdout.trim() === "true") {
      const checkIgnore = (target: string): number | null =>
        spawnSync("git", ["check-ignore", "--quiet", "--no-index", target], {
          cwd: packageRoot,
          encoding: "utf8",
        }).status;

      expect(checkIgnore(cacheRoot), `git does not ignore ${cacheRoot}`).toBe(0);

      // And pin the rule that ignores it, not just today's outcome. `cacheRoot`
      // is a real directory, so the old `node_modules/` rule matched it too and
      // this test would stay green if that rule came back -- taking the
      // committable `ix-cli/node_modules` symlink of #545 with it. A path that
      // does not exist is not a directory as far as git is concerned, so only a
      // rule without the trailing slash matches it.
      const nonDirectory = path.join(packageRoot, "__ix_ignore_probe__", "node_modules");
      expect(fs.existsSync(nonDirectory), "probe path must not exist").toBe(false);
      expect(
        checkIgnore(nonDirectory),
        "the node_modules ignore rule is directory-only again; a symlink or file named node_modules is committable (Ix#545)",
      ).toBe(0);
    } else {
      expect(path.relative(packageRoot, cacheRoot).split(path.sep)[0]).toBe("node_modules");
    }
  });

  it("keeps TypeScript runtime loaders without copying debugger flags", () => {
    expect(
      childCliArgs(
        "/workspace/src/cli/main.ts",
        ["--version"],
        [
          "--inspect=0",
          "--require",
          "/workspace/node_modules/tsx/dist/preflight.cjs",
          "--import=file:///workspace/node_modules/tsx/dist/loader.mjs",
          "--trace-warnings",
        ],
      ),
    ).toEqual([
      "--require",
      "/workspace/node_modules/tsx/dist/preflight.cjs",
      "--import=file:///workspace/node_modules/tsx/dist/loader.mjs",
      "/workspace/src/cli/main.ts",
      "--version",
    ]);
  });

  it("drops parent runtime flags for a built JavaScript entry", () => {
    expect(
      childCliArgs(
        "/workspace/dist/cli/main.js",
        ["--help"],
        ["--inspect=0", "--require", "preflight.cjs", "--import", "loader.mjs"],
      ),
    ).toEqual(["/workspace/dist/cli/main.js", "--help"]);
  });

  it("starts both the tsx source CLI and a normal built CLI child", () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    // Read, never hardcode. The literal that used to sit here made every
    // `chore(release)` bump fail this test, which is about whether the child
    // STARTS -- the number it prints is incidental. The same value seeds
    // .version-check.json so the update notice cannot appear on stdout and be
    // mistaken for the version.
    const version = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ).version as string;
    // Build into node_modules/.cache, not the package root and not os.tmpdir().
    //
    // Cleanup is the `finally` below, which does not run when the runner is
    // killed (Ctrl-C, CI timeout). Directly under packageRoot that left a
    // complete `dist` build as an *untracked directory in the working tree*,
    // which `git status` showed and an unlucky `git add -A` would have
    // committed (Ix#567).
    //
    // os.tmpdir() is not the answer, even though packageRoot is passed as `cwd`
    // to every spawnSync: `cwd` has no bearing on ESM bare-specifier
    // resolution, which walks up from the *module's own* path. A build under
    // the OS tmpdir dies with
    //   ERR_MODULE_NOT_FOUND: Cannot find package 'commander'
    // because no node_modules exists above it. The built child has to sit
    // somewhere with the package's dependencies on its resolution path.
    //
    // node_modules/.cache is both: node walks ..../.cache/<tmp>/dist/cli up to
    // packageRoot and finds packageRoot/node_modules, and git never sees it --
    // node_modules is ignored, so an interrupted run leaves nothing in
    // `git status` and nothing that can be committed by accident.
    const cacheRoot = childBuildCacheRoot(packageRoot);
    fs.mkdirSync(cacheRoot, { recursive: true });
    // Sweep what a killed run left behind. Moving out of the package root cost
    // the one signal that debris exists -- `git status` no longer shows it, and
    // nothing under node_modules is pruned until the next `npm ci`. Worth
    // bounding: release.yml copies ix-cli/node_modules wholesale into the
    // release tarball, so anything sitting here at packaging time would ship.
    //
    // Only directories whose owning process is gone. `force` swallows ENOENT
    // but not the EPERM Windows raises on a tree another process has open, and
    // a live run robbed of its build mid-test is the failure mode this whole
    // file is about -- so a concurrent runner's tree is left strictly alone.
    for (const stale of fs.readdirSync(cacheRoot)) {
      const owner = childBuildOwnerPid(stale);
      if (owner === null || owner === process.pid || pidAlive(owner)) continue;
      try {
        fs.rmSync(path.join(cacheRoot, stale), { recursive: true, force: true });
      } catch {
        // Someone else got there first, or the OS still has it open. Leaving
        // one stale build behind is not worth failing a passing test over.
      }
    }
    const tempRoot = fs.mkdtempSync(path.join(cacheRoot, `${CHILD_BUILD_PREFIX}${process.pid}-`));
    const ixHome = path.join(tempRoot, "ix-home");
    fs.mkdirSync(ixHome);
    fs.writeFileSync(
      path.join(ixHome, ".version-check.json"),
      JSON.stringify({ latest: version, checkedAt: Date.now() }),
    );
    const env = { ...process.env, IX_HOME: ixHome, NO_COLOR: "1" };

    try {
      const sourceEntry = path.join(packageRoot, "src/cli/main.ts");
      const source = spawnSync(
        process.execPath,
        childCliArgs(sourceEntry, ["--version"], ["--inspect=0", "--import", "tsx"]),
        { cwd: packageRoot, env, encoding: "utf8" },
      );
      expect(source.status, source.stderr).toBe(0);
      expect(source.stdout.trim()).toBe(version);
      expect(source.stderr).not.toContain("Debugger listening");

      const outDir = path.join(tempRoot, "dist");
      // Compile the CLI entry's own module graph, not `src`.
      //
      // This test asks whether the built child STARTS, so a file the child
      // never loads is not its business -- but `tsconfig.build.json` inherits
      // `"include": ["src"]`, which compiles every .ts file in the working
      // tree, *including untracked ones*. `git stash` without `-u` leaves
      // untracked files behind, so a WIP module still sitting in `src` failed
      // this one test out of 1500+ (nothing else shells out to tsc -- vitest
      // transforms with esbuild, which does not type-check) in the worktree it
      // was left in, while a fresh worktree at the same commit passed. That is
      // the exact shape reported in Ix#567.
      //
      // `files` + `include: []` narrows the program to main.ts and whatever it
      // imports, which is precisely what the child needs to run. `--noCheck`
      // (TypeScript >= 5.6) covers the remaining case of a semantic error in a
      // file that IS in that graph, e.g. mid-edit. Syntax errors still fail the
      // emit, correctly -- those genuinely break the child. The package as a
      // whole is still type-checked by `npm run build`, `npm run typecheck` and
      // CI; none of that is this test's job.
      const buildConfig = path.join(tempRoot, "tsconfig.child.json");
      fs.writeFileSync(
        buildConfig,
        JSON.stringify({
          extends: path.join(packageRoot, "tsconfig.build.json"),
          include: [],
          files: [path.join(packageRoot, "src/cli/main.ts")],
        }),
      );
      const build = spawnSync(
        process.execPath,
        [
          path.join(packageRoot, "node_modules/typescript/bin/tsc"),
          "-p",
          buildConfig,
          "--outDir",
          outDir,
          "--declaration",
          "false",
          "--noCheck",
        ],
        { cwd: packageRoot, env, encoding: "utf8" },
      );
      expect(build.status, build.stderr || build.stdout).toBe(0);

      const builtEntry = path.join(outDir, "cli/main.js");
      const built = spawnSync(
        process.execPath,
        childCliArgs(builtEntry, ["--help"], ["--inspect=0", "--import", "tsx"]),
        { cwd: packageRoot, env, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      expect(built.stdout).toContain("ix — System Intelligence CLI");
      expect(built.stderr).not.toContain("Debugger listening");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("delegates the workspace root to the existing map command with full ingest enabled", () => {
    const root = "/workspace/project";
    const entry = "/workspace/dist/cli/main.js";
    const map = canonicalMapInvocation(root, entry, ["--inspect=0"]);

    expect(map.command).toBe(process.execPath);
    expect(map.args).toEqual([entry, "map", root, "--silent"]);
    expect(map.env.IX_AUTO_MAP).toBe("1");
    expect(map.env.IX_MAP_FULL_INGEST).toBe("1");
    expect(map.env.IX_MAP_COALESCE_EXIT_CODE).toBe("75");
  });

  it("retries a map coalesced by another process so the change is not lost", async () => {
    const exits = [75, 0];
    const launch = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exits.shift(), null));
      return child as any;
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await runCanonicalMap("/workspace/project", launch, wait);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("propagates a canonical map failure without spinning", async () => {
    const launch = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 2, null));
      return child as any;
    });

    await expect(runCanonicalMap("/workspace/project", launch)).rejects.toThrow(
      "ix map failed (exit 2)",
    );
    expect(launch).toHaveBeenCalledOnce();
  });

  it("gives up on a lock that is never released instead of retrying forever", async () => {
    // A holder that never exits 0 — a crashed process whose lockfile outlived
    // it. Unbounded, this spawned a Node process every second indefinitely.
    const launch = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 75, null));
      return child as any;
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(runCanonicalMap("/workspace/project", launch, wait, () => {})).rejects.toThrow(
      /stayed coalesced across \d+ attempts/,
    );
    expect(launch.mock.calls.length).toBeLessThanOrEqual(45);
    expect(wait).toHaveBeenCalledTimes(launch.mock.calls.length);
  });

  it("tells the user why it is waiting, since the child map runs --silent", async () => {
    const exits = [75, 75, 75, 0];
    const launch = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exits.shift(), null));
      return child as any;
    });
    const notify = vi.fn();

    await runCanonicalMap("/workspace/project", launch, vi.fn().mockResolvedValue(undefined), notify);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatch(/another ix map holds this workspace/);
  });

  it("backs off exponentially up to a ceiling", () => {
    expect([1, 2, 3, 4, 5, 6].map(mapRetryDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    // Capped, so a long wait costs attempts rather than unbounded sleep growth.
    expect(mapRetryDelay(45)).toBe(30000);
    // 45 attempts spans past single-flight's 20-minute stale-lock window.
    const total = Array.from({ length: 45 }, (_, i) => mapRetryDelay(i + 1)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(20 * 60 * 1000);
  });

  it("keeps delete events eligible without requiring the file to exist", () => {
    expect(shouldWatch("/workspace/project", "/workspace/project/deleted.ts")).toBe(true);
  });

  it("clears the parent's baseline before migration refresh crosses into a child process", () => {
    const clear = vi.fn();
    const root = "/workspace/migrated";

    prepareMigratedWorkspaceRefresh(root, clear);

    expect(clear).toHaveBeenCalledWith(root);
    expect(canonicalMapInvocation(root, "/workspace/dist/cli/main.js").args).toEqual([
      "/workspace/dist/cli/main.js",
      "map",
      root,
      "--silent",
    ]);
  });
});

describe("updatePollingSnapshot", () => {
  it("detects new, modified, and deleted files", () => {
    const mtimes = new Map([
      ["kept.ts", 1],
      ["changed.ts", 1],
      ["deleted.ts", 1],
    ]);
    const current = ["kept.ts", "changed.ts", "new.ts"];
    const values = new Map([
      ["kept.ts", 1],
      ["changed.ts", 2],
      ["new.ts", 3],
    ]);

    const changed = updatePollingSnapshot(current, mtimes, (filePath) => values.get(filePath)!);

    expect(changed).toEqual(["changed.ts", "new.ts", "deleted.ts"]);
    expect(mtimes).toEqual(values);
  });

  it("detects a backwards mtime change instead of requiring mtime to increase", () => {
    const mtimes = new Map([["restored.ts", 10]]);

    expect(updatePollingSnapshot(["restored.ts"], mtimes, () => 5)).toEqual(["restored.ts"]);
  });
});
