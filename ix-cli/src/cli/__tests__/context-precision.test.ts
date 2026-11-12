// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync, readdirSync } from "node:fs";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { buildBundle, clampBudgets, detectContextModeConflict, registerContextCommand, renderBundle, saveInvestigation } from "../commands/context.js";
import type { ContextFacts } from "../explain/facts.js";
import { bundleContextCandidates, leanContextCandidates, selectContextItems } from "../precise-context.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createIxMcpServer } from "../../mcp/server.js";
import { planIssue, rankIssueFiles } from "../explain/issue.js";

// Use the checked-in polyglot project's real source and definition locations.
// These are normalized collector inputs, not an invented backend response.
const path = "web/src/math.ts";
const source = readFileSync(new URL("../../../test/e2e/fixtures/polyglot/web/src/math.ts", import.meta.url), "utf8");
const members = [...source.matchAll(/^export function (\w+).*?^}/gms)].map((m) => ({
  id: m[1], name: m[1], kind: "function", path,
  lineStart: source.slice(0, m.index).split("\n").length,
  lineEnd: source.slice(0, m.index! + m[0].length).split("\n").length,
}));

function fixture() {
  const facts = {
    id: "math", name: "math.ts", kind: "file", path,
    members: members.map((m) => m.name), memberRefs: members, memberCount: members.length,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [], historyLength: 0, stale: false, diagnostics: [],
  } as ContextFacts;
  return buildBundle({
    resolved: { id: facts.id, name: facts.name, kind: facts.kind, resolutionMode: "exact" }, facts,
    context: { claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [], metadata: {} } as never,
    provenance: {}, budgets: clampBudgets({}), isStale: () => false,
  });
}

const web = new URL("../../../test/e2e/fixtures/polyglot/web/src/", import.meta.url);
const definitions = readdirSync(web).flatMap((file) => {
  const text = readFileSync(new URL(file, web), "utf8");
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    const name = /^export (?:async )?(?:function|class|interface|const|type) (\w+)/.exec(line)?.[1];
    return name ? [{ name, path: `web/src/${file}`, lineStart: i + 1,
      lineEnd: Math.min(i + 3, lines.length), confidence: 0.8, reason: `definition ${name}` }] : [];
  });
});

