import { describe, it, expect } from "vitest";
import { applyPick, type ResolveResult, type AmbiguousResult } from "../resolve.js";

function makeAmbiguousResult(count: number): ResolveResult & { resolved: false; ambiguous: true } {
  const candidates: AmbiguousResult["candidates"] = [];
  for (let i = 0; i < count; i++) {
    candidates.push({
      id: `id-${i}`,
      name: `name-${i}`,
      kind: "function",
      path: `/src/file-${i}.ts`,
      score: i * 10,
      rank: i + 1,
    });
  }
  return {
    resolved: false,
    ambiguous: true,
    result: {
      resolutionMode: "ambiguous",
      candidates,
      diagnostics: [{ code: "ambiguous_resolution", message: "Use --pick <n> or --path to disambiguate." }],
    },
  };
}

describe("applyPick", () => {
  it("returns null when pick is not set", () => {
    const result = makeAmbiguousResult(3);
    expect(applyPick(result, {})).toBeNull();
    expect(applyPick(result, undefined)).toBeNull();
  });

  it("returns null when result is already resolved", () => {
    const resolved: ResolveResult = {
      resolved: true,
      entity: { id: "id-0", kind: "function", name: "foo", resolutionMode: "exact" },
    };
    expect(applyPick(resolved, { pick: 1 })).toBeNull();
  });

  it("returns resolved entity for valid pick index", () => {
    const result = makeAmbiguousResult(3);
    const picked = applyPick(result, { pick: 2 });
    expect(picked).not.toBeNull();
    expect(picked!.resolved).toBe(true);
    if (picked!.resolved) {
      expect(picked!.entity.id).toBe("id-1");
      expect(picked!.entity.name).toBe("name-1");
      expect(picked!.entity.kind).toBe("function");
      expect(picked!.entity.path).toBe("/src/file-1.ts");
    }
  });

  it("returns first candidate for pick=1", () => {
    const result = makeAmbiguousResult(3);
    const picked = applyPick(result, { pick: 1 });
    expect(picked).not.toBeNull();
    if (picked!.resolved) {
      expect(picked!.entity.id).toBe("id-0");
    }
  });

  it("returns last candidate for pick=N", () => {
    const result = makeAmbiguousResult(3);
    const picked = applyPick(result, { pick: 3 });
    expect(picked).not.toBeNull();
    if (picked!.resolved) {
      expect(picked!.entity.id).toBe("id-2");
    }
  });

  it("keeps ambiguity and adds a diagnostic for pick=0", () => {
    const result = makeAmbiguousResult(3);
    const picked = applyPick(result, { pick: 0 });
    expect(picked).not.toBeNull();
    expect(picked!.resolved).toBe(false);
    if (!picked!.resolved) {
      expect(picked!.ambiguous).toBe(true);
      if (picked!.ambiguous) {
        expect(picked!.result.diagnostics?.[0]).toEqual({
          code: "pick_out_of_range",
          message: "--pick 0 is out of range (1-3).",
        });
      }
    }
  });

  it("keeps ambiguity and adds a diagnostic for pick > candidates.length", () => {
    const result = makeAmbiguousResult(3);
    const picked = applyPick(result, { pick: 10 });
    expect(picked).not.toBeNull();
    expect(picked!.resolved).toBe(false);
    if (!picked!.resolved) {
      expect(picked!.ambiguous).toBe(true);
      if (picked!.ambiguous) {
        expect(picked!.result.diagnostics?.[0]).toEqual({
          code: "pick_out_of_range",
          message: "--pick 10 is out of range (1-3).",
        });
      }
    }
  });

  it("returns null for non-ambiguous not-found result", () => {
    const result: ResolveResult = { resolved: false, ambiguous: false };
    expect(applyPick(result, { pick: 1 })).toBeNull();
  });
});
