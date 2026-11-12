// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildBundle, clampBudgets, issueRankedFiles, renderFullBundle as renderBundle } from "../commands/context.js";
import { contextBundleSchema } from "../context-bundle-schema.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";
import type { RankedFile, StartingPoint } from "../explain/issue.js";
import { gitRepoAccess } from "../explain/text-references.js";

/**
 * The bundle `ix context --from-issue` builds: the usual bundle around the
 * first starting point, plus two rows that lead the evidence -- where the
 * issue starts, and the files ranked against its text. They have to lead:
 * the default budget is a few thousand characters, and a file target with
 * many members fills it before anything ranked at 10 or later is reached.
 */

function member(i: number): EntityLocation {
  return { id: `m-${i}`, name: `helper${i}`, kind: "function", path: "src/client/api.ts", lineStart: i * 10 + 1, lineEnd: i * 10 + 9 };
}

function facts(): ContextFacts {
  const memberRefs = Array.from({ length: 60 }, (_, i) => member(i));
  return {
    id: "s-list", name: "listByKind", kind: "method", path: "src/client/api.ts", lineStart: 141, lineEnd: 152,
    members: memberRefs.map((m) => m.name), memberRefs, memberCount: memberRefs.length,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [],
    historyLength: 1, introducedRev: 7, stale: false, diagnostics: [],
  } as ContextFacts;
}

const STARTS: StartingPoint[] = [
  { token: "listByKind", id: "s-list", name: "listByKind", kind: "method", path: "src/client/api.ts", lineStart: 141, lineEnd: 152, via: "identifier in issue" },
  { token: "rank.ts", id: "f-rank", name: "rank.ts", kind: "file", path: "src/cli/commands/rank.ts", via: "path in issue" },
];

function ranked(n: number): RankedFile[] {
  return [
    { path: "src/client/api.ts", score: 7.5, reason: "starting point (identifier in issue)" },
    { path: "src/cli/commands/rank.ts", score: 6.1, reason: "starting point (path in issue)" },
    ...Array.from({ length: n - 2 }, (_, i) => ({
      path: `src/cli/commands/c${i}.ts`, score: 5 - i * 0.1, reason: `bm25 ${(5 - i * 0.1).toFixed(2)}`,
    })),
  ];
}

