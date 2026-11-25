// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * A first map (Path B) of more than one batch: each file is read and parsed
 * once when the repository is under IX_PARSE_ONCE_MAX_FILES, and batch N+1 is
 * resolved and built while batch N's commit is in flight. Neither may change
 * what reaches the backend: the same commit requests, with the same bodies, in
 * the same order, and the same summary.
 */

// Two parse workers, as in the other ingest suites.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

/** What the run did, seen from inside: parses per file and resolve calls. */
const probe = {
  parses: new Map<string, number>(),
  resolveCalls: 0,
  /** Throw from this resolve call (1-based), if set. */
  throwOnResolve: undefined as number | undefined,
  /** Fired at each resolve call, with its number. */
  onResolve: undefined as ((n: number) => void) | undefined,
};

vi.mock("../commands/parse-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/parse-pool.js")>();
  const parse = actual.ParsePool.prototype.parse;
  actual.ParsePool.prototype.parse = function (this: unknown, filePath: string, ...rest: unknown[]) {
    probe.parses.set(filePath, (probe.parses.get(filePath) ?? 0) + 1);
    return (parse as (...a: unknown[]) => ReturnType<typeof parse>).call(this, filePath, ...rest);
  } as typeof parse;
  return actual;
});

vi.mock("../commands/ingestion-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/ingestion-loader.js")>();
  return {
    ...actual,
    loadIngestionModules: async () => {
      const [ingestion, patchBuilder, languages] = await actual.loadIngestionModules();
      return [{
        ...ingestion,
        resolveEdges: (...args: unknown[]) => {
          const n = ++probe.resolveCalls;
          probe.onResolve?.(n);
          if (probe.throwOnResolve === n) throw new Error(`resolve ${n} failed (test)`);
          return (ingestion.resolveEdges as (...a: unknown[]) => unknown)(...args);
        },
      }, patchBuilder, languages] as Awaited<ReturnType<typeof actual.loadIngestionModules>>;
    },
  };
});

const ENV_KEYS = [
  "HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG",
  "IX_COMMIT_FAILURE_LIMIT", "IX_COMMIT_HTTP_MAX_FILES", "IX_COMMIT_CONCURRENCY",
  "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS", "IX_MAP_DEADLINE_MS",
  "IX_PARSE_STREAM_CHUNK", "IX_PARSE_ONCE_MAX_FILES",
] as const;

const CHUNK = 10;
const BATCHES = 6;

/**
 * 60 files (six batches of ten), with names that resolve across
 * batches and two `util` modules defining the same function, so the order the
 * index meets the files in is visible in the edges. Plus an empty file and a
 * minified one, which the parse does not take but the index still reads.
 */
function writeFixture(repo: string): string[] {
  const files = new Map<string, string>();
  for (const dir of ["a", "b"]) {
    files.set(`${dir}/util.ts`, `export function helper(x: number): number { return x + 1; }\nexport class Box { open(): number { return helper(1); } }\n`);
  }
  for (let i = 0; i < 52; i++) {
    const dir = i % 2 === 0 ? "a" : "b";
    const next = (i + 7) % 52;
    files.set(`${dir}/mod${i}.ts`,
      `import { helper, Box } from "./util";\n` +
      `import { run${next} } from "../${next % 2 === 0 ? "a" : "b"}/mod${next}";\n` +
      `export function run${i}(n: number): number { return helper(n) + new Box().open() + (n > 0 ? run${next}(n - 1) : 0); }\n`);
  }
  for (let i = 0; i < 4; i++) {
    files.set(`py/m${i}.py`, `from py.m${(i + 1) % 4} import step${(i + 1) % 4}\n\ndef helper(x):\n    return x\n\ndef step${i}(x):\n    return helper(step${(i + 1) % 4}(x))\n`);
  }
  files.set("a/empty.ts", "");
  files.set("vendor/min.js", "function helper(x){return x}" + "var q=1;".repeat(27_000));
  for (const [p, text] of files) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text, "utf8");
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  return [...files.keys()];
}

/** The summary with every timing taken out: wall-clock differs run to run. */
function stable(summary: unknown): unknown {
  return JSON.parse(JSON.stringify(summary, (k, v) => (/ms$|timings?$|elapsed|duration|seconds/i.test(k) ? undefined : v)));
}

/** Commit bodies with each patch's wall-clock `timestamp` taken out; nothing else. */
function bodies(backend: FakeBackend): Array<{ path: string; body: unknown }> {
  return backend.commitBodies.map(({ path, body }) => ({
    path,
    body: JSON.parse(body, (k, v) => (k === "timestamp" ? undefined : v)),
  }));
}

