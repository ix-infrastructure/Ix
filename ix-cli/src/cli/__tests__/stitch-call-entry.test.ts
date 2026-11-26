// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { stitchCallEntry, stitchDefKeys } from "../commands/ingest.js";
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
      // A local function of the imported name: the call is that function, not
      // the package's export (importBinding: false, no localCallee).
      "export function localFn() { const validate = () => 1; validate(); }",
      "export function nestedDecl() { function validate() {} validate(); }",
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

describe("stitchDefKeys", () => {
  it("keys a def by its name and, for a member, its qualified key", () => {
    expect(stitchDefKeys({ name: "run" })).toEqual([["run", "run"]]);
    expect(stitchDefKeys({ name: "constructor", container: "Ora" }))
      .toEqual([["constructor", "Ora.constructor"], ["Ora.constructor", "Ora.constructor"]]);
  });

  it("finds the caller of a call inside every Java overload, at that overload's node (#1139)", async () => {
    const [ingestion] = await loadIngestionModules();
    const source = [
      "import ext.Lib;",
      "class Over {",
      "  void handle(String s) { Lib.first(s); }",
      "  void handle(int n) { Lib.second(n); }",
      "  void handle(long n) { Lib.third(n); }",
      "}",
      "",
    ].join("\n");
    const parsed = ingestion.parseFile("src/Over.java", source);
    expect(parsed).not.toBeNull();
    const defs = new Map<string, string>();
    for (const e of parsed!.entities) for (const [key, nodeKey] of stitchDefKeys(e)) defs.set(key, nodeKey);
    const calls = parsed!.relationships
      .map((r) => stitchCallEntry(r, "src/Over.java"))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    const callers = [...new Set(calls.map((c) => c.caller))].sort();
    expect(callers.length).toBe(3);
    // Each caller resolves, to the key its own method node is built from.
    const nodeKeys = new Set(parsed!.entities.filter((e) => e.name === "handle").map((e) => ingestion.entityKey(e)));
    expect(nodeKeys.size).toBe(3);
    for (const caller of callers) {
      expect(defs.get(caller)).toBe(caller);
      expect(nodeKeys.has(caller)).toBe(true);
    }
    // The bare name still points at the first overload's node.
    expect(defs.get("handle")).toBe("Over.handle");
  });
});
