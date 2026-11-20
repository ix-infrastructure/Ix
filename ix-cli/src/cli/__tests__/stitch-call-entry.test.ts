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

  it("skips non-calls and builtin member names", () => {
    expect(stitchCallEntry({ predicate: "IMPORTS", srcName: "use.ts", dstName: "dep" }, "src/use.ts")).toBeUndefined();
    expect(stitchCallEntry({ predicate: "CALLS", srcName: "use", dstName: "forEach" }, "src/use.ts")).toBeUndefined();
  });

  it("never offers a member call on a local, a call to a local or a shadowed import (#1020)", () => {
    const call = { predicate: "CALLS", srcName: "use", dstName: "validate" };
    expect(stitchCallEntry({ ...call, memberCall: true }, "src/use.ts")).toBeUndefined();
    expect(stitchCallEntry({ ...call, localCallee: true }, "src/use.ts")).toBeUndefined();
    expect(stitchCallEntry({ ...call, importBinding: false }, "src/use.ts")).toBeUndefined();
    expect(stitchCallEntry({ ...call, importBinding: true }, "src/use.ts")?.symbol).toBe("validate");
  });

  it("offers only the import-bound and namespace calls of a parsed file (#1020)", async () => {
    const [ingestion] = await loadIngestionModules();
    const source = [
      "import { validate } from 'shared-lib';",
      "import * as lib from 'shared-lib';",
      "export function viaParam(conn: { validate(): void }) { conn.validate(); }",
      "export function shadowed(validate: () => void) { validate(); }",
      "export function viaImport() { validate(); }",
      "export function viaNamespace() { lib.check(); }",
      "",
    ].join("\n");
    const parsed = ingestion.parseFile("src/use.ts", source);
    expect(parsed).not.toBeNull();
    const offered = parsed!.relationships
      .map((r) => stitchCallEntry(r, "src/use.ts"))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => `${c.caller}->${c.symbol}`)
      .sort();
    expect(offered).toEqual(["viaImport->validate", "viaNamespace->check"]);
  });
});
