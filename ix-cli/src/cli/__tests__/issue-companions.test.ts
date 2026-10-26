// Copyright 2026 Ix Infrastructure Inc.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  companionHistory, COMPANION_BUDGET_MS, expandIssueCompanions,
  MAX_COMPANION_CANDIDATES, MAX_COMPANION_IMPORTS, MAX_COMPANION_READS, MAX_COMPANIONS,
} from "../explain/issue-companions.js";
import { rankIssueFiles, type RankedFile } from "../explain/issue.js";
import { gitRepoAccess, type RepoAccess } from "../explain/text-references.js";
import { runWithSignal } from "../../client/run-signal.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

function repo(files: Record<string, string>): RepoAccess {
  return { files: () => Object.keys(files), read: vi.fn((path) => files[path]), grep: () => [] };
}

function ranking(...paths: string[]): RankedFile[] {
  return rankIssueFiles({ starts: [], bm25: paths.map((path, i) => ({ path, score: 10 - i })), near: new Map() });
}

describe("issue companion expansion", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["pkg/worker.py", "pkg/__init__.py", "def run_job(): pass", "from .worker import run_job\n"],
    ["src/worker.ts", "src/index.ts", "export function runJob() {}", 'export { runJob } from "./worker.js";'],
    ["src/worker.ts", "src/registry.ts", "export class Worker {}", 'import { Worker } from "./worker";\nexport const registry = { Worker };'],
  ])("adds a sibling re-export from %s", async (seed, entry, source, exports) => {
    const files = repo({ [seed]: source, [entry]: exports, "other.ts": "export const unrelated = 1" });
    const primary = ranking(seed, "other.ts");
    const result = await expandIssueCompanions("The job fails", primary, { repo: files });
    expect(result.map((r) => r.path)).toEqual([seed, entry, "other.ts"]);
    expect(result[0]).toBe(primary[0]);
    expect(result[1].companion).toEqual({ source: "re-export", seed });
    expect(result[1].score).toBeLessThan(primary[0].score);
  });

  it.each([
    ["pkg/worker.py", "from .types import JobError as Failure\ndef run_job(): pass", "pkg/types.py", "class JobError(Exception): pass"],
    ["src/worker.ts", 'import { JobError as Failure } from "./types.js";\nexport function runJob() {}', "src/types.ts", "export class JobError {}"],
    ["src/worker.ts", 'import Failure from "./types";\nexport function runJob() {}', "src/types.ts", "export default class JobError {}"],
  ])("finds the definition of an issue-mentioned imported alias in %s", async (seed, source, target, definition) => {
    const files = repo({ [seed]: source, [target]: definition });
    const result = await expandIssueCompanions("Failure escapes the job", ranking(seed), { repo: files });
    expect(result.map((r) => r.path)).toEqual([seed, target]);
    expect(result[1].companion).toEqual({ source: "issue-import", seed });
  });

  it("follows a bounded re-export chain to a definition", async () => {
    const files = repo({
      "pkg/worker.py": "from .public import JobError\ndef run_job(): pass",
      "pkg/public.py": "from .types import JobError",
      "pkg/types.py": "class JobError(Exception): pass",
    });
    const result = await expandIssueCompanions("JobError escapes", ranking("pkg/worker.py"), { repo: files });
    expect(result[1].path).toBe("pkg/types.py");
  });

  it("ignores unrelated entry points, unmentioned imports, external names and noise", async () => {
    const files = repo({
      "src/worker.ts": 'import { JobError } from "./types";\nimport { AlienError } from "external";',
      "src/types.ts": "export class JobError {}",
      "src/index.ts": 'export { other } from "./other";',
      "src/other.ts": "export const other = 1;",
      "tests/helper.py": "pass", "docs/helper.py": "pass",
    });
    const primary = ranking("src/worker.ts");
    const result = await expandIssueCompanions("AlienError escapes", primary, { repo: files,
      history: async () => ["tests/helper.py", "docs/helper.py", "missing.ts"].map((path) => ({ path, commits: 2, score: 1 })),
    });
    expect(result).toEqual(primary);
  });

  it("expands only two seeds, deduplicates promotions and preserves number one at every k", async () => {
    const files = repo(Object.fromEntries(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"].map((p) => [p, ""])));
    const primary = ranking("a.ts", "b.ts", "c.ts", "d.ts", "e.ts");
    const history = vi.fn(async (_path: string) => ["a.ts", "b.ts", "g.ts", "d.ts", "f.ts", "e.ts"]
      .map((path) => ({ path, commits: 100, score: 1000 })));
    for (const limit of [0, 1, 2, 5, 20]) {
      history.mockClear();
      const result = await expandIssueCompanions("bug", primary, { repo: files, history }, limit);
      expect(result.length).toBeLessThanOrEqual(limit);
      if (limit > 0) expect(result[0]).toBe(primary[0]);
      expect(new Set(result.map((r) => r.path)).size).toBe(result.length);
      expect(result.filter((r) => r.companion).length).toBeLessThanOrEqual(MAX_COMPANIONS);
      expect(result.filter((r) => r.companion).every((r) => r.score <= primary[0].score * 0.8)).toBe(true);
      expect(history.mock.calls.map(([path]) => path)).toEqual(limit <= 1 ? [] : ["a.ts", "b.ts"]);
    }
    const result = await expandIssueCompanions("bug", primary, { repo: files, history }, 5);
    expect(result.map((r) => r.path)).toEqual(["a.ts", "d.ts", "b.ts", "e.ts", "c.ts"]);
    expect(primary.map((r) => r.path)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  it("enforces file-read, import-name and candidate budgets", async () => {
    const files: Record<string, string> = { "pkg/worker.py": "" };
    for (let i = 0; i < 50; i++) {
      files[`pkg/dependency${i}.py`] = `class Error${i}: pass`;
      files["pkg/worker.py"] += `from .dependency${i} import Error${i}\n`;
      files[`pkg/entry${i}_registry.py`] = "from .worker import run_job";
    }
    const access = repo(files);
    const history = vi.fn(async () => Object.keys(files).map((path) => ({ path, commits: 2, score: 1 })));
    const result = await expandIssueCompanions(Object.keys(files).map((_, i) => `Error${i}`).join(" "), ranking("pkg/worker.py"), { repo: access, history });
    expect(vi.mocked(access.read).mock.calls.length).toBeLessThanOrEqual(MAX_COMPANION_READS);
    expect(result.filter((f) => f.companion).length).toBeLessThanOrEqual(MAX_COMPANIONS);
    expect(result).toHaveLength(1 + MAX_COMPANIONS);
    // Without the entry points, at most eight imported names are resolved.
    const importsOnly = repo(Object.fromEntries(Object.entries(files).filter(([p]) => !p.includes("registry"))));
    await expandIssueCompanions("Error0 " + Array.from({ length: 50 }, (_, i) => `Error${i}`).join(" "), ranking("pkg/worker.py"), { repo: importsOnly });
    expect(vi.mocked(importsOnly.read).mock.calls.length).toBeLessThanOrEqual(1 + MAX_COMPANION_IMPORTS);
  });

  it("considers a bounded number of history candidates", async () => {
    const paths = Array.from({ length: MAX_COMPANION_CANDIDATES + 5 }, (_, i) => `file${i}.ts`);
    const access = repo(Object.fromEntries(["seed.ts", ...paths].map((p) => [p, ""])));
    const history = async () => paths.map((path, i) => ({ path, commits: 2, score: i < MAX_COMPANION_CANDIDATES ? 0.1 : 100 }));
    const result = await expandIssueCompanions("bug", ranking("seed.ts"), { repo: access, history });
    expect(result.filter((r) => r.companion).map((r) => r.path).every((p) => paths.slice(0, MAX_COMPANION_CANDIDATES).includes(p))).toBe(true);
    expect(result[1].score).toBeCloseTo(0.64);
  });

  it("shares the read budget between both seeds", async () => {
    const files: Record<string, string> = {};
    const issueNames: string[] = [];
    for (const pkg of ["alpha", "beta"]) {
      files[`${pkg}/worker.py`] = "";
      for (let i = 0; i < MAX_COMPANION_IMPORTS; i++) {
        const name = `${pkg}Error${i}`;
        issueNames.push(name);
        files[`${pkg}/worker.py`] += `from .types${i} import ${name}\n`;
        files[`${pkg}/types${i}.py`] = `class ${name}: pass`;
        files[`${pkg}/entry${i}_registry.py`] = "from .worker import run_job";
      }
    }
    const access = repo(files);
    await expandIssueCompanions(issueNames.join(" "), ranking("alpha/worker.py", "beta/worker.py"), { repo: access });
    expect(vi.mocked(access.read).mock.calls).toHaveLength(MAX_COMPANION_READS);
  });

  it("retains local companions when history exhausts the remaining time", async () => {
    vi.useFakeTimers();
    const access = repo({ "src/worker.ts": "export class Worker {}", "src/index.ts": 'export { Worker } from "./worker";' });
    const pending = expandIssueCompanions("Worker fails", ranking("src/worker.ts"), { repo: access, history: () => new Promise<never>(() => {}) });
    await vi.advanceTimersByTimeAsync(COMPANION_BUDGET_MS);
    expect((await pending)[1]).toMatchObject({ path: "src/index.ts", companion: { source: "re-export" } });
  });

  it("returns on the shared deadline even if a history provider never resolves", async () => {
    vi.useFakeTimers();
    const files = repo({ "a.ts": "", "b.ts": "" });
    const history = vi.fn((_path: string, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return new Promise<never>(() => {});
    });
    const primary = ranking("a.ts", "b.ts");
    const pending = expandIssueCompanions("bug", primary, { repo: files, history });
    await vi.advanceTimersByTimeAsync(COMPANION_BUDGET_MS);
    expect(await pending).toEqual(primary);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.calls[0][1].aborted).toBe(true);
  });

  it("checks the deadline after synchronous reads and skips oversized files", async () => {
    let clock = 0;
    const files = repo({ "a.ts": 'import { JobError } from "./types";', "types.ts": "export class JobError {}" });
    const read = files.read;
    files.read = vi.fn((path) => { clock += COMPANION_BUDGET_MS; return read(path); });
    const history = vi.fn(async () => []);
    const primary = ranking("a.ts");
    expect(await expandIssueCompanions("JobError", primary, { repo: files, history, now: () => clock })).toEqual(primary);
    expect(history).not.toHaveBeenCalled();
    const big = repo({ "a.ts": 'import { JobError } from "./types";' + " ".repeat(70_000), "types.ts": "export class JobError {}" });
    expect(await expandIssueCompanions("JobError", primary, { repo: big })).toEqual(primary);
  });

  it("honours cancellation from the enclosing command", async () => {
    const controller = new AbortController();
    const history = vi.fn(() => new Promise<never>(() => {}));
    const primary = ranking("a.ts");
    const access = repo({ "a.ts": "" });
    const pending = runWithSignal(controller.signal, () => expandIssueCompanions("bug", primary, { repo: access, history }));
    controller.abort();
    expect(await pending).toEqual(primary);
    history.mockClear();
    expect(await runWithSignal(controller.signal, () => expandIssueCompanions("bug", primary, { repo: access, history }))).toEqual(primary);
    expect(history).not.toHaveBeenCalled();
  });

  it("keeps the original ranking without a checkout or when history fails", async () => {
    const primary = ranking("a.ts");
    expect(await expandIssueCompanions("bug", primary, {})).toEqual(primary);
    expect(await expandIssueCompanions("bug", [], { repo: repo({}) })).toEqual([]);
    expect(await expandIssueCompanions("bug", primary, { repo: repo({ "a.ts": "" }), history: async () => { throw new Error("unavailable"); } })).toEqual(primary);
  });
});

describe("companion history in a synthetic git repository", () => {
  it("finds repeated co-changes, caches at HEAD and invalidates after a commit", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".companion-test-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      for (let i = 0; i < 2; i++) {
        writeFileSync(join(dir, "worker.py"), `def run_job(): return ${i}\n`);
        writeFileSync(join(dir, "schema.py"), `VERSION = ${i}\n`);
        git("add", "worker.py", "schema.py");
        git("commit", "-qm", "Update worker and schema");
      }
      const signal = new AbortController().signal;
      vi.mocked(execFile).mockClear();
      const logCalls = () => vi.mocked(execFile).mock.calls.filter(([, args]) => Array.isArray(args) && args.includes("log")).length;
      const history = companionHistory(dir);
      expect(await history("worker.py", signal)).toEqual([{ path: "schema.py", commits: 2, score: 1 }]);
      expect(logCalls()).toBe(1);
      expect(await companionHistory(dir)("worker.py", signal)).toEqual([{ path: "schema.py", commits: 2, score: 1 }]);
      expect(logCalls()).toBe(1);
      const expanded = await expandIssueCompanions("run_job fails", ranking("worker.py"), { repo: gitRepoAccess(dir), history: companionHistory(dir) });
      expect(expanded[1]).toMatchObject({ path: "schema.py", companion: { source: "co-change", seed: "worker.py" } });
      writeFileSync(join(dir, "worker.py"), "def run_job(): return 3\n");
      writeFileSync(join(dir, "schema.py"), "VERSION = 3\n");
      git("add", "worker.py", "schema.py");
      git("commit", "-qm", "Update pair again");
      expect(await companionHistory(dir)("worker.py", signal)).toEqual([{ path: "schema.py", commits: 3, score: 1.5 }]);
      expect(logCalls()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
