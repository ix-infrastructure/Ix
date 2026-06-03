import { describe, it, expect } from "vitest";
import { renderEdgeResultsLlm } from "../format.js";
import { renderInventoryLlm } from "../commands/inventory.js";
import { renderRankLlm } from "../commands/rank.js";
import { renderDependsLlm, type DependencyNode } from "../commands/depends.js";
import { renderTracePathLlm, renderTraceBothLlm, renderTraceSingleLlm } from "../commands/trace.js";

describe("renderEdgeResultsLlm", () => {
  it("emits a relation header and ref rows, marking unresolved targets", () => {
    const nodes = [
      { id: "abcdef1234567890", name: "handleLogin", kind: "method", provenance: { source_uri: "src/a.ts" } },
      { id: "deadbeef00000000", name: "", kind: "method" },
    ];
    const lines = renderEdgeResultsLlm(nodes, "callers", "verify_token", "graph");
    expect(lines[0]).toBe("callers target=verify_token total=2 resolved=1 unresolved=1");
    expect(lines[1]).toBe("ref name=handleLogin kind=method id=abcdef12 path=src/a.ts");
    expect(lines[2]).toBe("ref kind=method id=deadbeef resolved=false");
  });

  it("emits a no_edges diagnostic when empty", () => {
    const lines = renderEdgeResultsLlm([], "callees", "foo", "graph");
    expect(lines[0]).toBe("callees target=foo total=0 resolved=0");
    expect(lines[1]).toBe('diagnostic code=no_edges message="No callees edges found."');
  });
});

describe("renderInventoryLlm", () => {
  it("groups names per file and lists pathless entities as items", () => {
    const nodes = [
      { name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } },
      { name: "Bar", kind: "class", provenance: { source_uri: "src/a.ts" } },
      { name: "Baz", kind: "class" },
    ];
    const lines = renderInventoryLlm("class", "auth", nodes);
    expect(lines).toEqual([
      "inventory kind=class scope=auth total=3",
      "file path=src/a.ts items=Foo,Bar",
      "item name=Baz kind=class",
    ]);
  });
});

describe("renderRankLlm", () => {
  it("emits a header then one entity row per result (rank = order)", () => {
    const lines = renderRankLlm("dependents", "class", null, [
      { name: "Foo", kind: "class", score: 42 },
      { name: "Bar", kind: "class", score: 10 },
    ], 100, []);
    expect(lines).toEqual([
      "rank metric=dependents kind=class evaluated=100 returned=2",
      "entity name=Foo kind=class score=42",
      "entity name=Bar kind=class score=10",
    ]);
  });
});

describe("renderDependsLlm", () => {
  it("flattens the tree into dep rows with parent= pointing at the target", () => {
    const tree: DependencyNode[] = [{
      id: "child1aa", name: "handleLogin", kind: "method", resolved: true,
      relation: "called_by", sourceEdge: "CALLS", children: [],
    }];
    const lines = renderDependsLlm({ id: "root1234", name: "verify", kind: "function" }, tree, false, 1, 1);
    expect(lines[0]).toBe("depends target=verify kind=function target_id=root1234 semantics=downstream_dependents nodes=1 depth=1");
    expect(lines[1]).toBe("dep name=handleLogin kind=method id=child1aa parent=root1234 rel=called_by");
  });
});

describe("trace llm renderers", () => {
  const node = (over: any) => ({ id: "n1aaaaaa", name: "bar", kind: "method", resolved: true, children: [], ...over });

  it("renderTracePathLlm emits a path with step rows", () => {
    const lines = renderTracePathLlm({ name: "A", kind: "function" }, { name: "B", kind: "function" }, "mixed", [
      { id: "a", name: "A", kind: "function" }, { id: "b", name: "B", kind: "function" },
    ]);
    expect(lines).toEqual([
      "trace mode=path from=A to=B kind=mixed length=2",
      "step name=A kind=function",
      "step name=B kind=function",
    ]);
  });

  it("renderTracePathLlm emits a no_path diagnostic when empty", () => {
    const lines = renderTracePathLlm({ name: "A", kind: "function" }, { name: "B", kind: "function" }, "mixed", []);
    expect(lines[1]).toBe('diagnostic code=no_path message="No route found from A to B."');
  });

  it("renderTraceSingleLlm flattens with parent= and drops infinite depth", () => {
    const lines = renderTraceSingleLlm(
      { id: "root1234", name: "foo", kind: "function" }, "mixed", "upstream", Infinity,
      [node({})], false, 1, 1, Infinity,
    );
    expect(lines[0]).toBe("trace mode=directional target=foo kind=mixed direction=upstream target_id=root1234 nodes=1 max_depth=1");
    expect(lines[0]).not.toContain("depth=Infinity");
    expect(lines[1]).toBe("node name=bar kind=method id=n1aaaaaa parent=root1234");
  });

  it("renderTraceBothLlm emits up/down record streams with per-direction counts", () => {
    const lines = renderTraceBothLlm(
      { id: "root1234", name: "foo", kind: "function" }, "mixed", Infinity,
      { tree: [node({})], nodesVisited: 1, maxDepthReached: 1 },
      { tree: [], nodesVisited: 0, maxDepthReached: 0 },
    );
    expect(lines[0]).toBe("trace mode=directional target=foo kind=mixed direction=both target_id=root1234 up_nodes=1 up_depth=1 down_nodes=0 down_depth=0");
    expect(lines[1]).toBe("up name=bar kind=method id=n1aaaaaa parent=root1234");
  });
});
