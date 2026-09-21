// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { truncationAdvice } from "../commands/context.js";

function bundle(
  target: { name: string; kind: string },
  cut: Array<{ what: string; count: number }>,
): never {
  return {
    target: { id: "t", resolutionMode: "exact", ...target },
    truncation: {
      entitiesTruncated: 0,
      relationshipsTruncated: 0,
      evidenceTruncated: cut.reduce((n, c) => n + c.count, 0),
      charactersTruncated: 0,
      cut,
    },
  } as never;
}

describe("truncationAdvice", () => {
  it("says nothing when nothing was cut", () => {
    expect(truncationAdvice(bundle({ name: "x", kind: "function" }, []))).toBeUndefined();
  });

  it("names what went, largest first, and pluralises on the count", () => {
    const advice = truncationAdvice(
      bundle({ name: "format.ts", kind: "file" }, [
        { what: "member", count: 36 },
        { what: "import", count: 12 },
        { what: "claim", count: 1 },
      ]),
    );
    expect(advice).toContain("cut: 36 members, 12 imports, 1 claim");
  });

  it("names at most three categories, so the hint stays one line", () => {
    const advice = truncationAdvice(
      bundle({ name: "x", kind: "function" }, [
        { what: "member", count: 4 },
        { what: "import", count: 3 },
        { what: "caller", count: 2 },
        { what: "claim", count: 1 },
      ]),
    );
    expect(advice).not.toContain("claim");
  });

  it("sends a container that lost its members to one of them, not to a bigger budget", () => {
    const advice = truncationAdvice(bundle({ name: "format.ts", kind: "file" }, [{ what: "member", count: 36 }]))!;
    expect(advice).toContain("run ix context on one of them");
    expect(advice).toContain("raise --max-tokens");
  });

  it("sends a symbol to the bounded command that answers the same question", () => {
    const cases: Array<[string, string]> = [
      ["caller", "ix callers verify"],
      ["dependent", "ix impact verify"],
      ["import", "ix imports verify"],
      ["call", "ix callees verify"],
      ["relationship", "ix depends verify"],
      ["claim", "ix conflicts verify"],
    ];
    for (const [what, expected] of cases) {
      const advice = truncationAdvice(bundle({ name: "verify", kind: "function" }, [{ what, count: 9 }]))!;
      expect(advice, what).toContain(expected);
    }
  });

  it("falls back to the one lever that works for anything", () => {
    const advice = truncationAdvice(bundle({ name: "x", kind: "function" }, [{ what: "provenance", count: 1 }]))!;
    expect(advice).toBe("cut: 1 provenance — raise --max-tokens");
  });
});
