// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { humanizeLabel } from "../impact/risk-semantics.js";
import { FakeBackend, type ReadGraph } from "./helpers/fake-backend.js";
import { runCommand } from "./helpers/run-command.js";

/**
 * JSON shape of `ix locate`, taken from the command's stdout.
 *
 * A symbol carries a line range, its container and a system path that ends
 * at the symbol. A file does not. An ambiguous name, under --strict, is the
 * candidate list. None of those records carry impact's risk fields.
 */

const SYMBOL_KEYS = ["resolvedTarget", "lineRange", "container", "systemPath", "hasMapData", "diagnostics"];
const FILE_KEYS = ["resolvedTarget", "systemPath", "hasMapData", "diagnostics"];
const AMBIGUOUS_KEYS = ["code", "message", "resolvedTarget", "resolutionMode", "candidates", "systemPath", "diagnostics"];

const IMPACT_KEYS = [
  "callers", "callerList", "dependents", "directDependents", "directImporters",
  "members", "topImpactedMembers", "riskSummary", "riskLevel", "riskCategory",
  "atRiskBehavior", "behaviorAtRisk", "mostAffectedHint", "nextStep",
];

/**
 * A mapped graph: a system and a subsystem holding src/auth.ts and
 * `verify_token`, which sits in class `Session` in that file; and `crop`,
 * defined once in each of two files, so the name is ambiguous.
 *
 *   src/auth.ts  CONTAINS  Session (class)  CONTAINS  verify_token (function)
 *   src/a.py     CONTAINS  crop (function)
 *   src/b.py     CONTAINS  crop (function)
 */
const LOCATE_GRAPH: ReadGraph = {
  nodes: [
    { id: "sys", kind: "system", name: "CLI", uri: "ix:map" },
    { id: "sub", kind: "subsystem", name: "Cli / Client", uri: "ix:map" },
    { id: "cls-session", kind: "class", name: "Session", uri: "src/session.ts" },
    { id: "file-auth", kind: "file", name: "auth.ts", uri: "src/auth.ts" },
    { id: "fn-verify", kind: "function", name: "verify_token", uri: "src/auth.ts", attrs: { line_start: 12, line_end: 20 } },
    { id: "file-a", kind: "file", name: "a.py", uri: "src/a.py" },
    { id: "crop-a", kind: "function", name: "crop", uri: "src/a.py", attrs: { line_start: 1, line_end: 4 } },
    { id: "file-b", kind: "file", name: "b.py", uri: "src/b.py" },
    { id: "crop-b", kind: "function", name: "crop", uri: "src/b.py", attrs: { line_start: 8, line_end: 12 } },
  ],
  edges: [
    { id: "r1", src: "sys", dst: "sub", predicate: "IN_REGION" },
    { id: "r2", src: "sub", dst: "file-auth", predicate: "IN_REGION" },
    { id: "r3", src: "sub", dst: "fn-verify", predicate: "IN_REGION" },
    { id: "c1", src: "file-auth", dst: "cls-session", predicate: "CONTAINS" },
    { id: "c2", src: "cls-session", dst: "fn-verify", predicate: "CONTAINS" },
    { id: "ca", src: "file-a", dst: "crop-a", predicate: "CONTAINS" },
    { id: "cb", src: "file-b", dst: "crop-b", predicate: "CONTAINS" },
  ],
  files: {},
};

