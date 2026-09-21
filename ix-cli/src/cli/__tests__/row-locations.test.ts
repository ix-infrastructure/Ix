// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";

import {
  formatEdgeResults,
  formatNodes,
  lineSpan,
  locationLabel,
  renderEdgeResultsLlm,
  rowLocation,
  sliceEdgeResults,
} from "../format.js";
import { renderExplainLlm } from "../explain/llm.js";
import { renderEntityLlm } from "../commands/entity.js";
import type { EntityFacts } from "../explain/facts.js";

function node(over: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-1111-0000-0000-000000000000",
    name: "registerCallersCommand",
    kind: "function",
    attrs: { line_start: 17, line_end: 145 },
    provenance: { source_uri: "ix-cli/src/cli/commands/callers.ts" },
    ...over,
  };
}

function captured(fn: () => void): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

describe("rowLocation", () => {
  it("reads the path and span off the node the row was built from", () => {
    expect(rowLocation(node())).toEqual({
      path: "ix-cli/src/cli/commands/callers.ts",
      lineStart: 17,
      lineEnd: 145,
    });
  });

  it("gives a file no span, because its span is the file", () => {
    expect(rowLocation(node({ kind: "file", name: "callers.ts" }))).toEqual({
      path: "ix-cli/src/cli/commands/callers.ts",
    });
  });

  it("ignores a line number that is not one", () => {
    expect(rowLocation(node({ attrs: { line_start: 0, line_end: "12" } }))).toEqual({
      path: "ix-cli/src/cli/commands/callers.ts",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("collapses a one-line entity to a single number", () => {
    expect(lineSpan({ lineStart: 9, lineEnd: 9 })).toBe("9");
    expect(lineSpan({ lineStart: 9, lineEnd: 12 })).toBe("9-12");
    expect(lineSpan({})).toBeUndefined();
    expect(locationLabel({ path: "a.ts", lineStart: 9, lineEnd: 12 })).toBe("a.ts:9-12");
    expect(locationLabel({ path: "a.ts" })).toBe("a.ts");
    expect(locationLabel({})).toBe("");
  });
});

describe("edge results", () => {
  it("put a span on every row that has one", () => {
    const lines = renderEdgeResultsLlm(sliceEdgeResults([node()], 50), "callers", "relativePath", "graph");
    expect(lines[1]).toBe(
      "ref name=registerCallersCommand kind=function id=aaaaaaaa path=ix-cli/src/cli/commands/callers.ts lines=17-145",
    );
  });

  it("carry the numbers into json, where a program can use them", () => {
    const out = captured(() =>
      formatEdgeResults(sliceEdgeResults([node()], 50), "callers", "relativePath", "json"),
    );
    const payload = JSON.parse(out[0]);
    expect(payload.results[0]).toMatchObject({
      name: "registerCallersCommand",
      path: "ix-cli/src/cli/commands/callers.ts",
      lineStart: 17,
      lineEnd: 145,
    });
  });

  it("show the place on the text row too", () => {
    const out = captured(() =>
      formatEdgeResults(sliceEdgeResults([node()], 50), "callers", "relativePath", "text"),
    );
    expect(out.join("\n")).toContain("ix-cli/src/cli/commands/callers.ts:17-145");
  });
});

describe("search text rows", () => {
  it("name a place, not just a word", () => {
    // Four modules called `config.ts` answered `ix search config` with four
    // rows that differed in nothing a caller could choose by.
    const out = captured(() => formatNodes([node({ name: "config.ts", kind: "module" })], "text"));
    expect(out[0]).toContain("ix-cli/src/cli/commands/callers.ts:17-145");
  });
});

describe("ix entity", () => {
  it("says where inside the file the entity is", () => {
    const lines = renderEntityLlm({ node: node(), edges: [] });
    expect(lines[0]).toContain("lines=17-145");
  });
});

const role = { role: "shared-utility", confidence: "medium" } as never;
const importance = { level: "medium", category: "normal" } as never;
const prose = {
  explanation: "e", context: "c", whyItMatters: "w", notes: [],
  usedBy: "Used by registerCallersCommand, and 1 other.",
  usedByIsNameList: true,
};

function facts(over: Partial<EntityFacts> = {}): EntityFacts {
  return {
    id: "e1", name: "relativePath", kind: "function", path: "ix-cli/src/cli/format.ts",
    members: [], memberCount: 0,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    downstreamDependents: 0, downstreamDepth: 0,
    topCallers: [], topDependents: [],
    historyLength: 0, stale: false, diagnostics: [],
    ...over,
  } as EntityFacts;
}

describe("ix explain", () => {
  const located = facts({
    topCallers: ["registerCallersCommand"],
    topCallerRefs: [{
      id: "c1", name: "registerCallersCommand", kind: "function",
      path: "ix-cli/src/cli/commands/callers.ts", lineStart: 17, lineEnd: 145,
    }],
    topDependents: ["registerCallersCommand"],
    topDependentRefs: [{
      id: "c1", name: "registerCallersCommand", kind: "function",
      path: "ix-cli/src/cli/commands/callers.ts", lineStart: 17, lineEnd: 145,
    }],
  });

  it("names a thing that is both a caller and a dependent once", () => {
    const lines = renderExplainLlm(located, role, importance, prose);
    const uses = lines.filter((l) => l.startsWith("uses "));
    expect(uses).toEqual([
      "uses name=registerCallersCommand rel=caller,dependent path=ix-cli/src/cli/commands/callers.ts lines=17-145",
    ]);
    expect(lines.filter((l) => l.startsWith("caller ") || l.startsWith("dependent "))).toEqual([]);
  });

  it("drops the generated used_by sentence, which is those names a third time", () => {
    const lines = renderExplainLlm(located, role, importance, prose);
    expect(lines.some((l) => l.startsWith("used_by "))).toBe(false);
  });

  it("keeps a used_by that says something the rows do not", () => {
    const lines = renderExplainLlm(located, role, importance, {
      ...prose,
      usedBy: "Every ingest path reaches this through the parse pool.",
      usedByIsNameList: false,
    });
    expect(lines).toContain('used_by text="Every ingest path reaches this through the parse pool."');
  });

  it("locates member rows", () => {
    const lines = renderExplainLlm(
      facts({
        members: ["getEndpoint"],
        memberRefs: [{ id: "m1", name: "getEndpoint", kind: "function", path: "ix-cli/src/cli/config.ts", lineStart: 198, lineEnd: 200 }],
        memberCount: 1,
      }),
      role, importance, prose,
    );
    expect(lines).toContain("member name=getEndpoint path=ix-cli/src/cli/config.ts lines=198-200");
  });

  it("still emits a row when the facts carry no location for it", () => {
    const lines = renderExplainLlm(facts({ topCallers: ["mystery"] }), role, importance, prose);
    expect(lines).toContain("uses name=mystery rel=caller");
  });
});
