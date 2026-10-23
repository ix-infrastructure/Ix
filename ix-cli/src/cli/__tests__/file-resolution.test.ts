// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The shared file-first resolution helper, and the commands that take a file
 * or entity target, checked by what they do: which file a target resolves to,
 * in which order the graph is asked, and which id reaches the backend.
 */

// Graph reads refuse a directory no workspace covers (workspace_not_mapped),
// and this suite runs from a tmp directory that is not registered anywhere. It
// is about resolution, not scoping, so the directory counts as mapped here.
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const client = vi.hoisted(() => ({
  search: vi.fn(),
  entity: vi.fn(),
  expand: vi.fn(),
  provenance: vi.fn(),
  diff: vi.fn(),
  listPatches: vi.fn(),
  resolvePrefix: vi.fn(),
}));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return client.search(...args); }
    async entity(...args: unknown[]) { return client.entity(...args); }
    async expand(...args: unknown[]) { return client.expand(...args); }
    async provenance(...args: unknown[]) { return client.provenance(...args); }
    async diff(...args: unknown[]) { return client.diff(...args); }
    async listPatches(...args: unknown[]) { return client.listPatches(...args); }
    async resolvePrefix(...args: unknown[]) { return client.resolvePrefix(...args); }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

vi.mock("../hierarchy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hierarchy.js")>(),
  getSystemPath: async () => [],
  getEffectiveSystemPath: async () => [],
  bucketByHierarchy: async () => [],
}));

import { looksFileLike, resetReadScope, resolveFileOrEntityFull } from "../resolve.js";
import { registerHistoryCommand } from "../commands/history.js";
import { registerDiffCommand } from "../commands/diff.js";

function node(id: string, name: string, kind: string, sourceUri: string) {
  return { id, name, kind, attrs: {}, provenance: { sourceUri } };
}

/** A client whose search answers from a fixed list by case-insensitive substring, like the backend. */
function graph(nodes: ReturnType<typeof node>[]) {
  const search = vi.fn(async (term: string, opts?: { kind?: string }) =>
    nodes.filter((n) => n.name.toLowerCase().includes(term.toLowerCase()) && (!opts?.kind || n.kind === opts.kind)));
  return { search, workspaceSystem: async () => ({ systemId: null }) } as never as Parameters<typeof resolveFileOrEntityFull>[0] & { search: typeof search };
}

/** A client whose file search returns these files whatever the term, as a fuzzy backend window might. */
function fileWindow(files: ReturnType<typeof node>[]) {
  const search = vi.fn(async (_term: string, opts?: { kind?: string }) => (opts?.kind === "file" ? files : []));
  return { search, workspaceSystem: async () => ({ systemId: null }) } as never as Parameters<typeof resolveFileOrEntityFull>[0];
}

async function run(register: (program: Command) => void, args: string[]): Promise<{ stdout: string; command: Command }> {
  const program = new Command().name("ix").exitOverride();
  register(program);
  const stdout: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return { stdout: stdout.join("\n"), command: program.commands[0] };
}

const FILE_A = node("file-a-id", "a.ts", "file", "src/a.ts");

let dir: string;
let savedCwd: string;
let savedExitCode: typeof process.exitCode;
let savedIxHome: string | undefined;

beforeEach(() => {
  // A non-git directory of its own: nothing here touches the real checkout or
  // ~/.ix, and git has no repository to answer from.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ix-file-res-")));
  savedIxHome = process.env.IX_HOME;
  process.env.IX_HOME = path.join(dir, ".ix");
  savedCwd = process.cwd();
  process.chdir(dir);
  resetReadScope();
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  for (const fn of Object.values(client)) fn.mockReset();
  client.search.mockImplementation(async (term: string, opts?: { kind?: string }) =>
    [FILE_A].filter((n) => n.name.toLowerCase().includes(term.toLowerCase()) && (!opts?.kind || n.kind === opts.kind)));
  client.entity.mockImplementation(async (id: string) => ({ node: { ...FILE_A, id } }));
  client.expand.mockResolvedValue({ nodes: [], edges: [] });
  client.provenance.mockResolvedValue([]);
  client.diff.mockResolvedValue({ fromRev: 3, toRev: 5, changes: [], total: 0 });
  client.listPatches.mockResolvedValue([]);
  client.resolvePrefix.mockRejectedValue(new Error("not a prefix"));
});

