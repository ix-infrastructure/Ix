// Copyright 2026 Ix Infrastructure Inc.

/**
 * The renderers that print what the client returns take the client's types
 * (#941), not `any`.
 *
 * Most of this file is checked by `npm run typecheck`, which covers tests: a
 * `@ts-expect-error` line fails the build if the line compiles, and
 * `expectTypeOf` fails it if a type turns back into `any`. The runtime cases
 * show that rows built from the backend's types, unknown fields included, still
 * print as before.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { ExpandResponse, GraphNode, StructuredContext } from "../../client/types.js";
import { formatContext, formatEdgeResults, formatNodes, renderNodesLlm, sliceEdgeResults, type Slice } from "../format.js";
import type { ContextView, NodeRow } from "../output/types.js";

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

const node: GraphNode = {
  id: "0123456789abcdef",
  kind: "function",
  name: "handle",
  attrs: { line_start: 3, line_end: 9 },
  provenance: { sourceUri: "src/a.ts", extractor: "ts", sourceType: "code", observedAt: "t" },
  createdRev: 1,
  createdAt: "t",
  updatedAt: "t",
};

const context: StructuredContext = {
  claims: [],
  conflicts: [{ id: "c", claimA: "a", claimB: "b", reason: "disagree", recommendation: "check" }],
  decisions: [],
  intents: [],
  nodes: [node],
  edges: [],
  metadata: { query: "handle", seedEntities: ["0123456789abcdef"], hopsExpanded: 1, asOfRev: 7 },
};

describe("renderers fed by the typed client edge", () => {
  it("take the client's types as they are", () => {
    // What the client returns goes straight in, with no cast.
    expectTypeOf<GraphNode[]>().toMatchTypeOf<NodeRow[]>();
    expectTypeOf<StructuredContext>().toMatchTypeOf<ContextView>();
    expectTypeOf(formatNodes).parameter(0).not.toBeAny();
    expectTypeOf(formatContext).parameter(0).not.toBeAny();
    expectTypeOf(renderNodesLlm).parameter(0).not.toBeAny();
  });

  it("keep the row type through an edge slice", () => {
    const expanded: ExpandResponse = { nodes: [node], edges: [] };
    const slice = sliceEdgeResults(expanded.nodes, 10);
    expectTypeOf(slice).toEqualTypeOf<Slice<GraphNode>>();
    expect(slice.rows).toEqual([node]);
  });

  it("reject rows that are missing what they print", () => {
    // @ts-expect-error a search row prints its kind and id, so both are required
    const noKind = () => formatNodes([{ id: "x" }], "json");
    // @ts-expect-error a context header prints the query metadata
    const noMetadata = () => formatContext({ claims: [] }, "json");
    // @ts-expect-error an edge row's name is a string, not a number
    const badName = () => sliceEdgeResults([{ name: 7 }], 10);
    expect([noKind, noMetadata, badName]).toHaveLength(3);
  });

  it("print a node with unknown extra fields from a newer backend", () => {
    const newer = { ...node, score: 0.9, attrs: { ...node.attrs, visibility: "public" } };
    const llm = renderNodesLlm([newer]);
    expect(llm).toHaveLength(1);
    expect(llm[0]).toContain("handle");
    expect(llm[0]).toContain("src/a.ts");
    expect(capture(() => formatNodes([newer], "text"))).toContain("handle");
    expect(JSON.parse(capture(() => formatNodes([newer], "json")))[0].score).toBe(0.9);
  });

  it("print a context and an edge page built from the client's types", () => {
    const text = capture(() => formatContext(context, "text"));
    expect(text).toContain('Ix Context: "handle"');
    expect(text).toContain("disagree: check");
    const edges = capture(() => formatEdgeResults(sliceEdgeResults([node], 10), "callers", "handle", "json"));
    expect(JSON.parse(edges).results[0]).toMatchObject({ name: "handle", kind: "function", path: "src/a.ts" });
  });

  it("still name a node from attrs as the untyped renderers did", () => {
    // attrs are untyped on the wire. A string or number name prints, as it did
    // when the renderers took any; an empty or object name falls back.
    const withAttrs = (attrs: Record<string, unknown>): GraphNode => ({ ...node, name: "", attrs });
    const [byName, byNumber, byTitle, byObject, empty] = renderNodesLlm([
      withAttrs({ name: "fromAttrs" }),
      withAttrs({ name: 42 }),
      withAttrs({ name: "", title: "Titled" }),
      withAttrs({ name: { first: "x" } }),
      withAttrs({}),
    ]);
    expect(byName).toContain("name=fromAttrs");
    expect(byNumber).toContain("name=42");
    expect(byTitle).toContain("name=Titled");
    expect(byObject).toContain("(unnamed)");
    expect(empty).toContain("(unnamed)");
    expect(capture(() => formatNodes([withAttrs({ name: 42 })], "text"))).toContain("42");

    const edges = capture(() => formatEdgeResults(sliceEdgeResults([withAttrs({ name: 42 })], 10), "callers", "handle", "json"));
    expect(JSON.parse(edges).results[0]).toMatchObject({ name: "42" });
  });

  it("treat a non-string path as absent instead of throwing", () => {
    // Before the typed edge a numeric path reached relativePath and threw.
    const odd: GraphNode = { ...node, provenance: { ...node.provenance, sourceUri: 5 as unknown as string }, attrs: { path: "src/b.ts" } };
    expect(renderNodesLlm([odd])[0]).toContain("src/b.ts");
  });
});
