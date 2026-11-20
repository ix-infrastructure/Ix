// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { resetResolutionNotices } from "../format.js";
import { setOutputShape } from "../output-shape.js";

// `ix context Duplicate --format json --out f` (or `--save id`) answers an
// ambiguous name for its top candidate. The json notice normally rides in the
// object `printJson` prints, and these paths print none: the bundle goes to a
// file. The guess must still be said, on stderr, so a script is not handed a
// bundle for a guessed entity with no sign of it.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search } = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async entity(id: string) {
      return { node: { id, kind: "function", name: "Duplicate", attrs: {}, provenance: { sourceUri: `src/${id}.ts` } } };
    }
    async provenance(id: string) { return { entityId: id, chain: [] }; }
    async listByKind() { return []; }
    async expand() { return { nodes: [], edges: [] }; }
    async contextForNode(id: string) {
      return {
        claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
        metadata: { query: id, seedEntities: [id], hopsExpanded: 1, asOfRev: 1 },
      };
    }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

// The bundle's facts and health are not under test: what is, is what the
// command says about the entity it settled on.
vi.mock("../explain/facts.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../explain/facts.js")>(),
  collectFacts: async (_client: unknown, id: string, name: string, kind: string) => ({
    id, name, kind, members: [], memberCount: 0, callerCount: 0, calleeCount: 0,
    dependentCount: 0, importerCount: 0, topCallers: [], topDependents: [],
    historyLength: 0, stale: false, diagnostics: [],
    provenance: { sourceType: "source", extractor: "tree-sitter", observedAt: "2026-01-01T00:00:00Z" },
  }),
}));

vi.mock("../graph-health.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph-health.js")>(),
  checkGraphHealth: async () => ({ status: "unknown" }),
}));

const DUPLICATES = [
  { id: "11111111-2222-4333-8444-555555555555", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
  { id: "99999999-2222-4333-8444-555555555555", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
];

let home: string;
let priorExitCode: typeof process.exitCode;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ix-context-guessed-"));
  process.env.IX_HOME = home;
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  resetResolutionNotices();
  search.mockReset().mockImplementation(async (term: string) => (term === "Duplicate" ? DUPLICATES : []));
});

afterEach(() => {
  delete process.env.IX_HOME;
  rmSync(home, { recursive: true, force: true });
  process.exitCode = priorExitCode;
  resetResolutionNotices();
});

async function context(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { registerContextCommand } = await import("../commands/context.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerContextCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...p) => { stdout.push(p.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...p) => { stderr.push(p.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((p: string) => { stderr.push(String(p)); return true; }) as never);
  try {
    await program.parseAsync(["node", "ix", "context", ...args]);
  } finally {
    log.mockRestore();
    err.mockRestore();
    write.mockRestore();
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

describe("ix context on an ambiguous name, json, bundle to a file", () => {
  it("--out writes the top candidate's bundle and says on stderr which entity it guessed", async () => {
    const out = join(home, "bundle.json");
    const { stderr, exitCode } = await context(["Duplicate", "--format", "json", "--out", out]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).target.id).toBe(DUPLICATES[0].id);
    expect(stderr).toContain('"Duplicate" matches 2 candidates; using Duplicate (src/first.ts).');
    expect(stderr).toContain("src/second.ts");
    expect(stderr).toContain("--pick <n>");
  });

  it("--save says so too, even under --quiet", async () => {
    // --quiet is a global flag (main.ts); this is what it sets.
    setOutputShape({ quiet: true });
    let result: Awaited<ReturnType<typeof context>>;
    try {
      result = await context(["Duplicate", "--format", "json", "--save", "inv"]);
    } finally {
      setOutputShape({ quiet: false });
    }
    const { stderr, exitCode } = result;
    expect(exitCode).toBe(0);
    expect(existsSync(join(home, "investigations"))).toBe(true);
    expect(stderr).toContain('"Duplicate" matches 2 candidates; using Duplicate');
  });

  it("an unambiguous name writes the file with nothing on stderr", async () => {
    search.mockImplementation(async (term: string) => (term === "Duplicate" ? DUPLICATES.slice(0, 1) : []));
    const out = join(home, "bundle.json");
    const { stderr, exitCode } = await context(["Duplicate", "--format", "json", "--out", out]);
    expect(exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(stderr).not.toContain("candidates");
  });

  it("--strict still refuses to guess: ambiguous_target, exit 2, no file", async () => {
    const out = join(home, "bundle.json");
    const { stdout, exitCode } = await context(["Duplicate", "--format", "json", "--out", out, "--strict"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("ambiguous_target");
    expect(existsSync(out)).toBe(false);
  });
});
