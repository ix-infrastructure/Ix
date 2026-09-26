// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildBundle, clampBudgets } from "../commands/context.js";
import type { ContextFacts } from "../explain/facts.js";
import { coChangedFiles, gitRunner, recentCommits, type GitRunner } from "../explain/history.js";

/** A `git log` that answers from a fixed list of commits, newest first. */
function fakeGit(commits: Array<{ sha: string; date: string; subject: string; files: string[] }>): GitRunner {
  return (args) => {
    const path = args[args.indexOf("--") + 1];
    const depth = Number((args.find((a) => /^-\d+$/.test(a)) ?? "-1000").slice(1));
    const touching = commits.filter((c) => c.files.includes(path)).slice(0, depth);
    if (args.includes("--full-diff")) {
      return touching.map((c) => `@${c.sha}\n\n${c.files.join("\n")}\n`).join("");
    }
    return touching.map((c) => `${c.sha}\t${c.date}\t${c.subject}`).join("\n");
  };
}

describe("recentCommits", () => {
  it("keeps the newest two, adds the newest fixes, and stays newest first", () => {
    // inventory.ts before the rank fix: the fix to the same bug next door was
    // behind three feature commits.
    const git = fakeGit([
      { sha: "d4ed26f", date: "2026-06-04", subject: "Path 2: separate-ingest stitcher (#246)", files: ["inventory.ts"] },
      { sha: "7ab9034", date: "2026-06-02", subject: "Multi-repo co-ingest (#234)", files: ["inventory.ts"] },
      { sha: "19db830", date: "2026-06-02", subject: "feat(cli): Tier 2 --format llm renderers (#233)", files: ["inventory.ts"] },
      { sha: "bee214b", date: "2026-06-02", subject: "fix(inventory): send --path as server-side scope (#229)", files: ["inventory.ts"] },
      { sha: "97d66ff", date: "2026-05-30", subject: "fix: inventory uses listByKind", files: ["inventory.ts"] },
      { sha: "0000001", date: "2026-05-01", subject: "fix: an older fix", files: ["inventory.ts"] },
    ]);
    expect(recentCommits(git, "inventory.ts").map((c) => c.sha)).toEqual(["d4ed26f", "7ab9034", "bee214b", "97d66ff"]);
  });

  it("does not repeat a commit that is both newest and a fix", () => {
    const git = fakeGit([
      { sha: "a", date: "d", subject: "fix(cli): fail unresolved graph commands (#547)", files: ["resolve.ts"] },
      { sha: "b", date: "d", subject: "perf: cut ix read", files: ["resolve.ts"] },
      { sha: "c", date: "d", subject: "fix(mcp): close leaks", files: ["resolve.ts"] },
    ]);
    expect(recentCommits(git, "resolve.ts").map((c) => c.sha)).toEqual(["a", "b", "c"]);
  });

  it("is empty when git cannot answer", () => {
    expect(recentCommits(() => undefined, "x.ts")).toEqual([]);
  });
});

describe("coChangedFiles", () => {
  it("ranks files that changed with the target, discounting sweeps", () => {
    const sweep = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const git = fakeGit([
      { sha: "1", date: "d", subject: "s", files: ["inventory.ts", "rank.ts", "api.ts"] },
      { sha: "2", date: "d", subject: "s", files: ["inventory.ts", "rank.ts"] },
      { sha: "3", date: "d", subject: "s", files: ["inventory.ts", "api.ts", "a.ts", "b.ts", "c.ts", "d.ts"] },
      { sha: "4", date: "d", subject: "s", files: ["inventory.ts", "once.ts"] },
      { sha: "5", date: "d", subject: "sweep", files: ["inventory.ts", ...sweep] },
      { sha: "6", date: "d", subject: "sweep", files: ["inventory.ts", ...sweep] },
    ]);
    const found = coChangedFiles(git, "inventory.ts", new Set());
    expect(found.map((c) => c.path)).toEqual(["rank.ts", "api.ts"]);
    expect(found[0]).toMatchObject({ commits: 2 });
  });

  it("skips files the bundle has, and tests unless the target is one", () => {
    const git = fakeGit([
      { sha: "1", date: "d", subject: "s", files: ["a.ts", "b.ts", "src/__tests__/a.test.ts"] },
      { sha: "2", date: "d", subject: "s", files: ["a.ts", "b.ts", "src/__tests__/a.test.ts"] },
    ]);
    expect(coChangedFiles(git, "a.ts", new Set(["b.ts"]))).toEqual([]);
    expect(coChangedFiles(git, "src/__tests__/a.test.ts", new Set()).map((c) => c.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("gitRunner", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads a real repository's log, and returns undefined outside one", () => {
    dir = mkdtempSync(join(tmpdir(), "ix-history-"));
    expect(gitRunner(dir)(["log", "-1"])).toBeUndefined();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    for (const [i, subject] of ["feat: add a", "fix: a handles b"].entries()) {
      writeFileSync(join(dir, "a.ts"), `// ${i}\n`);
      writeFileSync(join(dir, "b.ts"), `// ${i}\n`);
      git("add", ".");
      git("commit", "-q", "-m", subject);
    }
    const run = gitRunner(dir);
    expect(recentCommits(run, "a.ts").map((c) => c.subject)).toEqual(["fix: a handles b", "feat: add a"]);
    expect(coChangedFiles(run, "a.ts", new Set()).map((c) => [c.path, c.commits])).toEqual([["b.ts", 2]]);
  });
});

describe("recent commits in a bundle", () => {
  it("is one provenance row naming each commit, right after the related files", () => {
    const facts: ContextFacts = {
      id: "f", name: "resolve.ts", kind: "file", path: "ix-cli/src/cli/resolve.ts",
      members: [], memberCount: 0, callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
      topCallers: [], topDependents: [], historyLength: 1, introducedRev: 1, stale: false, diagnostics: [],
      relatedRefs: [{ id: "r", name: "locate.ts", kind: "file", path: "src/locate.ts", score: 1, reason: "x", via: [] }],
      importRefs: [{ id: "i", name: "ui.ts", kind: "file", path: "src/ui.ts" }],
      recentCommits: [
        { sha: "df30296", date: "2026-09-06", subject: "fix(cli): fail unresolved graph commands (#547)" },
        { sha: "958d679", date: "2026-08-23", subject: "perf: cut ix read (#494)" },
      ],
    };
    const bundle = buildBundle({
      resolved: { id: "f", name: "resolve.ts", kind: "file", resolutionMode: "exact" },
      facts,
      context: {
        claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {},
      budgets: clampBudgets({}),
      isStale: () => false,
    });
    const titles = bundle.evidence.map((e) => e.title);
    const at = titles.findIndex((t) => t.startsWith("recent commits to resolve.ts:"));
    expect(titles[at]).toBe(
      "recent commits to resolve.ts: df30296 fix(cli): fail unresolved graph commands (#547); 958d679 perf: cut ix read (#494)");
    expect(bundle.evidence[at].kind).toBe("provenance");
    expect(titles[at - 1]).toMatch(/^related files:/);
    expect(titles[at + 1]).toBe("imports ui.ts");
  });
});
