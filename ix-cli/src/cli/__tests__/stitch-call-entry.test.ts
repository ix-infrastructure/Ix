// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { stitchCallEntry } from "../commands/ingest.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";

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

  it("keeps Python module and member calls when their receivers are typed", async () => {
    const [{ parseFile }] = await loadIngestionModules();
    const parsed = parseFile("/repo/app/use.py", [
      "import sharedlib",
      "from sharedlib import client",
      "from sharedlib.models import Model",
      "",
      "def use():",
      "    sharedlib.helper()",
      "    client.fetch()",
      "    item = Model()",
      "    item.save()",
      "",
    ].join("\n"));
    const symbols = parsed.relationships
      .map((r: Record<string, unknown>) => stitchCallEntry(r, "app/use.py")?.symbol)
      .filter(Boolean);
    // The receiver typing only adds relationships: every name a consumer
    // repo's call offers to the stitch is still there.
    expect(symbols).toEqual(expect.arrayContaining(["helper", "sharedlib.helper", "fetch", "client.fetch", "Model", "save", "Model.save"]));
    expect(parsed.relationships).toContainEqual(expect.objectContaining({ dstName: "Model.save", receiverType: "sharedlib.models.Model" }));
  });

  it("skips non-calls and builtin member names", () => {
    expect(stitchCallEntry({ predicate: "IMPORTS", srcName: "use.ts", dstName: "dep" }, "src/use.ts")).toBeUndefined();
    expect(stitchCallEntry({ predicate: "CALLS", srcName: "use", dstName: "forEach" }, "src/use.ts")).toBeUndefined();
  });
});
