// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mineHistory,
  couplingIndex,
  coupledFor,
  loadHistory,
  readCoupling,
} from "../git-coupling.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import { ingestHistory } from "../ingest-history.js";
import { FakeBackend } from "./helpers/fake-backend.js";
import { IxClient } from "../../client/api.js";
import { ingestFiles } from "../commands/ingest.js";
import { companionHistory, expandIssueCompanions } from "../explain/issue-companions.js";
import { Command } from "commander";
import { registerCoupledCommand } from "../commands/coupled.js";
import { couplingLines, targetCoupling } from "../coupling-output.js";
import { clearIngestMtimeCache } from "../config.js";

const roots: string[] = [];
function repository() {
  const root = mkdtempSync(
    join(fileURLToPath(new URL("../../../../", import.meta.url)), ".history-test-"),
  );
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.org",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.org",
      },
    }).trim();
  git("init", "-q");
  const commit = (subject: string, files = ["a.ts", "b.ts"]) => {
    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      const name = /b\.(?:ts|py)$/.test(file) ? "beta" : "alpha";
      writeFileSync(
        join(root, file),
        file.endsWith(".py")
          ? `def ${name}():\n    return ${count}\n`
          : `export function ${name}() {\n  return ${count};\n}\n`,
      );
    }
    git("add", ".");
    git("commit", "-qm", subject);
    count++;
    return git("rev-parse", "HEAD");
  };
  let count = 0;
  return { root, git, commit };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("git coupling from real history", () => {
  it("counts directed support/confidence, symbol hunks and metadata-only fixes", async () => {
    const repo = repository();
    repo.commit("initial");
    repo.commit("fix: paired bug");
    repo.commit("repair #123");
    repo.commit("alpha only", ["a.ts"]);
    const [{ parseFile }] = await loadIngestionModules();
    const state = await mineHistory(repo.root, undefined, { parseFile });
    const index = couplingIndex(state!);
    const result = coupledFor(index, { path: "a.ts" });
    expect(result.partners[0]).toMatchObject({ path: "b.ts", support: 3, confidence: 0.75 });
    const symbol = coupledFor(index, { path: "a.ts", name: "alpha" });
    expect(symbol.partners[0]).toMatchObject({
      path: "b.ts",
      name: "beta",
      support: 3,
      confidence: 0.75,
    });
    expect(symbol.recentFixes.map((c) => c.subject)).toEqual(["repair #123", "fix: paired bug"]);
    expect(Object.keys(symbol.recentFixes[0]).sort()).toEqual(["date", "sha", "subject"]);
  });

  it("mines only new commits and rebuilds safely after rewritten history", async () => {
    const repo = repository();
    repo.commit("first");
    repo.commit("second");
    const first = await mineHistory(repo.root);
    repo.commit("third");
    const next = await mineHistory(repo.root, first);
    expect(next!.mined).toBe(1);
    expect(coupledFor(couplingIndex(next!), { path: "a.ts" }).partners[0].support).toBe(3);
    expect((await mineHistory(repo.root, next))!.mined).toBe(0);
    repo.git("reset", "--hard", "HEAD~2");
    repo.commit("replacement", ["a.ts"]);
    const rewritten = await mineHistory(repo.root, next);
    expect(rewritten!.mined).toBe(2);
    expect(coupledFor(couplingIndex(rewritten!), { path: "a.ts" }).partners).toEqual([]);
  });

  it("maps Python hunks through the existing parser", async () => {
    const repo = repository();
    for (let i = 0; i < 3; i++) repo.commit(`fix paired ${i}`, ["a.py", "b.py"]);
    const [{ parseFile }] = await loadIngestionModules();
    const state = await mineHistory(repo.root, undefined, { parseFile });
    expect(
      coupledFor(couplingIndex(state!), { path: "a.py", name: "alpha" }).partners[0],
    ).toMatchObject({ path: "b.py", name: "beta", support: 3, confidence: 1 });
  });

  it("skips sweeps, format/bot commits, vendor/generated/locks and bounds the window", async () => {
    const repo = repository();
    for (let i = 0; i < 3; i++)
      repo.commit(`pair ${i}`, [
        "a.ts",
        "b.ts",
        "vendor/v.ts",
        "generated/g.ts",
        "package-lock.json",
      ]);
    repo.commit("chore: prettier format", ["a.ts", "c.ts"]);
    repo.commit("dependabot dependency update", ["a.ts", "c.ts"]);
    repo.commit("sweep", ["a.ts", ...Array.from({ length: 51 }, (_, i) => `f${i}.ts`)]);
    const state = await mineHistory(repo.root);
    expect(coupledFor(couplingIndex(state!), { path: "a.ts" }).partners.map((p) => p.path)).toEqual(
      ["b.ts"],
    );
    const bounded = await mineHistory(repo.root, undefined, { maxCommits: 2 });
    expect(bounded!.commits.length).toBeLessThanOrEqual(2);
    expect(coupledFor(couplingIndex(bounded!), { path: "a.ts" }).partners).toEqual([]);
  });

  it("caps directed edges at 20 and respects git generated attributes and odd paths", async () => {
    const repo = repository();
    writeFileSync(join(repo.root, ".gitattributes"), "marked.ts linguist-generated=true\n");
    const files = [
      "a.ts",
      "odd\nname.ts",
      "marked.ts",
      ...Array.from({ length: 22 }, (_, i) => `p${i}.ts`),
    ];
    for (let i = 0; i < 3; i++) repo.commit(`pair ${i}`, files);
    const index = couplingIndex((await mineHistory(repo.root))!);
    expect(coupledFor(index, { path: "a.ts" }).partners).toHaveLength(20);
    expect(Object.values(index.entities).some((e) => e.path === "marked.ts")).toBe(false);
    expect(Object.values(index.entities).some((e) => e.path === "odd\nname.ts")).toBe(true);
  });

  it("keeps fixes about output format while excluding formatting and bot markers", async () => {
    const repo = repository();
    for (let i = 0; i < 3; i++) repo.commit(`fix: output format regression ${i}`);
    repo.commit("format: all sources", ["a.ts", "c.ts"]);
    repo.commit("automation[bot] refresh", ["a.ts", "c.ts"]);
    expect(
      coupledFor(couplingIndex((await mineHistory(repo.root))!), { path: "a.ts" }).partners,
    ).toMatchObject([{ path: "b.ts", support: 3, confidence: 1 }]);
  });

  it("evicts counts outside the rolling commit window on an incremental run", async () => {
    const repo = repository();
    for (let i = 0; i < 3; i++) repo.commit(`pair ${i}`);
    const before = await mineHistory(repo.root, undefined, { maxCommits: 3 });
    expect(coupledFor(couplingIndex(before!), { path: "a.ts" }).partners[0].support).toBe(3);
    repo.commit("solo change", ["a.ts"]);
    const after = await mineHistory(repo.root, before, { maxCommits: 3 });
    expect(after!.mined).toBe(1);
    expect(after!.commits).toHaveLength(3);
    expect(coupledFor(couplingIndex(after!), { path: "a.ts" }).partners).toEqual([]);
  });

  it("expires old evidence even when HEAD does not move and handles non-repositories", async () => {
    const repo = repository();
    repo.commit("first");
    repo.commit("second");
    repo.commit("third");
    const state = await mineHistory(repo.root);
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 2);
    const expired = await mineHistory(repo.root, state, { now: future });
    expect(expired!.mined).toBe(0);
    expect(expired!.commits).toEqual([]);
    const loose = join(repo.root, "loose");
    mkdirSync(loose);
    // Stop git searching parents without changing any global git configuration.
    vi.stubEnv("GIT_CEILING_DIRECTORIES", repo.root);
    expect(await mineHistory(loose)).toBeUndefined();
  });

  it("maps historical hunks in a workspace below the git root and skips merge commits", async () => {
    const repo = repository();
    for (let i = 0; i < 3; i++) repo.commit(`pair ${i}`, ["pkg/a.ts", "pkg/b.ts"]);
    const branch = repo.git("branch", "--show-current");
    repo.git("checkout", "-qb", "topic");
    repo.commit("topic pair", ["pkg/a.ts", "pkg/b.ts"]);
    repo.git("checkout", "-q", branch);
    repo.commit("other change", ["c.ts"]);
    repo.git("merge", "--no-ff", "-m", "fix merge topic", "topic");
    const [{ parseFile }] = await loadIngestionModules();
    const state = await mineHistory(join(repo.root, "pkg"), undefined, { parseFile });
    expect(
      coupledFor(couplingIndex(state!), { path: "a.ts", name: "alpha" }).partners[0],
    ).toMatchObject({ path: "b.ts", support: 4 });
    expect(state!.commits.some((c) => c.subject === "fix merge topic")).toBe(false);
  });

  it("recovers partial bounded graph batches even when the desired graph changes", async () => {
    const repo = repository();
    vi.stubEnv("IX_HOME", join(repo.root, ".git", "ix-home"));
    const files = Array.from({ length: 30 }, (_, i) => `p${i}.ts`);
    for (let i = 0; i < 3; i++) repo.commit(`pair ${i}`, files);
    const [{ parseFile }, { fileNodeId, symbolNodeId }] = await loadIngestionModules();
    const backend = new FakeBackend({ semantics: "legacy" });
    const client = new IxClient(await backend.start());
    let writes = 0;
    const input = {
      root: repo.root,
      workspaceId: "fixture-workspace",
      parseFile,
      fileNodeId,
      symbolNodeId,
      known: new Map(files.map((path) => [path, new Set(["alpha"])])),
      commit: async (patch: Parameters<IxClient["commitPatch"]>[0]) => {
        expect(patch.ops.length).toBeLessThanOrEqual(1000);
        if (++writes === 2) throw new Error("fixture interrupted second batch");
        return client.commitPatch(patch);
      },
    };
    try {
      await expect(ingestHistory(input)).rejects.toThrow("interrupted");
      expect(loadHistory(repo.root)).toBeUndefined();
      expect(backend.graphSignature().edges).toHaveLength(1000);
      await ingestHistory({
        ...input,
        known: new Map(files.slice(-2).map((path) => [path, new Set(["alpha"])])),
      });
      expect(backend.graphSignature().edges).toHaveLength(4);
      // Restore the same HEAD after deleting its edges; old idempotent patch
      // records must not prevent resurrection, including on legacy backends.
      await ingestHistory(input);
      expect(backend.graphSignature().edges).toHaveLength(1200);
    } finally {
      await backend.stop();
    }
  });

  it("persists edges through the HTTP patch protocol and retries failed writes without moving the cursor", async () => {
    const repo = repository();
    vi.stubEnv("IX_HOME", join(repo.root, ".git", "ix-home"));
    for (let i = 0; i < 3; i++) repo.commit(`fix paired ${i}`);
    const [{ parseFile }, { fileNodeId, symbolNodeId }] = await loadIngestionModules();
    const backend = new FakeBackend({ semantics: "head" });
    const client = new IxClient(await backend.start());
    const input = {
      root: repo.root,
      workspaceId: "fixture-workspace",
      parseFile,
      fileNodeId,
      symbolNodeId,
      known: new Map([
        ["a.ts", new Set(["alpha"])],
        ["b.ts", new Set(["beta"])],
      ]),
      commit: (patch: Parameters<IxClient["commitPatch"]>[0]) => client.commitPatch(patch),
    };
    try {
      backend.refuseEverything = true;
      await expect(ingestHistory(input)).rejects.toThrow();
      expect(loadHistory(repo.root)).toBeUndefined();
      backend.refuseEverything = false;
      expect(await ingestHistory(input)).toMatchObject({ edges: 4, mined: 3 });
      const index = readCoupling(repo.root)!;
      expect(
        coupledFor(index, { id: symbolNodeId(input.workspaceId, "a.ts", "alpha"), path: "" })
          .partners[0].name,
      ).toBe("beta");
      const ops = backend.lastOps.get("ix:git-history/0")!;
      expect(ops.every((op) => op.type === "UpsertEdge" && op.predicate === "CO_CHANGES")).toBe(
        true,
      );
      expect(ops[0].attrs).toMatchObject({ support: 3, confidence: 1 });
      const sent = backend.requests.length;
      expect(await ingestHistory(input)).toMatchObject({ mined: 0, graphChanged: false });
      expect(backend.requests).toHaveLength(sent);
      expect(await ingestHistory({ ...input, forceGraph: true })).toMatchObject({
        mined: 0,
        graphChanged: true,
      });
      expect(backend.requests).toHaveLength(sent + 1);
      // A source that changes alone loses confidence; its outgoing edge expires.
      for (let i = 0; i < 8; i++) repo.commit(`solo ${i}`, ["a.ts"]);
      await ingestHistory(input);
      expect(coupledFor(readCoupling(repo.root)!, { path: "a.ts" }).partners).toEqual([]);
      expect(coupledFor(readCoupling(repo.root)!, { path: "b.ts" }).partners[0].confidence).toBe(1);
      expect(backend.lastOps.get("ix:git-history/0")!.some((op) => op.type === "DeleteEdge")).toBe(
        true,
      );
      const future = new Date();
      future.setUTCFullYear(future.getUTCFullYear() + 2);
      await ingestHistory({ ...input, now: future });
      expect(backend.graphSignature().edges).toEqual([]);
      clearIngestMtimeCache(repo.root);
      expect(loadHistory(repo.root)).toBeUndefined();
      expect(backend.unknownPaths).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("wires default ingestion, cached issue candidates and the coupled CLI; opt-out skips mining", async () => {
    const repo = repository();
    vi.stubEnv("IX_HOME", join(repo.root, ".git", "ix-home"));
    for (let i = 0; i < 3; i++) repo.commit(`fix paired ${i}`);
    const backend = new FakeBackend({ semantics: "head" });
    vi.stubEnv("IX_ENDPOINT", await backend.start());
    const opts = {
      root: repo.root,
      recursive: true,
      format: "json",
      suppressOutput: true,
      printSummary: false,
      mapMode: true,
    };
    try {
      await ingestFiles(repo.root, { ...opts, gitHistory: false });
      expect(loadHistory(repo.root)).toBeUndefined();
      const summary = await ingestFiles(repo.root, opts);
      expect(summary.gitHistory).toMatchObject({ edges: 4, mined: 3 });
      const changes = await companionHistory(repo.root)("a.ts", new AbortController().signal);
      expect(changes[0]).toMatchObject({ path: "b.ts", commits: 3, score: 1 });
      const expanded = await expandIssueCompanions(
        "alpha bug",
        [{ path: "a.ts", score: 10, reason: "start" }],
        {
          repo: { files: () => ["a.ts", "b.ts"], read: () => undefined },
          history: companionHistory(repo.root),
        },
      );
      expect(expanded[1]).toMatchObject({ path: "b.ts", reason: "changes together with a.ts" });
      expect(expanded[1].score).toBeLessThan(expanded[0].score);
      const output: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line) => {
        output.push(String(line));
      });
      const cwd = process.cwd();
      try {
        process.chdir(repo.root);
        const coupling = targetCoupling({ name: "a.ts", kind: "file", path: "a.ts" });
        expect(coupling?.partners[0]).toMatchObject({ path: "b.ts", support: 3 });
        expect(couplingLines(coupling, "llm").join("\n")).toContain("co_change path=b.ts");
        expect(couplingLines(coupling, "text")[0]).toContain("Changes together");
        const program = new Command();
        registerCoupledCommand(program);
        await program.parseAsync(["coupled", "a.ts", "--format=json"], { from: "user" });
      } finally {
        process.chdir(cwd);
      }
      expect(JSON.parse(output.join("\n")).partners[0]).toMatchObject({
        path: "b.ts",
        support: 3,
        confidence: 1,
      });
    } finally {
      await backend.stop();
    }
  });

  it("honours cancellation and retains file evidence when a symbol parser fails", async () => {
    const repo = repository();
    for (let i = 0; i < 3; i++) repo.commit(`pair ${i}`);
    await expect(
      mineHistory(repo.root, undefined, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    const state = await mineHistory(repo.root, undefined, {
      parseFile: () => {
        throw new Error("fixture parser failed");
      },
    });
    expect(coupledFor(couplingIndex(state!), { path: "a.ts" }).partners[0].support).toBe(3);
    expect(state?.symbolSkipped).toBe(6);
  });

  it("never deletes an earlier workspace namespace when the same root is re-keyed", async () => {
    const repo = repository();
    vi.stubEnv("IX_HOME", join(repo.root, ".git", "ix-home"));
    for (let i = 0; i < 3; i++) repo.commit(`pair ${i}`);
    const [, { fileNodeId, symbolNodeId }] = await loadIngestionModules();
    const backend = new FakeBackend({ semantics: "legacy" });
    const client = new IxClient(await backend.start());
    const input = {
      root: repo.root,
      workspaceId: "first-workspace",
      fileNodeId,
      symbolNodeId,
      known: new Map([
        ["a.ts", new Set<string>()],
        ["b.ts", new Set<string>()],
      ]),
      commit: (patch: Parameters<IxClient["commitPatch"]>[0]) => client.commitPatch(patch),
    };
    try {
      await ingestHistory(input);
      const before = backend.graphSignature().edges;
      expect(before).toHaveLength(2);
      await ingestHistory({
        ...input,
        workspaceId: "second-workspace",
        known: new Map([["a.ts", new Set<string>()]]),
      });
      expect(backend.graphSignature().edges).toEqual(before);
      await ingestHistory({ ...input, workspaceId: "second-workspace" });
      expect(backend.graphSignature().edges).toHaveLength(4);
    } finally {
      await backend.stop();
    }
  });
});
