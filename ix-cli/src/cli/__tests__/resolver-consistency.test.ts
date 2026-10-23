// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command, CommanderError } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetReadScope } from "../resolve.js";

/**
 * Every content-producing resolver command honours --pick, --kind and --path
 * the same way: given two candidates of one name, each flag makes the command
 * ask the backend about the selected candidate and never about the other one.
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

type Register = (program: Command) => void;
type LoadRegister = () => Promise<Register>;

/** The command, the arguments before the target, and where it registers. */
const COMMANDS: ReadonlyArray<readonly [string, readonly string[], LoadRegister]> = [
  ["read", ["read"], async () => (await import("../commands/read.js")).registerReadCommand],
  ["overview", ["overview"], async () => (await import("../commands/overview.js")).registerOverviewCommand],
  ["locate", ["locate"], async () => (await import("../commands/locate.js")).registerLocateCommand],
  ["history", ["history"], async () => (await import("../commands/history.js")).registerHistoryCommand],
  ["diff", ["diff", "3", "5"], async () => (await import("../commands/diff.js")).registerDiffCommand],
  ["depends", ["depends"], async () => (await import("../commands/depends.js")).registerDependsCommand],
  ["callers", ["callers"], async () => (await import("../commands/callers.js")).registerCallersCommand],
  ["contains", ["contains"], async () => (await import("../commands/contains.js")).registerContainsCommand],
  ["imports", ["imports"], async () => (await import("../commands/imports.js")).registerImportsCommand],
  ["impact", ["impact"], async () => (await import("../commands/impact.js")).registerImpactCommand],
  ["explain", ["explain"], async () => (await import("../commands/explain.js")).registerExplainCommand],
];

function node(id: string, kind: string, sourceUri: string) {
  return { id, kind, name: "Duplicate", attrs: {}, provenance: { sourceUri } };
}

/** Two same-named functions: only --pick or --path can choose between them. */
const SAME_KIND = [node("first-id", "function", "src/first.ts"), node("second-id", "function", "src/second.ts")];
/** A class and a function: unfiltered, the class wins; --kind function must reach the function. */
const MIXED_KIND = [node("first-id", "class", "src/first.ts"), node("second-id", "function", "src/second.ts")];

/** Search answers like the backend: by name substring, narrowed by kind when one is asked for. */
function serve(nodes: ReturnType<typeof node>[]) {
  client.search.mockImplementation(async (term: string, opts?: { kind?: string }) =>
    nodes.filter((n) => n.name.toLowerCase().includes(term.toLowerCase()) && (!opts?.kind || n.kind === opts.kind)));
  client.entity.mockImplementation(async (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return { node: { id, kind: n?.kind ?? "function", name: "Duplicate", provenance: { sourceUri: n?.provenance.sourceUri } } };
  });
}

/** Every entity id the command asked the backend about, after resolution. */
function requestedIds(): string[] {
  return [
    ...client.entity.mock.calls.map(([id]) => id),
    ...client.expand.mock.calls.map(([id]) => id),
    ...client.provenance.mock.calls.map(([id]) => id),
    ...client.diff.mock.calls.map(([, , opts]) => opts?.entityId),
  ].filter((id): id is string => typeof id === "string");
}

async function run(register: Register, args: string[]): Promise<void> {
  const program = new Command().name("ix").exitOverride();
  register(program);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  try {
    await program.parseAsync([...args, "--format", "json"], { from: "user" });
  } catch (err) {
    // What a command does after resolving (read finding no source file, for
    // one) is not this suite's question; which id it asked for is.
    if (!(err instanceof CommanderError)) throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
}

let dir: string;
let savedCwd: string;
let savedExitCode: typeof process.exitCode;
let savedIxHome: string | undefined;

beforeEach(() => {
  // read looks on disk after resolving; keep it off the real checkout and ~/.ix.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ix-resolver-")));
  savedIxHome = process.env.IX_HOME;
  process.env.IX_HOME = path.join(dir, ".ix");
  savedCwd = process.cwd();
  process.chdir(dir);
  resetReadScope();
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  for (const fn of Object.values(client)) fn.mockReset();
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

describe("resolver flag consistency across content commands", () => {
  describe.each(COMMANDS)("%s", (_command, prefix, loadRegister) => {
    it("--pick 2 selects the second candidate", async () => {
      serve(SAME_KIND);
      await run(await loadRegister(), [...prefix, "Duplicate", "--pick", "2"]);
      expect(requestedIds()).toContain("second-id");
      expect(requestedIds()).not.toContain("first-id");
    });

    it("--path selects the candidate under that path", async () => {
      serve(SAME_KIND);
      await run(await loadRegister(), [...prefix, "Duplicate", "--path", "second.ts"]);
      expect(requestedIds()).toContain("second-id");
      expect(requestedIds()).not.toContain("first-id");
    });

    it("--kind selects the candidate of that kind", async () => {
      serve(MIXED_KIND);
      await run(await loadRegister(), [...prefix, "Duplicate", "--kind", "function"]);
      expect(requestedIds()).toContain("second-id");
      expect(requestedIds()).not.toContain("first-id");
    });
  });
});

describe("test isolation", () => {
  // afterEach must put back an IX_HOME the worker already had, not delete it.
  const ambient = path.join(os.tmpdir(), "ix-resolver-ambient-ix-home");
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