function build(issue: Parameters<typeof buildBundle>[0]["issue"]) {
  return buildBundle({
    resolved: { id: "s-list", name: "listByKind", kind: "method", resolutionMode: "issue" },
    facts: facts(),
    context: {
      // Enough claims that the default budget has to cut something.
      claims: Array.from({ length: 30 }, (_, i) => ({
        claim: { id: `c-${i}`, entityId: "s-list", statement: `listByKind returns nodes of kind ${i} in revision order`, status: "active" },
        relevance: 1, confidence: { score: 0.9 },
      })),
      conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: {},
    budgets: clampBudgets({}),
    isStale: () => false,
    graphCompleted: true,
    issue,
  });
}

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

const issue = (over: Partial<NonNullable<Parameters<typeof buildBundle>[0]["issue"]>> = {}) => ({
  startingPoints: STARTS,
  unresolved: ["flexLayout"],
  fallback: false,
  rankedFiles: ranked(12),
  extraEntities: [{ id: "r-smells", name: "smells.ts", kind: "file", path: "src/cli/commands/smells.ts" }],
  ...over,
});

describe("ix context --from-issue bundle", () => {
  it("leads the evidence with the starting points and the ranked files, inside the default budget", () => {
    const b = build(issue());
    expect(b.evidence.map((e) => e.id).slice(0, 3)).toEqual(["target:s-list", "issue-starts", "issue-ranked-files"]);
    expect(b.truncation.evidenceTruncated).toBeGreaterThan(0); // the budget did cut, just not these

    const starts = b.evidence[1];
    expect(starts.title).toBe("starting points: listByKind (src/client/api.ts:141-152), rank.ts (src/cli/commands/rank.ts)");
    expect(starts.reason).toContain("listByKind: identifier in issue");
    expect(starts.reason).toContain("rank.ts: path in issue");
    expect(starts.reason).toContain("unresolved: flexLayout");
    expect(starts.location).toEqual({ path: "src/client/api.ts", lineStart: 141, lineEnd: 152 });

    const files = b.evidence[2];
    const shown = files.title.replace(/^ranked files: /, "").split(", ");
    expect(shown).toHaveLength(10);
    expect(shown[0]).toBe("src/client/api.ts");
    expect(files.reason).toContain("bm25");
  });

  it("carries the full ranked list and the starting points in JSON, and the schema keeps them", () => {
    const b = build(issue());
    expect(b.rankedFiles).toHaveLength(12);
    expect(b.issue?.startingPoints.map((s) => s.path)).toEqual(["src/client/api.ts", "src/cli/commands/rank.ts"]);
    expect(b.issue?.unresolved).toEqual(["flexLayout"]);

    const parsed = contextBundleSchema.safeParse(JSON.parse(JSON.stringify(b)));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.rankedFiles).toEqual(b.rankedFiles);
    expect(parsed.data?.issue).toEqual(b.issue);
  });

  it("preserves companion provenance when validating saved JSON", () => {
    const companion = { source: "re-export" as const, seed: "src/client/api.ts" };
    const files = ranked(3);
    files[1] = { ...files[1], companion };
    const b = build(issue({ rankedFiles: files }));
    const parsed = contextBundleSchema.parse(JSON.parse(JSON.stringify(b)));
    expect(parsed.rankedFiles?.[1]).toHaveProperty("companion", companion);
  });

  it("keeps a start's snippet and traceback marks through the schema", () => {
    const starts: StartingPoint[] = [{ ...STARTS[0], snippet: true }, { ...STARTS[1], traceback: true }];
    const b = build({ ...issue(), startingPoints: starts });
    const parsed = contextBundleSchema.safeParse(JSON.parse(JSON.stringify(b)));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.issue?.startingPoints).toEqual(b.issue?.startingPoints);
    expect(parsed.data?.issue?.startingPoints.map((s) => [s.snippet, s.traceback])).toEqual([[true, undefined], [undefined, true]]);
  });

  it("puts the other starting points right after the target, and their neighbours in the bundle", () => {
    const b = build(issue());
    expect(b.entities[1]).toMatchObject({ id: "f-rank", path: "src/cli/commands/rank.ts" });
    expect(b.entities.map((e) => e.id)).toContain("r-smells");
  });

  it("renders both rows in llm and text output", () => {
    const b = build(issue());
    const llm = captureLog(() => renderBundle(b, "llm")).join("\n");
    expect(llm).toMatch(/^evidence score=1000 kind=target title="starting points: listByKind/m);
    expect(llm).toMatch(/^evidence score=1001 kind=structural title="ranked files: src\/client\/api.ts, /m);
    expect(llm).not.toContain("issue_fallback");

    const text = captureLog(() => renderBundle(b, "text")).join("\n");
    expect(text).toContain("starting points: listByKind (src/client/api.ts:141-152)");
    expect(text).toContain("ranked files: src/client/api.ts");
  });

  it("ranks a full --from-issue run's files with the checkout's companions, and keeps them in the JSON", async () => {
    // The wiring buildIssueBundle uses: the plan's repository access and the
    // git history at the workspace root, against a real (synthetic) checkout.
    const dir = mkdtempSync(join(process.cwd(), ".issue-bundle-test-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      // other.py changes on its own, so only worker.py has a co-change partner (schema.py).
      writeFileSync(join(dir, "other.py"), "NAME = 0\n");
      git("add", "other.py");
      git("commit", "-qm", "Add other");
      for (let i = 0; i < 2; i++) {
        writeFileSync(join(dir, "worker.py"), `def run_job(): return ${i}\n`);
        writeFileSync(join(dir, "schema.py"), `VERSION = ${i}\n`);
        git("add", "worker.py", "schema.py");
        git("commit", "-qm", "Update worker and schema");
      }
      const start: StartingPoint = { token: "worker.py", name: "worker.py", kind: "file", path: "worker.py", via: "path in issue" };
      const files = await issueRankedFiles("run_job fails in worker.py",
        { starts: [start], bm25: [{ path: "other.py", score: 2 }], near: new Map() }, gitRepoAccess(dir), dir);
      // The named file precedes lexical hits; companions follow the whole primary ranking.
      expect(files.map((f) => f.path)).toEqual(["worker.py", "other.py", "schema.py"]);
      expect(files[2]).toMatchObject({ companion: { source: "co-change", seed: "worker.py" } });

      const b = build(issue({ rankedFiles: files }));
      const parsed = contextBundleSchema.parse(JSON.parse(JSON.stringify(b)));
      expect(parsed.rankedFiles?.map((f) => f.path)).toEqual(files.map((f) => f.path));
      expect(parsed.rankedFiles?.[2]).toHaveProperty("companion", { source: "co-change", seed: "worker.py" });
      // Without a checkout the primary ranking comes back unchanged.
      expect((await issueRankedFiles("run_job fails", { starts: [start], bm25: [], near: new Map() }, undefined, dir))
        .map((f) => f.path)).toEqual(["worker.py"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names companion files in the evidence row even past the shown primary files", () => {
    const companion = { path: "src/client/index.ts", score: 1, reason: "companion (re-export of src/client/api.ts)",
      companion: { source: "re-export" as const, seed: "src/client/api.ts" } };
    const b = build(issue({ rankedFiles: [...ranked(20), companion] }));
    expect(b.rankedFiles).toHaveLength(21);
    const row = b.evidence.find((e) => e.id === "issue-ranked-files")!;
    const shown = row.title.replace(/^ranked files: /, "").split(", ");
    expect(shown).toEqual([...ranked(20).slice(0, 10).map((f) => f.path), "src/client/index.ts"]);
    expect(row.reason).toContain("then companion files");
    // The header describes the pinned-first order, not a pure score order.
    expect(row.reason).toMatch(/^pinned first: paths the issue names, then specific code names .*; then the rest by bm25/);
    expect(row.reason).toContain("index.ts (companion (re-export of src/client/api.ts))");
    expect(captureLog(() => renderBundle(b, "llm")).join("\n")).toMatch(/^evidence .*title="ranked files: .*src\/client\/index.ts"/m);
    expect(captureLog(() => renderBundle(b, "text")).join("\n")).toContain("src/client/index.ts");

    const plain = build(issue({ rankedFiles: ranked(20) })).evidence.find((e) => e.id === "issue-ranked-files")!;
    expect(plain.reason).not.toContain("companion");
  });

  it("says so when the start came from BM25 because nothing in the issue resolved", () => {
    const b = build(issue({
      startingPoints: [{ token: "src/client/api.ts", id: "f-api", name: "api.ts", kind: "file", path: "src/client/api.ts", via: "bm25 fallback" }],
      unresolved: ["flexLayout", "gridArea"],
      fallback: true,
    }));
    expect(b.issue?.fallback).toBe(true);
    expect(b.evidence[1].reason).toContain("no code name in the issue resolved to a definition");
    const llm = captureLog(() => renderBundle(b, "llm")).join("\n");
    expect(llm).toMatch(/^diagnostic code=issue_fallback /m);
  });

  it("still validates a saved bundle that has neither field", () => {
    const b = build(undefined);
    expect(b.rankedFiles).toBeUndefined();
    expect(b.issue).toBeUndefined();
    expect(contextBundleSchema.safeParse(JSON.parse(JSON.stringify(b))).success).toBe(true);
  });

  it("accepts a bundle with and without generatedAt, and keeps the key when present", () => {
    const b = JSON.parse(JSON.stringify(build(issue())));
    expect(typeof b.generatedAt).toBe("string");
    const withKey = contextBundleSchema.safeParse(b);
    expect(withKey.success).toBe(true);
    expect(withKey.data?.generatedAt).toBe(b.generatedAt);

    const { generatedAt: _omit, ...without } = b;
    const parsed = contextBundleSchema.safeParse(without);
    expect(parsed.success).toBe(true);
    expect(parsed.data && "generatedAt" in parsed.data).toBe(false);
  });
});
