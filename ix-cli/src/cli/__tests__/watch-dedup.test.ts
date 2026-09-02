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
      const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", cacheRoot], {
        cwd: packageRoot,
        encoding: "utf8",
      });
      expect(ignored.status, `git does not ignore ${cacheRoot}`).toBe(0);
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
    const tempRoot = fs.mkdtempSync(path.join(cacheRoot, "ix-watch-child-runtime-"));
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
      const build = spawnSync(
        process.execPath,
        [
          path.join(packageRoot, "node_modules/typescript/bin/tsc"),
          "-p",
          path.join(packageRoot, "tsconfig.build.json"),
          "--outDir",
          outDir,
          "--declaration",
          "false",
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
