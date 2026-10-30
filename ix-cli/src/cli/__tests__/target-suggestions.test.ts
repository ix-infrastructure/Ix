// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IxClient } from "../../client/api.js";
import { findTargetCandidates, SUGGEST_MAX_MS, SUGGEST_MAX_REQUESTS, SUGGEST_MAX_ROWS } from "../target-suggestions.js";

const node = (name: string, path = "src/sample.ts", kind = "function") => ({
  id: `${name}:${path}`, name, kind, attrs: { line_start: 7 }, provenance: { sourceUri: path },
});
function graph(nodes: ReturnType<typeof node>[]) {
  const search = vi.fn(async (term: string, opts?: { limit?: number; kind?: string }) =>
    nodes.filter((n) => n.name.toLowerCase().includes(term.toLowerCase()) && (!opts?.kind || n.kind === opts.kind)).slice(0, opts?.limit));
  return { search } as unknown as Pick<IxClient, "search"> & { search: typeof search };
}
const options = { suggestCommand: "locate", workspaceId: "workspace-test", systemId: "system-test" };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded unresolved-target candidates", () => {
  it.each([
    ["case-insensitive exact", "PARSER", "parser"],
    ["qualified last segment", "Missing.parseConfig", "parseConfig"],
    ["qualified double colon", "Missing::parseConfig", "parseConfig"],
    ["snake to camel", "parse_config", "parseConfig"],
    ["camel to snake", "parseConfig", "parse_config"],
    ["prefix", "parse", "parseConfig"],
    ["suffix", "Config", "parseConfig"],
    ["two edits", "parseConifg", "parseConfig"],
    ["short name", "xy", "xz"],
  ])("finds %s", async (_strategy, target, name) => {
    const result = await findTargetCandidates(graph([node(name)]), target, options, 200);
    expect(result.didYouMean).toEqual([{ name, kind: "function", path: "src/sample.ts", line: 7 }]);
    expect(result.retryCommand).toBe(`ix locate '${name}' --path 'src/sample.ts'`);
  });

  it("never sends an empty term, whose /v1/search meaning is undocumented", async () => {
    const client = graph([node("bcdf")]);
    // Neither half of the name matches: only a match-all window would find it.
    const result = await findTargetCandidates(client, "bxdg", options, 200);
    expect(client.search.mock.calls.map(([term]) => term)).not.toContain("");
    expect(client.search.mock.calls.length).toBeLessThanOrEqual(SUGGEST_MAX_REQUESTS);
    expect(result.didYouMean).toEqual([]);
  });

  it("ranks strategies in order, deduplicates index responses and caps at five", async () => {
    const nodes = ["parseconfig", "parse_config", "parseConfigExtra", "extraParseConfig", "parseConifg", "parseConfg", "parseCongif"].map((name) => node(name));
    nodes.push(node("parseconfig", "src/sample.ts", "chunk"));
    const result = await findTargetCandidates(graph(nodes), "PARSECONFIG", options, 200);
    expect(result.didYouMean.map((c) => c.name)).toEqual([
      "parseconfig", "parse_config", "extraParseConfig", "parseConfigExtra", "parseConfg",
    ]);
    expect(result.retryCommand).toContain("'parseconfig'");
  });

  it("does not recommend a retry for equal best names in different files", async () => {
    const result = await findTargetCandidates(graph([node("parseConfig", "src/a.ts"), node("parseConfig", "src/b.ts")]), "parse_config", options, 200);
    expect(result.didYouMean).toHaveLength(2);
    expect(result.retryCommand).toBeUndefined();
  });

  it("keeps close edit scores ambiguous and rejects distances above two", async () => {
    const result = await findTargetCandidates(graph([node("abcdx"), node("abcyx"), node("axyzz")]), "abcde", options, 200);
    expect(result.didYouMean.map((c) => c.name)).toEqual(["abcdx", "abcyx"]);
    expect(result.retryCommand).toBeUndefined();
  });

  it.each(["old/config.ts", "other\\src\\config.ts", "config.ts"])("suggests moved file %s by basename", async (target) => {
    const result = await findTargetCandidates(graph([node("config.ts", "new/config.ts", "file")]), target, { ...options, fileTarget: true }, 200);
    expect(result.didYouMean[0]?.path).toBe("new/config.ts");
    expect(result.retryCommand).toBe("ix locate 'new/config.ts' --path 'new/config.ts'");
  });

  it("prefers a path suffix across workspace roots to an unrelated basename", async () => {
    const result = await findTargetCandidates(graph([
      node("config.ts", "project/src/config.ts", "file"), node("config.ts", "lib/config.ts", "file"),
    ]), "workspace/src/config.ts", { ...options, fileTarget: true }, 200);
    expect(result.didYouMean.map((c) => c.path)).toEqual(["project/src/config.ts", "lib/config.ts"]);
    expect(result.retryCommand).toContain("'project/src/config.ts'");
  });

  it("escapes shell metacharacters in a ready-to-run retry", async () => {
    const result = await findTargetCandidates(graph([node("parseConfig", "src/it's $(example).ts")]), "parse_config", options, 200);
    expect(result.retryCommand).toBe("ix locate 'parseConfig' --path 'src/it'\\''s $(example).ts'");
  });

  it("uses stable null location fields when the name index has no location", async () => {
    const client = graph([]);
    client.search.mockResolvedValue([{ id: "sample", name: "Sample", kind: "class" }] as any);
    expect((await findTargetCandidates(client, "sample", options, 200)).didYouMean)
      .toEqual([{ name: "Sample", kind: "class", path: null, line: null }]);
  });

  it("bounds requests and rows even if a server ignores the limit", async () => {
    const client = graph([]);
    client.search.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => node(`parseConfig${i}`)));
    const result = await findTargetCandidates(client, "parse_config", options, 200);
    expect(client.search.mock.calls.length).toBeLessThanOrEqual(SUGGEST_MAX_REQUESTS);
    expect(client.search.mock.calls.reduce((total, [, opts]) => total + (opts?.limit ?? 0), 0)).toBeLessThanOrEqual(SUGGEST_MAX_ROWS);
    expect(result.didYouMean).toHaveLength(5);
    for (const [, opts] of client.search.mock.calls) {
      expect(opts).toMatchObject({ nameOnly: true, workspaceId: "workspace-test", systemId: "system-test" });
    }
  });

  it.each([40, 1000])("aborts hung probes within half a %dms miss, capped at 100ms", async (missMs) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const client = graph([]);
    client.search.mockImplementation(() => new Promise(() => {}));
    const pending = findTargetCandidates(client, "Missing", options, missMs);
    const budget = Math.min(missMs / 2, SUGGEST_MAX_MS);
    await vi.advanceTimersByTimeAsync(budget);
    expect(await pending).toEqual({ didYouMean: [] });
    expect(performance.now()).toBe(budget);
    expect((client.search.mock.calls[0][1] as any).signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns completed probes when another probe hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const client = graph([]);
    client.search.mockImplementation((term) => term === "parse" ? Promise.resolve([node("parseConfig")]) : new Promise(() => {}));
    const pending = findTargetCandidates(client, "parse_config", options, 200);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).didYouMean[0]?.name).toBe("parseConfig");
  });

  it("does no work when disabled, out of budget, or given an oversized name", async () => {
    const client = graph([]);
    expect(await findTargetCandidates(client, "Missing", { ...options, suggest: false }, 200)).toEqual({ didYouMean: [] });
    expect(await findTargetCandidates(client, "Missing", options, 0)).toEqual({ didYouMean: [] });
    expect(await findTargetCandidates(client, "x".repeat(129), options, 200)).toEqual({ didYouMean: [] });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("ignores probe errors and filters kinds even on an older server", async () => {
    const client = graph([]);
    client.search.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue([
      node("parseConfig", "src/a.ts", "function"), node("parseConfig", "src/b.ts", "class"),
    ]);
    const result = await findTargetCandidates(client, "parse_config", { ...options, kind: "function" }, 200);
    expect(result.didYouMean).toHaveLength(1);
    expect(result.didYouMean[0].kind).toBe("function");
  });
});
