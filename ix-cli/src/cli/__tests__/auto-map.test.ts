// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeModule from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autoMapDebounceMs, autoMapInvocation, claimAutoMapWindow, explainAutoMap, runAutoMap,
  DEFAULT_AUTO_MAP_DEBOUNCE_MS, type AutoMapDeps,
} from "../auto-map.js";
import { autoMapStampPath } from "../state-paths.js";
import { saveIngestBaseline } from "../ingest-baseline.js";
import { registerRemoteRunner, type RemoteRunner } from "../remote.js";

let scratch: string;
let repo: string;
let started: string[];
let envBackup: NodeJS.ProcessEnv;

function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
}

/** A run that passes every rule unless a test overrides one. */
function deps(over: AutoMapDeps = {}): AutoMapDeps {
  return {
    env: {},
    now: () => 1_000_000,
    homeDir: () => path.join(scratch, "home"),
    isMapped: () => true,
    remoteSkip: async () => false,
    backendUp: async () => true,
    startMap: (root) => { started.push(root); },
    ...over,
  };
}

beforeEach(() => {
  envBackup = { ...process.env };
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ix-automap-")));
  process.env.IX_HOME = path.join(scratch, ".ix");
  delete process.env.IX_AUTO_MAP_CLOUD;
  fs.mkdirSync(path.join(scratch, "home"));
  repo = path.join(scratch, "repo");
  gitInit(repo);
  started = [];
});

