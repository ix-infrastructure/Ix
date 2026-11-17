// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CALLABLE_KINDS,
  CONTAINER_KINDS,
  CONTRACT_TYPE_KINDS,
  FILE_KINDS,
  REGION_KINDS,
  STRUCTURAL_KINDS,
  TYPE_KINDS,
  TYPE_REFERENCE_KINDS,
} from "../graph-model.js";

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("graph-model kind sets", () => {
  it("TYPE_KINDS: every kind that declares a type, struct and record included", () => {
    expect(sorted(TYPE_KINDS)).toEqual(
      ["annotation", "class", "enum", "interface", "object", "record", "struct", "trait"],
    );
  });

  it("CONTAINER_KINDS: files, modules and every type kind; a struct or an enum is a container for every command", () => {
    expect(sorted(CONTAINER_KINDS)).toEqual(
      ["annotation", "class", "enum", "file", "interface", "module", "object", "record", "struct", "trait"],
    );
    for (const k of TYPE_KINDS) expect(CONTAINER_KINDS.has(k), k).toBe(true);
    for (const k of ["function", "method", "constant", "region"]) expect(CONTAINER_KINDS.has(k), k).toBe(false);
  });

  it("TYPE_REFERENCE_KINDS: containers plus the declarations a reference names but no one calls", () => {
    expect(sorted(TYPE_REFERENCE_KINDS)).toEqual([
      "annotation", "class", "enum", "impl", "interface", "module", "namespace",
      "object", "record", "struct", "trait", "type", "union",
    ]);
    // A file is a container but never the thing a type reference names.
    expect(TYPE_REFERENCE_KINDS.has("file")).toBe(false);
    for (const k of ["function", "method", "constructor"]) expect(TYPE_REFERENCE_KINDS.has(k), k).toBe(false);
  });

  it("CONTRACT_TYPE_KINDS: abstract types only; a concrete class is not a contract", () => {
    expect(sorted(CONTRACT_TYPE_KINDS)).toEqual(
      ["abstract_class", "enum", "interface", "sealed_trait", "trait", "type", "type_alias"],
    );
    expect(CONTRACT_TYPE_KINDS.has("class")).toBe(false);
  });

  it("STRUCTURAL_KINDS: containers plus callables and constants", () => {
    for (const k of CONTAINER_KINDS) expect(STRUCTURAL_KINDS.has(k), k).toBe(true);
    for (const k of ["function", "method", "constant"]) expect(STRUCTURAL_KINDS.has(k), k).toBe(true);
    for (const k of ["config_entry", "doc", "decision", "region"]) expect(STRUCTURAL_KINDS.has(k), k).toBe(false);
  });

  it("CALLABLE_KINDS, REGION_KINDS, FILE_KINDS", () => {
    expect(sorted(CALLABLE_KINDS)).toEqual(["constructor", "def", "fun", "function", "method"]);
    expect(sorted(REGION_KINDS)).toEqual(["module", "region", "subsystem", "system"]);
    expect(sorted(FILE_KINDS)).toEqual(["file"]);
  });
});

describe("graph-model is the only place kind sets are defined", () => {
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const NAMES = [
    "CONTAINER_KINDS", "CONTAINER_TARGET_KINDS", "STRUCTURAL_CONTAINER_KINDS", "TYPE_KINDS",
    "TYPE_REFERENCE_KINDS", "CONTRACT_TYPE_KINDS", "CALLABLE_KINDS", "STRUCTURAL_KINDS",
    "REGION_KINDS", "FILE_KINDS",
  ];
  const DEFINITION = new RegExp(`\\bconst\\s+(${NAMES.join("|")})\\b\\s*(?::[^=]*)?=`);

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...sources(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("no other CLI source file defines one of the shared kind sets", () => {
    const offenders: string[] = [];
    for (const file of sources(cliDir)) {
      const rel = relative(cliDir, file);
      if (rel === "graph-model.ts") continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (DEFINITION.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
