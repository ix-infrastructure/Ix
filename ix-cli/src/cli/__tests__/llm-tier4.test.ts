import { describe, it, expect } from "vitest";
import { renderConflictsLlm, renderDiffLlm } from "../format.js";
import { renderEntityLlm } from "../commands/entity.js";
import { renderLocateLlm } from "../commands/locate.js";

describe("renderEntityLlm", () => {
  it("emits an entity header and one edge row per edge", () => {
    const lines = renderEntityLlm({
      node: { id: "abcdef1234567890", kind: "class", name: "Foo", createdRev: 3, provenance: { sourceUri: "src/a.ts" } },
      claims: [],
      edges: [{ predicate: "CONTAINS", dst: "deadbeef00000000" }],
    });
    expect(lines[0]).toBe("entity id=abcdef1234567890 kind=class name=Foo path=src/a.ts rev=3 edges=1");
    expect(lines[1]).toBe("edge pred=CONTAINS dst=deadbeef");
  });
});

describe("renderConflictsLlm", () => {
  it("emits a header then one conflict record (quoting where needed)", () => {
    const lines = renderConflictsLlm([{ reason: "contradiction", recommendation: "fix it", claimA: "a1", claimB: "b1" }]);
    expect(lines).toEqual([
      "conflicts count=1",
      'conflict reason=contradiction recommendation="fix it" claim_a=a1 claim_b=b1',
    ]);
  });
});

describe("renderDiffLlm", () => {
  it("emits a header then one change record, reading removed nodes from atFromRev", () => {
    const lines = renderDiffLlm({
      fromRev: 1, toRev: 5,
      changes: [
        { changeType: "added", atToRev: { name: "Foo", kind: "class" }, summary: "new class" },
        { changeType: "removed", atFromRev: { name: "Bar", kind: "method" } },
      ],
    });
    expect(lines[0]).toBe("diff from=1 to=5 changes=2");
    expect(lines[1]).toBe('change type=added kind=class name=Foo summary="new class"');
    expect(lines[2]).toBe("change type=removed kind=method name=Bar");
  });
});

describe("renderLocateLlm", () => {
  it("emits a locate record with line range, container, and system path", () => {
    const lines = renderLocateLlm({
      resolvedTarget: { id: "abcdef1234567890", kind: "function", name: "verify", path: "src/a.ts" },
      resolutionMode: "scored",
      lineRange: { start: 10, end: 20 },
      container: { kind: "class", name: "Auth", id: "x" },
      systemPath: [{ name: "Auth", kind: "subsystem" }],
      hasMapData: true,
      diagnostics: [],
    } as any, "verify");
    expect(lines[0]).toBe('locate target=verify kind=function id=abcdef12 path=src/a.ts line_start=10 line_end=20 contained_in="class Auth" system_path=Auth mode=scored');
  });

  it("emits a structured error when nothing resolves", () => {
    const lines = renderLocateLlm({ resolvedTarget: null, resolutionMode: "none", systemPath: null, diagnostics: ["No graph entity found."] } as any, "foo");
    expect(lines).toEqual(['error code=unknown_target message="No graph entity found for \\"foo\\"."']);
  });
});