afterEach(() => {
  registerRemoteRunner(null as unknown as RemoteRunner);
  process.env = envBackup;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("runAutoMap: the rules", () => {
  it("starts the map for the git root of a directory inside the repository", async () => {
    const sub = path.join(repo, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const out = await runAutoMap(sub, deps());
    expect(out).toMatchObject({ rule: "started", root: repo });
    expect(started).toEqual([repo]);
  });

  it("skips a directory outside any git repository", async () => {
    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    expect((await runAutoMap(plain, deps())).rule).toBe("not_a_repo");
    expect((await runAutoMap(path.join(scratch, "missing"), deps())).rule).toBe("not_a_repo");
    expect(started).toEqual([]);
  });

  it("skips a git root that is the home directory, or contains it", async () => {
    expect((await runAutoMap(repo, deps({ homeDir: () => repo }))).rule).toBe("home");
    expect((await runAutoMap(repo, deps({ homeDir: () => path.join(repo, "me") }))).rule).toBe("home");
    expect(started).toEqual([]);
  });

  it("skips a repository that was never mapped, judged by its ingest baseline", async () => {
    const real = deps({ isMapped: undefined });
    expect(await runAutoMap(repo, real)).toMatchObject({ rule: "unmapped", root: repo });
    saveIngestBaseline(repo, new Map([[path.join(repo, "a.ts"), 1]]), 1);
    expect((await runAutoMap(repo, real)).rule).toBe("started");
    expect(started).toEqual([repo]);
  });

  it("skips against a remote backend unless IX_AUTO_MAP_CLOUD=1", async () => {
    registerRemoteRunner({ runIngestion: async () => {}, isReady: async () => true });
    const real = deps({ remoteSkip: undefined });
    expect((await runAutoMap(repo, real)).rule).toBe("remote");
    expect(started).toEqual([]);
    process.env.IX_AUTO_MAP_CLOUD = "1";
    expect((await runAutoMap(repo, real)).rule).toBe("started");
  });

  it("skips when the backend is down, and does not ask again within the window", async () => {
    let asked = 0;
    const down = deps({ backendUp: async () => { asked++; return false; } });
    expect((await runAutoMap(repo, down)).rule).toBe("backend_down");
    expect((await runAutoMap(repo, down)).rule).toBe("debounced");
    expect(asked).toBe(1);
    expect(started).toEqual([]);
  });

  it("treats a backend that does not answer as down (real client)", async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    await new Promise<void>((done) => server.close(() => done()));
    process.env.IX_ENDPOINT = `http://127.0.0.1:${port}`;
    expect((await runAutoMap(repo, deps({ backendUp: undefined }))).rule).toBe("backend_down");
  });

  it("starts one map per window, then another once the window has passed", async () => {
    let now = 1_000_000;
    const d = deps({ now: () => now });
    expect((await runAutoMap(repo, d)).rule).toBe("started");
    now += DEFAULT_AUTO_MAP_DEBOUNCE_MS - 1;
    expect((await runAutoMap(repo, d)).rule).toBe("debounced");
    now += 1;
    expect((await runAutoMap(repo, d)).rule).toBe("started");
    expect(started).toEqual([repo, repo]);
  });

  it("keeps one window per root, whatever directory inside it is named", async () => {
    const other = path.join(scratch, "other");
    gitInit(other);
    fs.mkdirSync(path.join(repo, "src"));
    expect((await runAutoMap(repo, deps())).rule).toBe("started");
    expect((await runAutoMap(path.join(repo, "src"), deps())).rule).toBe("debounced");
    expect((await runAutoMap(other, deps())).rule).toBe("started");
    expect(started).toEqual([repo, other]);
  });

  it("honours IX_AUTO_MAP_DEBOUNCE_MS, with 0 turning the window off", async () => {
    const off = deps({ env: { IX_AUTO_MAP_DEBOUNCE_MS: "0" } });
    expect((await runAutoMap(repo, off)).rule).toBe("started");
    expect((await runAutoMap(repo, off)).rule).toBe("started");
    expect(autoMapDebounceMs(undefined)).toBe(DEFAULT_AUTO_MAP_DEBOUNCE_MS);
    expect(autoMapDebounceMs("5000")).toBe(5000);
    expect(autoMapDebounceMs("5s")).toBe(DEFAULT_AUTO_MAP_DEBOUNCE_MS);
    expect(autoMapDebounceMs("")).toBe(DEFAULT_AUTO_MAP_DEBOUNCE_MS);
  });

  it("keeps the debounce stamp under IX_HOME", async () => {
    await runAutoMap(repo, deps());
    const stamp = autoMapStampPath(repo);
    expect(stamp.startsWith(path.join(scratch, ".ix") + path.sep)).toBe(true);
    expect(JSON.parse(fs.readFileSync(stamp, "utf-8"))).toMatchObject({ formatVersion: 1, root: repo, startedAt: 1_000_000 });
  });

  it("answers error, not a throw, when starting the map fails", async () => {
    const out = await runAutoMap(repo, deps({ startMap: () => { throw new Error("spawn failed"); } }));
    expect(out).toMatchObject({ rule: "error", root: repo, detail: "spawn failed" });
  });
});

describe("claimAutoMapWindow", () => {
  it("answers busy while another caller holds the claim lock, and clears a lock left by a dead one", () => {
    const lock = `${autoMapStampPath(repo)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    expect(claimAutoMapWindow(repo, 30_000, Date.now())).toBe("busy");
    expect(fs.existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(claimAutoMapWindow(repo, 30_000, Date.now())).toBe("busy");
    expect(fs.existsSync(lock)).toBe(false);
    expect(claimAutoMapWindow(repo, 30_000, Date.now())).toBe("claimed");
  });

  it("does not let a stamp from a clock that went back hold the window longer than the window", () => {
    expect(claimAutoMapWindow(repo, 30_000, 10_000_000)).toBe("claimed");
    expect(claimAutoMapWindow(repo, 30_000, 10_000_000 - 60_000)).toBe("claimed");
  });

  it("lets exactly one of several processes asking at once claim the window", async () => {
    // Two hosts (say Claude Code and Cursor) open on one repository, each
    // running its post-edit hook for the same edit.
    const TSX = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("tsx")).href;
    const mod = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "auto-map.ts")).href;
    const go = path.join(scratch, "go");
    const script = [
      `const { claimAutoMapWindow } = await import(${JSON.stringify(mod)});`,
      `const fs = await import("node:fs");`,
      `while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));`,
      `process.stdout.write(claimAutoMapWindow(${JSON.stringify(repo)}, 30000, Date.now()));`,
    ].join("\n");
    const runs = Array.from({ length: 6 }, () => new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
        env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      child.stdout.setEncoding("utf-8").on("data", (d: string) => { out += d; });
      child.on("error", fail);
      child.on("close", () => done(out));
    }));
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(go, "");
    const answers = await Promise.all(runs);
    expect(answers.filter((a) => a === "claimed")).toHaveLength(1);
    expect(answers.every((a) => a === "claimed" || a === "debounced" || a === "busy")).toBe(true);
  }, 30_000);
});

describe("how the map starts", () => {
  it("runs `ix map <root> --silent` detached, with IX_AUTO_MAP=1 and no inherited stdio", async () => {
    const inv = await autoMapInvocation(repo, { KEEP: "1" }, "/x/cli/main.js", []);
    expect(inv.command).toBe(process.execPath);
    expect(inv.args).toEqual(["/x/cli/main.js", "map", repo, "--silent"]);
    expect(inv.options).toMatchObject({ cwd: repo, detached: true, stdio: "ignore", shell: false });
    expect(inv.options.env).toMatchObject({ KEEP: "1", IX_AUTO_MAP: "1" });
  });

  it("explains each outcome in one line", () => {
    expect(explainAutoMap({ rule: "started", root: "/r" })).toBe("ix map --auto: started: /r");
    expect(explainAutoMap({ rule: "unmapped", root: "/r", detail: "never mapped" }))
      .toBe("ix map --auto: skipped (unmapped): /r: never mapped");
  });
});

describe("ix map --auto, end to end", () => {
  it("prints nothing on stdout and exits 0 when it skips; --explain names the rule on stderr", async () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const TSX = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("tsx")).href;
    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    const env: NodeJS.ProcessEnv = { ...process.env, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
    for (const key of ["FORCE_COLOR", "IX_FORMAT", "IX_DEBUG", "IX_HOOK_DEBUG"]) delete env[key];
    const run = (args: string[]) => new Promise<{ stdout: string; stderr: string; status: number | null }>((done, fail) => {
      const child = spawn(process.execPath, ["--import", TSX, path.join(SRC, "cli/main.ts"), ...args], {
        cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8").on("data", (d: string) => { stdout += d; });
      child.stderr.setEncoding("utf-8").on("data", (d: string) => { stderr += d; });
      child.on("error", fail);
      child.on("close", (status) => done({ stdout, stderr, status }));
    });
    const quiet = await run(["map", "--auto", plain]);
    expect(quiet).toEqual({ stdout: "", stderr: "", status: 0 });
    const unmapped = await run(["map", repo, "--auto", "--explain"]);
    expect(unmapped.status).toBe(0);
    expect(unmapped.stdout).toBe("");
    expect(unmapped.stderr).toContain(`ix map --auto: skipped (unmapped): ${repo}`);
  }, 60_000);
});
