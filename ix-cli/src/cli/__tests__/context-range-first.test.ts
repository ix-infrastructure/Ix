// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { nextReads } from "../commands/context.js";

function bundleWith(evidence: Array<Record<string, unknown>>): never {
  return { evidence } as never;
}

function row(title: string, path?: string, lineStart?: number, lineEnd?: number) {
  return {
    id: title, kind: "structural", source: "facts.members", title, score: 10, reason: "", refs: [],
    ...(path ? { location: { path, lineStart, lineEnd } } : {}),
  };
}

describe("nextReads", () => {
  it("hands back ready-to-run commands, in evidence order", () => {
    expect(
      nextReads(bundleWith([
        row("target", "src/a.ts", 15, 27),
        row("caller", "src/b.ts", 17, 145),
      ])),
    ).toEqual([
      "ix read src/a.ts:15-27",
      "ix read src/b.ts:17-145",
    ]);
  });

  it("stops at three, so the closing instruction stays a closing instruction", () => {
    const reads = nextReads(bundleWith(
      [1, 2, 3, 4, 5].map((n) => row(`m${n}`, `src/${n}.ts`, n, n + 10)),
    ));
    expect(reads).toHaveLength(3);
  });

  it("does not repeat a range a caller and a dependent both name", () => {
    // The same function arrives twice in most bundles, once per relation.
    expect(
      nextReads(bundleWith([
        row("caller handleLogin", "src/b.ts", 17, 145),
        row("dependent handleLogin", "src/b.ts", 17, 145),
        row("member parse", "src/c.ts", 4, 9),
      ])),
    ).toEqual([
      "ix read src/b.ts:17-145",
      "ix read src/c.ts:4-9",
    ]);
  });

  it("skips a row that has no range, rather than emitting a whole-file read", () => {
    // A file entity carries a path and no span on purpose. Turning that into
    // `ix read src/huge.ts` is exactly the 34-61k-character read this is here
    // to avoid.
    expect(
      nextReads(bundleWith([
        row("container config.ts (file)", "src/huge.ts"),
        row("member parse", "src/c.ts", 4, 9),
      ])),
    ).toEqual(["ix read src/c.ts:4-9"]);
  });

  it("says nothing when nothing in the bundle is ranged", () => {
    expect(nextReads(bundleWith([row("a"), row("b", "src/x.ts")]))).toEqual([]);
  });
});