describe("fresh map: parse once, prepare during the commit", () => {
  let root = "";
  let repo = "";
  const saved: Record<string, string | undefined> = {};
  const backends: FakeBackend[] = [];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-fresh-pipe-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.IX_PARSE_STREAM_CHUNK = String(CHUNK);
    probe.parses.clear();
    probe.resolveCalls = 0;
    probe.throwOnResolve = undefined;
    probe.onResolve = undefined;
  });

  afterEach(async () => {
    for (const b of backends.splice(0)) await b.stop();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** A fresh map of `repo` into a new, empty backend with its own home. */
  async function freshMap(
    name: string,
    setup: (backend: FakeBackend) => void = () => {},
    opts: { force?: boolean; home?: string; backend?: FakeBackend } = {},
  ) {
    const backend = opts.backend ?? new FakeBackend({ semantics: "head" });
    if (!opts.backend) backends.push(backend);
    setup(backend);
    const endpoint = opts.backend ? process.env.IX_ENDPOINT! : await backend.start();
    const home = opts.home ?? join(root, `home-${name}`);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    probe.parses.clear();
    probe.resolveCalls = 0;
    const summary = await ingestFiles(repo, {
      recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true,
      ...(opts.force ? { force: true } : {}),
    });
    return { backend, summary, parses: new Map(probe.parses), home };
  }

  it("parses each file once and sends what the two-pass run sends", async () => {
    const written = writeFixture(repo);
    const once = await freshMap("once");
    process.env.IX_PARSE_ONCE_MAX_FILES = "0";
    const twice = await freshMap("twice");

    const code = written.filter(p => p !== "a/empty.ts" && p !== "vendor/min.js");
    // Parse-once: every parsed file once. The minified file is parsed for its
    // summary only, as the pre-pass parsed it; the empty file is never parsed.
    for (const p of code) expect(once.parses.get(p), p).toBe(1);
    expect(once.parses.get("vendor/min.js")).toBe(1);
    expect(once.parses.has("a/empty.ts")).toBe(false);
    // The two-pass path still parses every code file twice.
    for (const p of code) expect(twice.parses.get(p), p).toBe(2);

    expect(once.backend.commitBodies.length).toBeGreaterThanOrEqual(BATCHES);
    expect(bodies(once.backend)).toEqual(bodies(twice.backend));
    expect(once.backend.requests).toEqual(twice.backend.requests);
    expect(once.backend.graphSignature()).toEqual(twice.backend.graphSignature());
    expect(stable(once.summary)).toEqual(stable(twice.summary));
  }, 120_000);

  it("keeps the two passes above IX_PARSE_ONCE_MAX_FILES", async () => {
    const written = writeFixture(repo);
    process.env.IX_PARSE_ONCE_MAX_FILES = "20";
    const run = await freshMap("above");
    for (const p of written.filter(p => p.endsWith(".ts") && p !== "a/empty.ts")) expect(run.parses.get(p), p).toBe(2);
  }, 120_000);

  it("parses a single batch once, as before", async () => {
    writeFixture(repo);
    process.env.IX_PARSE_STREAM_CHUNK = "500";
    const run = await freshMap("single");
    expect(run.parses.get("a/mod0.ts")).toBe(1);
  }, 120_000);

  it("prepares batch N+1 while commit N is open, and sends commit N+1 only after it", async () => {
    writeFixture(repo);
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    probe.onResolve = (n) => {
      events.push(`resolve ${n}`);
      if (n === 2) release();
    };
    const run = await freshMap("overlap", (backend) => {
      backend.commitGate = (n) => {
        events.push(`commit ${n} arrives`);
        if (n !== 1) return undefined;
        // Held until batch 2 has been resolved; a run that waits for this
        // commit before resolving batch 2 is released by the timeout instead.
        return Promise.race([held, new Promise<void>(r => setTimeout(r, 5_000))]).then(() => { events.push("commit 1 answered"); });
      };
    });
    expect(run.summary.parseErrors).toBe(0);
    const at = (e: string) => events.indexOf(e);
    expect(at("resolve 2")).toBeGreaterThan(-1);
    expect(at("resolve 2")).toBeLessThan(at("commit 1 answered"));
    expect(at("commit 2 arrives")).toBeGreaterThan(at("commit 1 answered"));
    // At most one prepared batch waits behind the open commit.
    expect(at("resolve 3")).toBeGreaterThan(at("commit 1 answered"));
  }, 120_000);

  it("prepares nothing ahead when the backend holds hashes (a forced re-map)", async () => {
    writeFixture(repo);
    const first = await freshMap("force", (backend) => { backend.rememberHashes = true; });
    const events: string[] = [];
    probe.onResolve = (n) => { events.push(`resolve ${n}`); };
    first.backend.resetRequests();
    first.backend.commitBodies.splice(0);
    first.backend.commitGate = (n) => {
      events.push(`commit ${n} arrives`);
      if (n !== 1) return undefined;
      return new Promise<void>(r => setTimeout(r, 300)).then(() => { events.push("commit 1 answered"); });
    };
    await freshMap("force", () => {}, { force: true, home: first.home, backend: first.backend });
    expect(events.indexOf("resolve 2")).toBeGreaterThan(events.indexOf("commit 1 answered"));
  }, 120_000);

  it("sends no commit for later batches when preparing one throws, after the commit in flight lands", async () => {
    writeFixture(repo);
    probe.throwOnResolve = 3;
    let backend!: FakeBackend;
    await expect(freshMap("throws", (b) => { backend = b; })).rejects.toThrow(/resolve 3 failed/);
    // Batches 1 and 2 were committed and answered before the run ended;
    // batch 3 and later were never sent.
    const bulks = backend.requests.filter(r => r.path === "/v1/patches/bulk");
    expect(bulks).toHaveLength(2);
    expect(bulks.every(r => r.code === 200)).toBe(true);
  }, 120_000);
});
