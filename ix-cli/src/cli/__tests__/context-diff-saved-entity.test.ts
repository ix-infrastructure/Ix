// Copyright 2026 Ix Infrastructure Inc.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

// `ix context Duplicate --save X` answers an ambiguous name for its top
// candidate (resolve.ts answerAmbiguous). `--diff X` must rebuild that same
// entity -- by the saved id -- rather than re-resolve the still-ambiguous name
// strictly, which exits 2 unless the user repeats --pick or --path.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const SAVED_ID = "11111111-2222-4333-8444-555555555555";
const { search, entity } = vi.hoisted(() => ({ search: vi.fn(), entity: vi.fn() }));

// The bundle build after resolution is not under test: it stops at the first
// graph read, so what is asserted is which entity resolution settled on.
vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async entity(id: string) { return entity(id); }
    async contextForNode() { throw new Error("stop after resolution"); }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

const DUPLICATES = [
  { id: SAVED_ID, kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
  { id: "99999999-2222-4333-8444-555555555555", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
];

let home: string;
let priorExitCode: typeof process.exitCode;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ix-context-diff-"));
  process.env.IX_HOME = home;
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  search.mockReset().mockImplementation(async (term: string) => (term === "Duplicate" ? DUPLICATES : []));
  entity.mockReset().mockImplementation(async (id: string) => (id === SAVED_ID
    ? { node: { id, kind: "function", name: "Duplicate", attrs: {}, provenance: { sourceUri: "src/first.ts" } } }
    : { node: null }));
  const { buildBundle } = await import("../context/bundle.js");
  const { saveInvestigation } = await import("../context/investigations.js");
  saveInvestigation("dup", buildBundle({
    resolved: { id: SAVED_ID, name: "Duplicate", kind: "function", resolutionMode: "exact" },
    facts: {
      id: SAVED_ID, name: "Duplicate", kind: "function", members: [], memberCount: 0, callerCount: 0, calleeCount: 0,
      dependentCount: 0, importerCount: 0, topCallers: [], topDependents: [],
      historyLength: 0, stale: false, diagnostics: [],
    },
    context: {
      claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
      metadata: { query: "Duplicate", seedEntities: [SAVED_ID], hopsExpanded: 1, asOfRev: 1 },
    },
    provenance: { sourceType: "source", extractor: "tree-sitter", observedAt: "2026-01-01T00:00:00Z" },
    asOfRev: undefined,
    depth: undefined,
    budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxTokens: 1500, maxChars: 12000 },
  }));
});

afterEach(() => {
  delete process.env.IX_HOME;
  rmSync(home, { recursive: true, force: true });
  process.exitCode = priorExitCode;
});

async function diff(args: string[]): Promise<{ out: string; exitCode: typeof process.exitCode }> {
  const { registerContextCommand } = await import("../commands/context.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerContextCommand(program);
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...p) => { lines.push(p.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...p) => { lines.push(p.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((p: string) => { lines.push(String(p)); return true; }) as never);
  try {
    await program.parseAsync(["node", "ix", "context", ...args]).catch(() => undefined);
  } finally {
    log.mockRestore();
    err.mockRestore();
    write.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: lines.join("\n"), exitCode };
}

describe("ix context --diff of an investigation saved on an ambiguous name", () => {
  it("rebuilds the saved entity by its id, without an ambiguity error", async () => {
    const { out, exitCode } = await diff(["--diff", "dup", "--format", "json"]);
    expect(entity).toHaveBeenCalledWith(SAVED_ID);
    expect(search).not.toHaveBeenCalled();
    expect(out).not.toContain("ambiguous_target");
    expect(exitCode).not.toBe(2);
  });

  it("re-resolves the name strictly when the saved id is gone", async () => {
    entity.mockResolvedValue({ node: null });
    const { out, exitCode } = await diff(["--diff", "dup", "--format", "json"]);
    expect(search).toHaveBeenCalled();
    expect(out).toContain("ambiguous_target");
    expect(exitCode).toBe(2);
  });

  it("re-resolves the name when the user passes a selector", async () => {
    const { out, exitCode } = await diff(["--diff", "dup", "--pick", "2", "--format", "json"]);
    expect(entity).not.toHaveBeenCalledWith(SAVED_ID);
    expect(search).toHaveBeenCalled();
    expect(out).not.toContain("ambiguous_target");
    expect(exitCode).not.toBe(2);
  });
});
