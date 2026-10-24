// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { stitchCallEntry } from "../commands/ingest.js";

describe("stitchCallEntry", () => {
  it("offers a call's own relationship to the cross-repo stitch", () => {
    expect(stitchCallEntry({ predicate: "CALLS", srcName: "use", dstName: "run" }, "src/use.ts"))
      .toEqual({ symbol: "run", caller: "use", callerFilePath: "src/use.ts" });
  });

  it("never offers a receiver-only typed call", () => {
    const rels = [
      { predicate: "CALLS", srcName: "use", dstName: "run" },
      { predicate: "CALLS", srcName: "use", dstName: "Dep.run", receiverType: "Dep", receiverOnly: true },
    ];
    expect(rels.map((r) => stitchCallEntry(r, "src/use.ts")?.symbol).filter(Boolean)).toEqual(["run"]);
  });

  it("skips non-calls and builtin member names", () => {
    expect(stitchCallEntry({ predicate: "IMPORTS", srcName: "use.ts", dstName: "dep" }, "src/use.ts")).toBeUndefined();
    expect(stitchCallEntry({ predicate: "CALLS", srcName: "use", dstName: "forEach" }, "src/use.ts")).toBeUndefined();
  });
});
