// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

import { registerImpactCommand } from "../commands/impact.js";
import { resetGraphHealthMemo } from "../graph-health.js";
import { inferRiskSemantics, humanizeLabel, type ImpactFacts } from "../impact/risk-semantics.js";
import { resetReadScope } from "../resolve.js";
import { workspaceIdForPath } from "../system.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * JSON shape of `ix impact`, taken from the command's stdout.
 *
 * A container and a leaf do not share a summary: the container counts members
 * and dependents, the leaf counts callers and callees. Both always carry the
 * risk fields. Empty lists are left out.
 */

const REQUIRED_TOP_LEVEL_KEYS = [
  "resolvedTarget",
  "depth",
  "systemPath",
  "riskSummary",
  "riskLevel",
  "riskCategory",
  "atRiskBehavior",
  "summary",
];

const CONTAINER_SUMMARY_KEYS = [
  "members",
  "directImporters",
  "directDependents",
  "memberLevelCallers",
];

const LEAF_SUMMARY_KEYS = ["callers", "callees"];

describe("ix impact --format json", () => {
  let backend: FakeBackend | undefined;
  let home = "";
  let repo = "";
  let savedCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedCwd = process.cwd();
    home = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-impact-schema-home-")));
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-impact-schema-repo-")));
    for (const key of ["HOME", "USERPROFILE", "IX_HOME", "IX_ENDPOINT", "IX_TOKEN"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_HOME = join(home, ".ix");
    delete process.env.IX_TOKEN;
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
    await commit(workspaceId, "ix:map", [
      node("sys", "system", "CLI"),
      node("sub", "subsystem", "Cli / Client"),
      edge("r1", "sys", "sub", "IN_REGION"),
      edge("r2", "sub", "cls-session", "IN_REGION"),
      edge("r3", "sub", "fn-verify", "IN_REGION"),
    ]);
    await commit(workspaceId, "src/session.ts", [
      node("file-session", "file", "session.ts"),
      node("cls-session", "class", "Session", { line_start: 1, line_end: 40 }),
      node("m-login", "method", "login", { line_start: 10, line_end: 20 }),
      edge("c1", "file-session", "cls-session", "CONTAINS"),
      edge("c2", "cls-session", "m-login", "CONTAINS"),
    ]);
    await commit(workspaceId, "src/auth.ts", [
      node("fn-verify", "function", "verify_token", { line_start: 3, line_end: 9 }),
    ]);
    await commit(workspaceId, "src/app.ts", [
      node("fn-boot", "function", "boot"),
      edge("k1", "fn-boot", "m-login", "CALLS"),
      edge("k2", "m-login", "fn-verify", "CALLS"),
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

  async function impact(target: string): Promise<Record<string, any>> {
    const program = new Command().name("ix").exitOverride();
    registerImpactCommand(program);
    const stdout: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.map(String).join(" ")); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["impact", target, "--format", "json"], { from: "user" });
    } finally {
      process.exitCode = before;
      log.mockRestore();
      error.mockRestore();
      write.mockRestore();
    }
    expect(backend!.unknownPaths, "endpoints the fake does not implement").toEqual([]);
    return JSON.parse(stdout.join("\n"));
  }

  it("container target carries the risk fields and the member summary", async () => {
    const out = await impact("Session");
    for (const key of REQUIRED_TOP_LEVEL_KEYS) expect(out).toHaveProperty(key);
    expect(out.resolvedTarget).toEqual({ kind: "class", name: "Session" });
    expect(out.depth).toBe(1);
    expect(out.systemPath).toEqual([
      { name: "CLI", kind: "system" },
      { name: "Cli / Client", kind: "subsystem" },
    ]);
    expect(typeof out.riskSummary).toBe("string");
    expect(out.riskSummary.length).toBeGreaterThan(0);
    expect(["low", "medium", "high", "critical"]).toContain(out.riskLevel);
    expect(typeof out.riskCategory).toBe("string");
    expect(Array.isArray(out.atRiskBehavior)).toBe(true);
    // Zero counts stay. Callers and callees belong to the leaf summary.
    expect(Object.keys(out.summary).sort()).toEqual([...CONTAINER_SUMMARY_KEYS].sort());
    expect(out.summary).toEqual({ members: 1, directImporters: 0, directDependents: 0, memberLevelCallers: 1 });
    expect(out.topImpactedMembers).toEqual([
      expect.objectContaining({ name: "login", kind: "method", callerCount: 1 }),
    ]);
    expect(out).not.toHaveProperty("callerList");
    expect(out).not.toHaveProperty("calleeList");
    expect(out).not.toHaveProperty("decisions");
    expect(out).not.toHaveProperty("diagnostics");
  });

  it("leaf target carries the risk fields and the caller summary", async () => {
    const out = await impact("verify_token");
    for (const key of REQUIRED_TOP_LEVEL_KEYS) expect(out).toHaveProperty(key);
    expect(out.resolvedTarget).toEqual({ kind: "function", name: "verify_token" });
    expect(out.systemPath.map((n: { name: string }) => n.name)).toContain("CLI");
    expect(typeof out.riskSummary).toBe("string");
    expect(["low", "medium", "high", "critical"]).toContain(out.riskLevel);
    expect(typeof out.riskCategory).toBe("string");
    expect(Array.isArray(out.atRiskBehavior)).toBe(true);
    // A callee count of zero is still present. Member counts are not.
    expect(Object.keys(out.summary).sort()).toEqual([...LEAF_SUMMARY_KEYS].sort());
    expect(out.summary).toEqual({ callers: 1, callees: 0 });
    expect(out.callerList).toEqual([
      expect.objectContaining({ kind: "method", name: "login" }),
    ]);
    expect(out).not.toHaveProperty("calleeList");
    expect(out).not.toHaveProperty("topImpactedMembers");
    expect(out).not.toHaveProperty("diagnostics");
  });
});

function node(id: string, kind: string, name: string, attrs?: Record<string, number>): Record<string, unknown> {
  return { type: "UpsertNode", id, kind, name, ...(attrs ? { attrs } : {}) };
}

function edge(id: string, src: string, dst: string, predicate: string): Record<string, unknown> {
  return { type: "UpsertEdge", id, src, dst, predicate };
}

async function commit(workspaceId: string, uri: string, ops: Array<Record<string, unknown>>): Promise<void> {
  const endpoint = process.env.IX_ENDPOINT;
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
}

// ── Risk semantics inference ────────────────────────────────────────────────

function makeFacts(overrides: Partial<ImpactFacts> = {}): ImpactFacts {
  return {
    name: "SomeEntity",
    kind: "function",
    members: 0,
    callers: 2,
    callees: 1,
    directImporters: 0,
    directDependents: 0,
    memberLevelCallers: 0,
    propagationBuckets: [],
    ...overrides,
  };
}

describe("inferRiskSemantics: boundary class", () => {
  it("IxClient-like class: risk summary mentions backend-facing CLI operations / client boundary", () => {
    const facts = makeFacts({
      name: "IxClient",
      kind: "class",
      members: 15,
      callers: 0,
      directImporters: 8,
      directDependents: 20,
      memberLevelCallers: 66,
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Cli / Client", kind: "subsystem" },
        { name: "api.ts", kind: "file" },
      ],
      propagationBuckets: [
        { region: "Cli / Client", regionKind: "subsystem", count: 34 },
        { region: "Commands", regionKind: "module", count: 18 },
        { region: "Explain", regionKind: "module", count: 6 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("boundary");
    expect(risk.riskLevel).toBe("critical");
    expect(risk.riskSummary.toLowerCase()).toContain("backend-facing");
    expect(risk.riskSummary.toLowerCase()).toContain("boundary");
  });

  it("IxClient-like class: at-risk behavior is operational, not just counts", () => {
    const facts = makeFacts({
      name: "IxClient",
      kind: "class",
      members: 15,
      directImporters: 8,
      directDependents: 20,
      memberLevelCallers: 66,
      propagationBuckets: [
        { region: "Cli / Client", regionKind: "subsystem", count: 34 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.behaviorAtRisk.length).toBeGreaterThan(0);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("command");
    expect(joined).not.toMatch(/^\d+$/); // Not just numbers
  });
});

describe("inferRiskSemantics: flow function", () => {
  it("pickBest-like function: risk summary mentions candidate selection / resolution flow", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
      propagationBuckets: [
        { region: "Resolution", regionKind: "subsystem", count: 14 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("flow");
    expect(risk.riskSummary.toLowerCase()).toContain("candidate selection");
    expect(risk.riskSummary.toLowerCase()).toContain("resolution flow");
    // Should not lead with "callers: 1, callees: 4"
    expect(risk.riskSummary).not.toMatch(/callers?:\s*\d/);
  });

  it("pickBest-like function: at-risk behavior mentions selection/resolution", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
    });
    const risk = inferRiskSemantics(facts);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("selection");
  });
});

describe("inferRiskSemantics: conflict-resolution method", () => {
  it("resolve-like method: risk summary mentions conflict-resolution behavior", () => {
    const facts = makeFacts({
      name: "resolveConflict",
      kind: "method",
      path: "src/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
      callers: 3,
      callees: 2,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Conflict", kind: "subsystem" },
        { name: "conflict.ts", kind: "file" },
      ],
      propagationBuckets: [
        { region: "Conflict", regionKind: "subsystem", count: 5 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("flow");
    expect(risk.riskSummary.toLowerCase()).toContain("conflict");
  });

  it("resolve-like method: propagation mentions conflict flow", () => {
    const facts = makeFacts({
      name: "resolveConflict",
      kind: "method",
      path: "src/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
      callers: 3,
      callees: 2,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Conflict", kind: "subsystem" },
      ],
    });
    const risk = inferRiskSemantics(facts);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("conflict");
  });
});

describe("inferRiskSemantics: foundational shared type", () => {
  it("NodeKind-like enum: risk summary mentions shared node interpretation / model-parser consistency", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      callers: 0,
      directImporters: 8,
      directDependents: 12,
      memberLevelCallers: 0,
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "Model", kind: "subsystem" },
        { name: "graph.ts", kind: "file" },
      ],
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
        { region: "Model / Db", regionKind: "subsystem", count: 3 },
        { region: "Context", regionKind: "module", count: 2 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("foundation");
    expect(risk.riskLevel).toBe("critical");
    expect(risk.riskSummary.toLowerCase()).toContain("node");
    expect(risk.riskSummary.toLowerCase()).toContain("risk");
  });

  it("NodeKind-like enum: at-risk behavior mentions classification and interpretation", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      directImporters: 8,
      directDependents: 12,
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.behaviorAtRisk.length).toBeGreaterThan(0);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("classification");
    expect(joined).toContain("interpretation");
  });

  it("NodeKind-like enum: propagation uses hierarchy buckets", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      directImporters: 8,
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
        { region: "Model / Db", regionKind: "subsystem", count: 3 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    // Risk summary should reference layers, not raw IDs
    expect(risk.riskSummary.toLowerCase()).not.toContain("id:");
    expect(risk.riskSummary).toContain("layer");
  });
});

describe("inferRiskSemantics: localized entity", () => {
  it("low-connectivity function gets low risk", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      kind: "function",
      callers: 1,
      callees: 0,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.riskLevel).toBe("low");
    expect(risk.category).toBe("localized");
  });
});

describe("inferRiskSemantics: shared dependency", () => {
  it("widely-called function gets shared category", () => {
    const facts = makeFacts({
      name: "formatOutput",
      kind: "function",
      callers: 8,
      callees: 2,
      propagationBuckets: [
        { region: "Commands", regionKind: "module", count: 5 },
        { region: "Explain", regionKind: "module", count: 3 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("shared");
    expect(risk.riskLevel).not.toBe("low");
  });
});

// ── humanizeLabel ───────────────────────────────────────────────────────────

describe("humanizeLabel", () => {
  it("Cli / Client → CLI client layer", () => {
    expect(humanizeLabel("Cli / Client")).toBe("CLI client layer");
  });

  it("Api → API layer", () => {
    expect(humanizeLabel("Api")).toBe("API layer");
  });

  it("Model / Db → model and database layer", () => {
    expect(humanizeLabel("Model / Db")).toBe("model and database layer");
  });

  it("Ingestion / Parsers → ingestion and parser layer", () => {
    expect(humanizeLabel("Ingestion / Parsers")).toBe("ingestion and parser layer");
  });

  it("Context → context layer", () => {
    expect(humanizeLabel("Context")).toBe("context layer");
  });
});

// ── Flow-specific risk summary ──────────────────────────────────────────────

describe("inferRiskSemantics: flow-specific risk summary", () => {
  it("pickBest summary contains 'candidate selection' and 'resolution flow'", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
      propagationBuckets: [
        { region: "Resolution", regionKind: "subsystem", count: 14 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.riskSummary.toLowerCase()).toContain("candidate selection");
    expect(risk.riskSummary.toLowerCase()).toContain("resolution flow");
  });
});

// ── Flow-aware most-affected ────────────────────────────────────────────────

describe("inferRiskSemantics: flow-aware most-affected", () => {
  it("pickBest with topCallerNames mentions the caller and selection", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
      topCallerNames: ["resolveEntityFull"],
      propagationBuckets: [
        { region: "Resolution", regionKind: "subsystem", count: 14 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.mostAffectedHint).toContain("resolveEntityFull");
    expect(risk.mostAffectedHint!.toLowerCase()).toContain("selection");
  });
});

// ── Foundation importer spread ──────────────────────────────────────────────

describe("inferRiskSemantics: foundation importer spread", () => {
  it("NodeKind-like with directImporters=8: summary or behavior mentions 'contract' or 'imported'", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      directImporters: 8,
      directDependents: 12,
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
        { region: "Model / Db", regionKind: "subsystem", count: 3 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    const allText = [risk.riskSummary, ...risk.behaviorAtRisk].join(" ").toLowerCase();
    expect(allText).toContain("contract");
    expect(allText).toContain("imported");
  });
});

// ── Next-step guidance ──────────────────────────────────────────────────────

describe("inferRiskSemantics: next-step guidance", () => {
  it("foundation with high importers → nextStep contains 'ix explain'", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      directImporters: 8,
      directDependents: 12,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.nextStep).toContain("ix explain");
  });

  it("flow with callers → nextStep contains 'ix depends'", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.nextStep).toContain("ix depends");
  });

  it("localized → nextStep is undefined", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      kind: "function",
      callers: 1,
      callees: 0,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.nextStep).toBeUndefined();
  });
});
