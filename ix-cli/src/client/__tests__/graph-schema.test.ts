// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { EDGE_PREDICATES, NODE_KINDS, type NodeKind } from "../graph-schema.js";
import type { PatchOp } from "../types.js";
import { transformCommit, transformIssue, transformIssueComment, transformPR } from "../../cli/github/transform.js";
import * as graphModel from "../../cli/graph-model.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("graph patch schema", () => {
  // The CLI cannot import core-ingestion's source (its rootDir is src/), so it
  // carries a copy. One definition means the copy is the same bytes.
  it("is a byte-identical copy of core-ingestion/src/schema.ts", () => {
    expect(read("../graph-schema.ts")).toBe(read("../../../../core-ingestion/src/schema.ts"));
  });

  it("is what docs/api/openapi.yaml documents", () => {
    const schemas = (parse(read("../../../../docs/api/openapi.yaml")) as {
      components: { schemas: Record<string, { enum?: string[]; oneOf?: { $ref: string }[];
        discriminator?: { mapping: Record<string, string> }; properties?: { type?: { enum?: string[] } } }> };
    }).components.schemas;
    expect(schemas.NodeKind!.enum).toEqual([...NODE_KINDS]);
    expect(schemas.EdgePredicate!.enum).toEqual([...EDGE_PREDICATES]);
    const opTypes: PatchOp["type"][] = [
      "UpsertNode", "UpsertEdge", "DeleteNode", "DeleteEdge", "AssertClaim", "RetractClaim",
    ];
    const mapping = schemas.PatchOp!.discriminator!.mapping;
    expect(Object.keys(mapping)).toEqual(opTypes);
    expect(schemas.PatchOp!.oneOf!.map((one) => one.$ref)).toEqual(Object.values(mapping));
    for (const type of opTypes) {
      const name = mapping[type]!.split("/").pop()!;
      expect(schemas[name]!.properties!.type!.enum).toEqual([type]);
    }
  });

  it("types PatchOp as a union told apart by `type`", () => {
    const ops: PatchOp[] = [
      { type: "UpsertNode", id: "n", kind: "function", name: "f", attrs: {} },
      { type: "UpsertEdge", id: "e", src: "a", dst: "b", predicate: "CALLS", attrs: {} },
      { type: "DeleteNode", id: "n" },
      { type: "DeleteEdge", id: "e" },
      { type: "AssertClaim", entityId: "n", field: "calls:g", value: "g", confidence: null },
      { type: "RetractClaim" },
      // @ts-expect-error a kind no writer emits is not a NodeKind
      { type: "UpsertNode", id: "n", kind: "struct", name: "S", attrs: {} },
      // @ts-expect-error a predicate no writer emits is not an EdgePredicate
      { type: "UpsertEdge", id: "e", src: "a", dst: "b", predicate: "CALLED_BY", attrs: {} },
      // @ts-expect-error an op type the backend does not know
      { type: "UpsertThing", id: "n" },
    ];
    const kinds = ops.flatMap((op) => (op.type === "UpsertNode" ? [op.kind] : []));
    expect(kinds).toEqual(["function", "struct"]);
  });

  it("covers every kind and predicate the GitHub ingest writes", () => {
    const repo = { owner: "o", repo: "r" };
    const user = { login: "u" };
    const ops = [
      ...transformIssue(repo, {
        number: 1, title: "t", body: "b", state: "open", user, labels: [{ name: "bug" }],
        created_at: "", updated_at: "", html_url: "", comments: 1,
      }),
      ...transformIssueComment(repo, 1, { id: 9, body: "c", user, created_at: "", html_url: "" }),
      ...transformPR(repo, {
        number: 2, title: "t", body: "b", state: "open", merged_at: null, user,
        base: { ref: "main" }, head: { ref: "x" }, created_at: "", updated_at: "", html_url: "",
      }),
      ...transformCommit(repo, {
        sha: "abc", commit: { message: "m", author: { name: "a", date: "" } }, html_url: "",
        files: [{ filename: "x.ts", status: "modified" }],
      }),
    ];
    for (const op of ops) {
      if (op.type === "UpsertNode") expect(NODE_KINDS).toContain(op.kind);
      if (op.type === "UpsertEdge") expect(EDGE_PREDICATES).toContain(op.predicate);
    }
    expect(new Set(ops.map((op) => op.type))).toEqual(new Set(["UpsertNode", "UpsertEdge"]));
  });

  // graph-model.ts holds the CLI's kind sets; each is typed against the kinds a
  // graph can hold, so a kind that exists nowhere fails to compile.
  it("types the reader-side kind sets against known kinds", () => {
    const sets: ReadonlySet<graphModel.GraphKind>[] = [
      graphModel.TYPE_KINDS, graphModel.CONTAINER_KINDS, graphModel.TYPE_REFERENCE_KINDS,
      graphModel.CONTRACT_TYPE_KINDS, graphModel.CALLABLE_KINDS, graphModel.STRUCTURAL_KINDS,
      graphModel.REGION_KINDS, graphModel.FILE_KINDS,
    ];
    const known = new Set<string>([...NODE_KINDS, ...graphModel.READ_ONLY_KINDS]);
    for (const set of sets) for (const kind of set) expect(known).toContain(kind);
    // @ts-expect-error not a kind any writer or reader knows
    const typo: graphModel.GraphKind = "fucntion";
    const written: NodeKind = "function";
    expect([typo, written]).toHaveLength(2);
  });

  // A kind set kept outside graph-model.ts must still be typed, or a kind that
  // exists nowhere compiles there. Scans every CLI source for a kind list
  // (`FOO_KINDS = new Set([...])`, `allKinds = [...]`) and asks for a type.
  it("types every kind list in the CLI sources, not only graph-model.ts", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    // A kind list is named like one, or holds only graph kinds (two or more).
    const declaration = /\b(\w+)\s*(?::[ \t]*([^=;\n]+?))?\s*=\s*(?:new Set\s*(?:<([^>]*)>)?\s*\(\s*\[([^\]]*)\]|\[(\s*"[^\]]*)\])([^;]*)/g;
    const graphKinds = new Set<string>([...NODE_KINDS, ...graphModel.READ_ONLY_KINDS]);
    const isKindList = (name: string, body: string): boolean => {
      if (/(?:KINDS|Kinds|KindSet)$/.test(name)) return true;
      const items = body.split(",").map((item) => item.trim()).filter(Boolean);
      return items.length >= 2 && items.every((item) => /^"[a-z_]+"$/.test(item) && graphKinds.has(item.slice(1, -1)));
    };
    const untyped: string[] = [];
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts") || file.includes("__tests__") || file.endsWith(".d.ts")) continue;
      const source = readFileSync(join(root, file), "utf8");
      for (const match of source.matchAll(declaration)) {
        const [, name, annotation, setType, setBody, arrayBody, rest] = match;
        if (!isKindList(name!, setBody ?? arrayBody ?? "")) continue;
        // `rest` carries a trailing `satisfies readonly GraphKind[]`.
        const typed = `${annotation ?? ""} ${setType ?? ""} ${rest ?? ""}`;
        if (!/\b(GraphKind|KindSet|NodeKind)\b/.test(typed)) untyped.push(`${file}: ${name}`);
      }
    }
    expect(untyped).toEqual([]);
  });

  it("does not list a read-only kind that a writer now emits", () => {
    expect(graphModel.READ_ONLY_KINDS.filter((kind) => (NODE_KINDS as readonly string[]).includes(kind))).toEqual([]);
  });
});