afterEach(() => {
  process.exitCode = savedExitCode;
  process.chdir(savedCwd);
  if (savedIxHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = savedIxHome;
  resetReadScope();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("file-first resolution helper", () => {
  it("looksFileLike recognises paths and known extensions, not symbols", () => {
    for (const target of ["src/a.ts", "a\\b", "parser.py", "index.tsx"]) {
      expect(looksFileLike(target), target).toBe(true);
    }
    for (const target of ["Widget", "a.unknownext", "CompactionJob::Run"]) {
      expect(looksFileLike(target), target).toBe(false);
    }
  });

  it("resolveFileOrEntity tries file graph match before symbol resolution", async () => {
    const nodes = [node("f-parser", "parser.py", "file", "src/parser.py"), node("fn-parser", "parser", "function", "src/parser.py")];

    const asFile = graph(nodes);
    const fileResult = await resolveFileOrEntityFull(asFile, "parser.py", { format: "json" });
    expect(fileResult.resolved && fileResult.entity.id).toBe("f-parser");
    expect(asFile.search.mock.calls[0][1]).toMatchObject({ kind: "file", nameOnly: true });

    const asSymbol = graph(nodes);
    const symbolResult = await resolveFileOrEntityFull(asSymbol, "parser", { format: "json" });
    expect(symbolResult.resolved && symbolResult.entity.id).toBe("fn-parser");
  });

  it("tryFileGraphMatch scores exact path matches higher than basename matches", async () => {
    // Exact filename (quality 1) beats a bare-name match (quality 2), even at a longer uri.
    const byFilename = await resolveFileOrEntityFull(fileWindow([
      node("bare", "score.js", "file", "score.js"),
      node("exact-name", "score.ts", "file", "src/deep/ranking/score.ts"),
    ]), "score.ts", { format: "json" });
    expect(byFilename.resolved && byFilename.entity.id).toBe("exact-name");

    // Exact path (quality 0) beats an exact filename elsewhere, and says it was exact.
    const byPath = await resolveFileOrEntityFull(fileWindow([
      node("root-score", "score.ts", "file", "score.ts"),
      node("path-score", "score.ts", "file", "src/ranking/score.ts"),
    ]), "src/ranking/score.ts", { format: "json" });
    expect(byPath.resolved && byPath.entity).toMatchObject({ id: "path-score", resolutionMode: "exact" });

    // CL-19 touchpoint: two files of the same name at the same quality resolve
    // to the shorter uri today. CL-19 fix 1 makes this case ambiguous on
    // purpose; update this expectation with it rather than working around it.
    const byLength = await resolveFileOrEntityFull(fileWindow([
      node("deep-score", "score.ts", "file", "src/deep/score.ts"),
      node("short-score", "score.ts", "file", "a/score.ts"),
    ]), "score.ts", { format: "json" });
    expect(byLength.resolved && byLength.entity).toMatchObject({ id: "short-score", resolutionMode: "scored" });
  });
});

describe("history command uses file-first resolution", () => {
  it("accepts a target argument, not entityId", async () => {
    const program = new Command();
    registerHistoryCommand(program);
    const [target] = program.commands[0].registeredArguments;
    expect(target.name()).toBe("target");
    expect(target.required).toBe(true);
  });

  it("asks for the provenance of the resolved file", async () => {
    const { stdout } = await run(registerHistoryCommand, ["history", "src/a.ts", "--format", "json"]);
    expect(client.provenance).toHaveBeenCalledWith("file-a-id");
    expect(JSON.parse(stdout).resolvedTarget.kind).toBe("file");
  });
});

describe("diff command supports scoped target", () => {
  it("accepts optional third positional argument", () => {
    const program = new Command();
    registerDiffCommand(program);
    const target = program.commands[0].registeredArguments[2];
    expect(target.name()).toBe("target");
    expect(target.required).toBe(false);
  });

  it("passes resolved entity ID to diff API", async () => {
    await run(registerDiffCommand, ["diff", "3", "5", "src/a.ts", "--format", "json"]);
    expect(client.diff).toHaveBeenCalled();
    expect(client.diff.mock.calls.every(([, , opts]) => opts.entityId === "file-a-id")).toBe(true);
  });

  it("sends no entity ID without a target", async () => {
    await run(registerDiffCommand, ["diff", "3", "5", "--format", "json"]);
    expect(client.diff).toHaveBeenCalled();
    expect(client.diff.mock.calls.every(([, , opts]) => opts.entityId === undefined)).toBe(true);
  });

  it("--content reads source from disk using line spans into sourceContent", async () => {
    const file = path.join(dir, "f.ts");
    fs.writeFileSync(file, "line one\nline two\nline three\n");
    client.diff.mockResolvedValue({
      fromRev: 3,
      toRev: 5,
      total: 1,
      changes: [{
        changeType: "added",
        entityId: "fn-id",
        atToRev: { name: "added", kind: "function", attrs: { line_start: 2, line_end: 3 }, provenance: { source_uri: file } },
      }],
    });
    // The from side has a timestamp, and git has no repository here to read it
    // from, so the textual diff gives up and the graph-driven fallback answers.
    client.listPatches.mockResolvedValue([{ rev: 3, timestamp: "2026-01-01T00:00:00Z" }]);

    const { stdout } = await run(registerDiffCommand, ["diff", "3", "5", "--content", "--format", "json"]);
    expect(JSON.parse(stdout).changes[0].sourceContent).toBe("line two\nline three");
  });
});

type LoadRegister = () => Promise<(program: Command) => void>;

/** Graph commands that take a file or entity target. */
const COMMANDS_USING_FILE_RESOLUTION: ReadonlyArray<readonly [string, LoadRegister]> = [
  ["overview", async () => (await import("../commands/overview.js")).registerOverviewCommand],
  ["callers", async () => (await import("../commands/callers.js")).registerCallersCommand],
  ["contains", async () => (await import("../commands/contains.js")).registerContainsCommand],
  ["imports", async () => (await import("../commands/imports.js")).registerImportsCommand],
  ["depends", async () => (await import("../commands/depends.js")).registerDependsCommand],
  ["locate", async () => (await import("../commands/locate.js")).registerLocateCommand],
  ["impact", async () => (await import("../commands/impact.js")).registerImpactCommand],
  ["explain", async () => (await import("../commands/explain.js")).registerExplainCommand],
];

/** Every entity id a command asked the backend about, after resolution. */
function requestedIds(): string[] {
  return [
    ...client.entity.mock.calls.map(([id]) => id),
    ...client.expand.mock.calls.map(([id]) => id),
  ].filter((id): id is string => typeof id === "string");
}

describe("all graph commands use resolveFileOrEntity consistently", () => {
  it.each(COMMANDS_USING_FILE_RESOLUTION)("%s resolves a file path to the file entity", async (command, loadRegister) => {
    await run(await loadRegister(), [command, "src/a.ts", "--format", "json"]);
    expect(requestedIds()).toContain("file-a-id");
  });
});

describe("--pick support", () => {
  // --pick through each command is pick-option-validation.test.ts and
  // resolver-consistency.test.ts; applyPick on its own is pick-resolution.test.ts.
  it("--pick selects among ambiguous candidates by 1-based rank", async () => {
    const result = await resolveFileOrEntityFull(graph([
      node("first-id", "Duplicate", "function", "src/first.ts"),
      node("second-id", "Duplicate", "function", "src/second.ts"),
    ]), "Duplicate", { format: "json", pick: 2 });
    expect(result.resolved && result.entity.id).toBe("second-id");
  });
});

describe("ambiguous result structure", () => {
  it("ranks candidates 1..n and carries the ambiguous_resolution diagnostic", async () => {
    const result = await resolveFileOrEntityFull(graph([
      node("first-id", "Duplicate", "function", "src/first.ts"),
      node("second-id", "Duplicate", "function", "src/second.ts"),
    ]), "Duplicate", { format: "json" });
    expect(result.resolved).toBe(false);
    if (result.resolved || !result.ambiguous) throw new Error("expected an ambiguous result");
    expect(result.result.candidates.map((c) => c.rank)).toEqual([1, 2]);
    expect(result.result.diagnostics?.[0].code).toBe("ambiguous_resolution");
  });
});

describe("test isolation", () => {
  // afterEach must put back an IX_HOME the worker already had, not delete it.
  const ambient = path.join(os.tmpdir(), "ix-file-res-ambient-ix-home");
  beforeAll(() => {
    process.env.IX_HOME = ambient;
  });
  afterAll(() => {
    const after = process.env.IX_HOME;
    delete process.env.IX_HOME;
    expect(after).toBe(ambient);
  });
  it("points IX_HOME at the per-test temp dir while a test runs", () => {
    expect(process.env.IX_HOME).toBe(path.join(dir, ".ix"));
  });
});
