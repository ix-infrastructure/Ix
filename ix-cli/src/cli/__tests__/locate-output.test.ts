// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

import { registerLocateCommand } from "../commands/locate.js";
import { resetGraphHealthMemo } from "../graph-health.js";
import { humanizeLabel } from "../impact/risk-semantics.js";
import { resetReadScope } from "../resolve.js";
import { workspaceIdForPath } from "../system.js";
import { FakeBackend } from "./helpers/fake-backend.js";

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

describe("ix locate --format json", () => {
  let backend: FakeBackend | undefined;
  let home = "";
  let repo = "";
  let savedCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedCwd = process.cwd();
    home = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-locate-out-home-")));
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-locate-out-repo-")));
    for (const key of ["HOME", "USERPROFILE", "IX_HOME", "IX_ENDPOINT", "IX_TOKEN", "IX_STRICT_TARGETS"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_HOME = join(home, ".ix");
    delete process.env.IX_TOKEN;
    delete process.env.IX_STRICT_TARGETS;
    backend = new FakeBackend({ semantics: "head" });
    const endpoint = await backend.start();
    process.env.IX_ENDPOINT = endpoint;
    const workspaceId = workspaceIdForPath(repo);
    mkdirSync(process.env.IX_HOME, { recursive: true });
    writeFileSync(join(process.env.IX_HOME, "config.yaml"), [
      `endpoint: ${endpoint}`,
      "format: text",
      "workspaces:",
      `  - workspace_id: "${workspaceId}"`,
      "    workspace_name: repo",
      `    root_path: ${JSON.stringify(repo)}`,
      "    default: true",
      "",
    ].join("\n"));
    process.chdir(repo);
    resetReadScope();
    resetGraphHealthMemo();

    const commit = async (uri: string, ops: Array<Record<string, unknown>>): Promise<void> => {
      const res = await fetch(`${endpoint}/v1/patch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patchId: `p-${uri}`,
          source: { uri, sourceHash: "h", workspaceId, extractor: "test" },
          ops,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    };
    const node = (id: string, kind: string, name: string, attrs?: Record<string, number>) =>
      ({ type: "UpsertNode", id, kind, name, ...(attrs ? { attrs } : {}) });
    const edge = (id: string, src: string, dst: string, predicate: string) =>
      ({ type: "UpsertEdge", id, src, dst, predicate });

    await commit("ix:map", [
      node("sys", "system", "CLI"),
      node("sub", "subsystem", "Cli / Client"),
      edge("r1", "sys", "sub", "IN_REGION"),
      edge("r2", "sub", "file-auth", "IN_REGION"),
      edge("r3", "sub", "fn-verify", "IN_REGION"),
    ]);
    await commit("src/session.ts", [
      node("cls-session", "class", "Session"),
    ]);
    await commit("src/auth.ts", [
      node("file-auth", "file", "auth.ts"),
      node("fn-verify", "function", "verify_token", { line_start: 12, line_end: 20 }),
      edge("c1", "file-auth", "cls-session", "CONTAINS"),
      edge("c2", "cls-session", "fn-verify", "CONTAINS"),
    ]);
    await commit("src/a.py", [
      node("file-a", "file", "a.py"),
      node("crop-a", "function", "crop", { line_start: 1, line_end: 4 }),
      edge("ca", "file-a", "crop-a", "CONTAINS"),
    ]);
    await commit("src/b.py", [
      node("file-b", "file", "b.py"),
      node("crop-b", "function", "crop", { line_start: 8, line_end: 12 }),
      edge("cb", "file-b", "crop-b", "CONTAINS"),
    ]);
  });

  afterAll(async () => {
    process.chdir(savedCwd);
    await backend?.stop();
    if (home) rmSync(home, { recursive: true, force: true });
    if (repo) rmSync(repo, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetReadScope();
    resetGraphHealthMemo();
  });

  async function locate(args: string[]): Promise<Record<string, any>> {
    const program = new Command().name("ix").exitOverride();
    registerLocateCommand(program);
    const stdout: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.map(String).join(" ")); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["locate", ...args], { from: "user" });
    } finally {
      process.exitCode = before;
      log.mockRestore();
      error.mockRestore();
      write.mockRestore();
    }
    expect(backend!.unknownPaths, "endpoints the fake does not implement").toEqual([]);
    return JSON.parse(stdout.join("\n"));
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
      const out = await locate(["crop", "--strict", "--format", "json"]);
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
      const out = await locate(["no_such_symbol_zz", "--no-suggest", "--format", "json"]);
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
      const ambiguous = await locate(["crop", "--strict", "--format", "json"]);
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