describe("precise context output", () => {
  it("returns only bounded, justified, ranged items in JSON and LLM", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderBundle(fixture(), "json");
      const result = JSON.parse(out.mock.calls.flat().join("\n"));
      expect(result.items).toBeInstanceOf(Array);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.length).toBeLessThanOrEqual(8);
      for (const item of result.items) {
        expect(item.reason).toBeTruthy();
        expect(item.confidence).toBeGreaterThanOrEqual(0.55);
        expect(item.span).toMatch(/^web\/src\/math.ts:\d+-\d+$/);
        expect(item.lineEnd).toBeGreaterThanOrEqual(item.lineStart);
      }
      out.mockClear();
      renderBundle(fixture(), "llm");
      const lines = out.mock.calls.flat().join("\n").split("\n");
      const items = lines.filter((l) => l.startsWith("item "));
      expect(items).toHaveLength(result.items.length);
      expect(items.every((l) => l.includes("reason=") && l.includes("confidence=") && l.includes("span="))).toBe(true);
    } finally { out.mockRestore(); }
  });

  it("pages all eligible fixture definitions once, and binds cursors to the ranking", () => {
    expect(definitions.length).toBeGreaterThan(8);
    const first = selectContextItems(definitions);
    expect(first.items).toHaveLength(8);
    const items = [...first.items];
    let cursor = first.selection.cursor;
    while (cursor) {
      const page = selectContextItems(definitions, { cursor, limit: 3 });
      items.push(...page.items);
      cursor = page.selection.cursor;
    }
    expect(items).toHaveLength(definitions.length);
    expect(new Set(items.map((item) => item.span)).size).toBe(items.length);
    expect(() => selectContextItems(definitions.slice(1), { cursor: first.selection.cursor })).toThrow(/expired/);
    expect(() => selectContextItems(definitions, { cursor: "1" })).toThrow(/cursor/);
    expect(() => selectContextItems(definitions, { limit: 0 })).toThrow(/1 to 50/);
  });

  it("drops weak/unlocated candidates, deduplicates spans and bounds large definitions", () => {
    const [real] = definitions;
    const result = selectContextItems([
      { ...real, confidence: 0.4 }, { ...real, lineStart: undefined, lineEnd: undefined },
      { ...real, confidence: 0.9 }, real,
      { ...real, path: "web/src/large.ts", lineStart: 10, lineEnd: 1000 },
    ]);
    expect(result.items.map((i) => i.confidence)).toEqual([0.9, 0.8]);
    expect(result.selection.belowConfidence).toBe(1);
    expect(result.selection.missingSpan).toBe(1);
    expect(result.items[1].lineEnd).toBe(129);
  });

  it("reduces a page to its character budget without losing the continuation", () => {
    const page = selectContextItems(definitions, { maxChars: 1000 });
    expect(page.items.length).toBeLessThan(8);
    expect(page.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(page, null, 2).length).toBeLessThanOrEqual(1000);
    expect(page.selection.cursor).toBeTruthy();
    const next = selectContextItems(definitions, { cursor: page.selection.cursor });
    expect(next.items[0].span).not.toBe(page.items[0].span);
  });

  it("does not spend source reads on weak lexical matches", () => {
    const read = vi.fn(() => source);
    const candidates = leanContextCandidates({ confidence: "high", unresolved: [], startingPoints: [],
      alsoRanked: [{ path, score: 10, reason: "bm25 10" }, { path: "web/src/format.ts", score: 1, reason: "bm25 1" }] }, { read });
    const page = selectContextItems(candidates);
    expect(page.items).toHaveLength(1);
    expect(page.selection.belowConfidence).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("ranks named issue definitions before direct relations and covering tests", () => {
    const bundle = fixture();
    const [caller, start, test] = members;
    bundle.issue = { startingPoints: [{ ...start, token: start.name, via: "identifier in issue" }], unresolved: [], fallback: false };
    bundle.relationships = [
      { src: start.id, dst: caller.id, predicate: "CONTAINS" },
      { src: caller.id, dst: start.id, predicate: "CALLS" },
      { src: test.id, dst: start.id, predicate: "CALLS" },
    ];
    bundle.entities.find((e) => e.id === test.id)!.path = "web/src/math.test.ts";
    const page = selectContextItems(bundleContextCandidates(bundle));
    expect(page.items.slice(0, 3).map((i) => i.name)).toEqual([start.name, caller.name, test.name]);
    expect(page.items[0].reason).toContain(start.name);
    expect(page.items[1].reason).toContain("CALLS");
    expect(page.items[1].confidence).toBeGreaterThan(page.items[2].confidence);
  });

  it("uses a real source excerpt for a file start and names matched issue terms", () => {
    const candidates = leanContextCandidates({ confidence: "high", unresolved: [], startingPoints: [],
      alsoRanked: [{ path, score: 2, reason: "bm25 2" }] },
    { read: () => source, issueQuery: "clamp fails at the low bound" });
    const page = selectContextItems(candidates);
    expect(page.items[0]).toMatchObject({ path, lineStart: 9, lineEnd: 11 });
    expect(page.items[0].reason).toContain("clamp");
  });

  it("keeps compact pagination separate from legacy artifacts and text", () => {
    expect(detectContextModeConflict({ format: "llm", limit: 3 }, "math.ts")).toBeUndefined();
    for (const opts of [{ full: true }, { out: "bundle.json" }, { save: "x" }, { list: true }, { diff: "x" }, { format: "text" }]) {
      expect(detectContextModeConflict({ format: "llm", cursor: "cursor", ...opts })).toMatch(/compact JSON/);
    }
  });

  it("resumes the versioned saved bundle as compact output, with --full compatibility", async () => {
    saveInvestigation("precision", fixture());
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const program = () => { const cmd = new Command().exitOverride(); registerContextCommand(cmd); return cmd; };
      await program().parseAsync(["context", "--resume", "precision", "--format", "json", "--limit", "1"], { from: "user" });
      expect(JSON.parse(out.mock.calls.flat().join("\n"))).toMatchObject({ schema: "ix-context/1", selection: { returned: 1 } });
      out.mockClear();
      await program().parseAsync(["context", "--resume", "precision", "--format", "json", "--full"], { from: "user" });
      expect(JSON.parse(out.mock.calls.flat().join("\n")).bundle.schema).toBe("ix-context-bundle/1");
    } finally { out.mockRestore(); }
  });

  it("MCP accepts compact structured output and forwards pagination without shell parsing", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    let stdout: string;
    try { renderBundle(fixture(), "json"); stdout = out.mock.calls.flat().join("\n"); }
    finally { out.mockRestore(); }
    const calls: string[][] = [];
    const server = createIxMcpServer({ version: "test", runIx: async (args) => {
      calls.push(args); return { ok: true, stdout, stderr: "" };
    } });
    const client = new Client({ name: "precision-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "ix_context", arguments: { target: "math.ts", structured: true, limit: 2, cursor: "2.0123456789abcdef" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ schema: "ix-context/1" });
      expect(calls[0]).toContain("--limit=2");
      expect(calls[0]).toContain("--cursor=2.0123456789abcdef");
    } finally { await client.close(); await server.close(); }
  });

  it("measures before/after precision and F@5 on the existing polyglot fixture set", async () => {
    const { contextPrecisionComparison } = await import(new URL("../../../../bench/agent-eval/precision.mjs", import.meta.url).href);
    const root = new URL("../../../test/e2e/fixtures/polyglot/", import.meta.url);
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((p) => /\.(?:ts|py|java)$/.test(p));
    const texts = new Map(files.map((p) => [p, readFileSync(new URL(p, root), "utf8")]));
    const repo = { files: () => files, read: (p: string) => texts.get(p), grep: () => [] };
    const tasks = [
      { query: "web/src/math.ts clamp returns a value outside its bounds", gold: "web/src/math.ts" },
      { query: "app/services.py charge creates the wrong order amount", gold: "app/services.py" },
      { query: "web/src/store.ts state update is lost", gold: "web/src/store.ts" },
      { query: "server/src/main/java/com/example/GreetingService.java greeting is wrong", gold: "server/src/main/java/com/example/GreetingService.java" },
    ];
    const totals = { beforeReturned: 0, beforeActed: 0, afterReturned: 0, afterActed: 0, beforeF5: 0, afterF5: 0 };
    for (const { query, gold } of tasks) {
      const plan = await planIssue(query, { repo, search: async () => [] });
      const ranked = rankIssueFiles({ starts: plan.starts, bm25: plan.bm25, near: new Map(), sourcePaths: plan.sourcePaths });
      const page = selectContextItems(leanContextCandidates({ confidence: "high", startingPoints: plan.starts,
        alsoRanked: ranked, unresolved: [] }, { read: repo.read, issueQuery: query }));
      const { before, after } = contextPrecisionComparison(ranked.map((f) => f.path), page.items, [gold]);
      expect(after.file_recall_at_5).toBeGreaterThanOrEqual(before.file_recall_at_5);
      totals.beforeReturned += before.items_returned; totals.beforeActed += before.items_acted_on;
      totals.afterReturned += after.items_returned; totals.afterActed += after.items_acted_on;
      totals.beforeF5 += before.file_recall_at_5; totals.afterF5 += after.file_recall_at_5;
    }
    console.info("polyglot fixture precision (4 labeled file tasks; not SWE-PolyBench):", JSON.stringify(totals));
    expect(totals.afterActed / totals.afterReturned).toBeGreaterThanOrEqual(totals.beforeActed / totals.beforeReturned);
  });
});