describe("ix locate --format json", () => {
  const backend = new FakeBackend();
  backend.readGraph = LOCATE_GRAPH;

  beforeAll(async () => {
    await backend.start();
  });
  afterAll(async () => {
    await backend.stop();
  });
  afterEach(() => {
    expect(backend.unknownPaths, "endpoints the fake does not implement").toEqual([]);
    backend.unknownPaths.length = 0;
    backend.reads.length = 0;
  });

  /** Run `ix locate <args>`, check its exit code (0 found, 2 ambiguous under --strict, 3 not found), parse stdout. */
  async function locate(args: string[], exitCode = 0): Promise<Record<string, any>> {
    const run = await runCommand(["locate", ...args], { backend });
    expect(run.exitCode, run.stderr).toBe(exitCode);
    return JSON.parse(run.stdout);
  }

  describe("symbol target", () => {
    it("reports the file, the line range, the container and a system path ending at the symbol", async () => {
      const out = await locate(["verify_token", "--format", "json"]);
      for (const key of SYMBOL_KEYS) expect(out).toHaveProperty(key);
      expect(out.resolvedTarget).toMatchObject({ kind: "function", name: "verify_token", path: "src/auth.ts" });
      expect(out.resolvedTarget.path).not.toMatch(/^\//);
      expect(out.lineRange).toEqual({ start: 12, end: 20 });
      expect(out.container).toMatchObject({ kind: "class", name: "Session" });
      expect(out.systemPath.at(-1)).toEqual({ name: "verify_token", kind: "function" });
      expect(out.systemPath[0]).toEqual({ name: "CLI", kind: "system" });
      // JSON keeps the graph's names. humanizeLabel is what the text breadcrumb uses.
      expect(out.systemPath.map((n: { name: string }) => n.name)).toContain("Cli / Client");
      expect(out.hasMapData).toBe(true);
      expect(out.diagnostics).toEqual([]);
    });
  });

  describe("file target", () => {
    it("reports the file and its regions, without a container, a line range or a trailing symbol", async () => {
      const out = await locate(["src/auth.ts", "--format", "json"]);
      for (const key of FILE_KEYS) expect(out).toHaveProperty(key);
      expect(out.resolvedTarget).toMatchObject({ kind: "file", name: "auth.ts", path: "src/auth.ts" });
      expect(out.resolvedTarget.path).not.toMatch(/^\//);
      expect(out.systemPath).toEqual([
        { name: "CLI", kind: "system" },
        { name: "Cli / Client", kind: "subsystem" },
      ]);
      expect(out.systemPath.at(-1).kind).not.toBe("function");
      expect(out.hasMapData).toBe(true);
      expect(out).not.toHaveProperty("container");
      expect(out).not.toHaveProperty("lineRange");
    });
  });

  describe("ambiguous target", () => {
    it("lists the candidates and does not say the symbol is missing", async () => {
      const out = await locate(["crop", "--strict", "--format", "json"], 2);
      for (const key of AMBIGUOUS_KEYS) expect(out).toHaveProperty(key);
      expect(out.code).toBe("ambiguous_target");
      expect(out.resolutionMode).toBe("ambiguous");
      expect(out.resolvedTarget).toBeNull();
      expect(out.systemPath).toBeNull();
      expect(out.candidates.length).toBeGreaterThan(1);
      expect(out.candidates.map((c: { name: string }) => c.name)).toEqual(["crop", "crop"]);
      const messages = out.diagnostics.map((d: { message?: string } | string) => typeof d === "string" ? d : d.message);
      expect(messages).not.toContain("No graph entity found.");
      expect(messages).not.toContain("No matches found.");
    });
  });

  describe("miss", () => {
    it("a name the graph does not have is a null target with a diagnostic", async () => {
      const out = await locate(["no_such_symbol_zz", "--no-suggest", "--format", "json"], 3);
      expect(out.resolvedTarget).toBeNull();
      expect(out.resolutionMode).toBe("none");
      expect(out.systemPath).toBeNull();
      expect(out.error).toBe("unresolved_target");
      expect(out.diagnostics).toContain("No graph entity found.");
    });
  });

  describe("no impact fields", () => {
    it("symbol, file and ambiguous records omit callers, dependents, members and risk", async () => {
      const symbol = await locate(["verify_token", "--format", "json"]);
      const file = await locate(["src/auth.ts", "--format", "json"]);
      const ambiguous = await locate(["crop", "--strict", "--format", "json"], 2);
      const keys = [...Object.keys(symbol), ...Object.keys(file), ...Object.keys(ambiguous)];
      for (const key of IMPACT_KEYS) expect(keys).not.toContain(key);
    });
  });
});

describe("humanizeLabel", () => {
  // The text breadcrumb humanizes region names and then strips the " layer" suffix.
  it("region nodes are humanized (strip parentheticals, normalize abbreviations)", () => {
    const humanized = humanizeLabel("Cli / Client").replace(/ layer$/, "");
    expect(humanized).toBe("CLI client");
  });

  it("raw suffixes like (2f) are stripped", () => {
    const humanized = humanizeLabel("Model (2f)").replace(/ layer$/, "");
    expect(humanized).not.toContain("(2f)");
  });
});
