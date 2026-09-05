import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

type FakeWorkspace = { workspace_id: string; workspace_name: string; root_path: string; default: boolean };

// The workspace cwd belongs to, and an unrelated one that happens to be the
// registered default. Keeping both named makes it visible in the assertions
// which repo a count was taken from.
const CURRENT: FakeWorkspace =
  { workspace_id: "workspace-current", workspace_name: "current-repo", root_path: "/repos/current", default: false };
const OTHER: FakeWorkspace =
  { workspace_id: "workspace-other", workspace_name: "other-repo", root_path: "/repos/other", default: true };

const statsCalls: Array<{ workspaceId?: string; systemId?: string } | undefined> = [];
const scope = {
  matched: undefined as FakeWorkspace | undefined,
  fallback: undefined as FakeWorkspace | undefined,
  systemId: undefined as string | undefined,
  sourceBaseline: true,
  mapCompleted: true,
  cloudReady: false,
};

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async stats(opts?: { workspaceId?: string; systemId?: string }) {
      statsCalls.push(opts);
      // Both ids undefined is the unscoped call, not a match on a scope that
      // happens to be unset — compare only ids that are actually present, or
      // `undefined === undefined` silently answers with the workspace figure.
      if (opts?.systemId !== undefined) return { nodes: { total: 3457 }, edges: { total: 10365 } };
      if (opts?.workspaceId === CURRENT.workspace_id) return { nodes: { total: 3457 }, edges: { total: 10365 } };
      // Deliberately distinct so a count sourced from the wrong workspace cannot
      // coincide with the right one's.
      if (opts?.workspaceId === OTHER.workspace_id) return { nodes: { total: 7717 }, edges: { total: 16983 } };
      return { nodes: { total: 22969 }, edges: { total: 10365 } };
    }
    async conflicts() { return []; }
    async health() { return { status: "ok" }; }
  },
}));

// Mocked at the config layer, not at `resolveWorkspaceId`. Stubbing that helper
// is what let #518 through: it returns one id for both "cwd matched this
// workspace" and "cwd matched nothing, so here is the default", so a test that
// replaces it can never exercise the difference.
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  findWorkspaceForCwd: () => scope.matched,
  getDefaultWorkspace: () => scope.fallback,
}));

vi.mock("../resolve.js", async (orig) => ({
  ...(await orig<typeof import("../resolve.js")>()),
  resolveReadSystemId: async () => scope.systemId,
}));

// The two completion markers, mocked separately because the check has to tell
// them apart: a missing source baseline and a missing map marker are different
// states with different verdicts.
vi.mock("../stale.js", async (orig) => ({
  ...(await orig<typeof import("../stale.js")>()),
  hasCompletedMapBaseline: () => scope.mapCompleted,
}));

vi.mock("../ingest-baseline.js", async (orig) => ({
  ...(await orig<typeof import("../ingest-baseline.js")>()),
  loadIngestBaseline: () => scope.sourceBaseline
    ? {
      files: new Map<string, number>(),
      deletedFiles: new Map<string, string[]>(),
      currentRev: 42,
      lastIngestAt: "2026-01-01T00:00:00.000Z",
    }
    : null,
}));

vi.mock("../remote.js", async (orig) => ({
  ...(await orig<typeof import("../remote.js")>()),
  isCloudReady: async () => scope.cloudReady,
}));

// Doctor also inspects the live container and probes the schema. Both are
// mocked, not merely pointed somewhere harmless: an unmocked `docker inspect`
// or socket connect is slow-and-variable rather than fast-and-failing, which is
// how this test timed out at 5s on the Windows runner while passing on Linux.
vi.mock("../backend-status.js", async (orig) => ({
  ...(await orig<typeof import("../backend-status.js")>()),
  checkBackendImage: () => ({ kind: "docker-unavailable" as const }),
  checkBackendSchema: async () => ({ ok: true as const }),
  isNonStandardBackend: () => false,
}));

vi.mock("../commands/upgrade.js", async (orig) => ({
  ...(await orig<typeof import("../commands/upgrade.js")>()),
  readBackendHealth: async () => ({ status: "ok", schema_version: 3 }),
}));

let savedEndpoint: string | undefined;
let savedExitCode: number | string | undefined;

beforeEach(() => {
  vi.resetModules();
  statsCalls.length = 0;
  scope.matched = CURRENT;
  scope.fallback = undefined;
  scope.systemId = undefined;
  scope.sourceBaseline = true;
  scope.mapCompleted = true;
  scope.cloudReady = false;
  // Belt and braces with the mocks above: nothing in this test may depend on a
  // backend being reachable, or on how quickly a given OS refuses a connection.
  savedEndpoint = process.env.IX_ENDPOINT;
  process.env.IX_ENDPOINT = "http://127.0.0.1:9";
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  if (savedEndpoint === undefined) delete process.env.IX_ENDPOINT;
  else process.env.IX_ENDPOINT = savedEndpoint;
  process.exitCode = savedExitCode;
});

async function runDoctor(): Promise<string[]> {
  const { registerDoctorCommand } = await import("../commands/doctor.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerDoctorCommand(program);
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await program.parseAsync(["doctor", "--format", "llm"], { from: "user" });
  } catch { /* exitOverride / process.exit path */ } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return lines;
}

describe("ix doctor", () => {
  /**
   * "Graph has nodes" and "Graph has edges" are two questions about one
   * response, and they were two `client.stats()` calls run back to back by the
   * sequential check loop. `/v1/stats` is 3-4s on a large graph, so the second
   * one was roughly half of what `ix doctor` spent.
   */
  it("asks the backend for stats once, not once per check that reads it", async () => {
    await runDoctor();
    expect(statsCalls).toHaveLength(1);
  });

  it("reports active workspace counts rather than unscoped tombstones", async () => {
    const lines = await runDoctor();

    expect(statsCalls).toEqual([{ workspaceId: "workspace-current", systemId: undefined }]);
    expect(lines).toContain(`check name="Graph has nodes" status=ok detail="3457 nodes in workspace 'current-repo'"`);
  });

  it("names the workspace cwd resolved to", async () => {
    const lines = await runDoctor();

    expect(lines).toContain(`check name="Workspace for this directory" status=ok detail="workspace 'current-repo'"`);
  });

  it("reports the recorded revision when both completion markers are current", async () => {
    const lines = await runDoctor();

    expect(lines[0]).toContain("healthy=true");
    expect(lines).toContain(
      'check name="Completed map for this workspace" status=ok detail="recorded at revision 42"',
    );
  });

  it("does not report a partial graph as healthy when no completed baseline exists", async () => {
    scope.sourceBaseline = false;
    scope.mapCompleted = false;

    const lines = await runDoctor();

    expect(lines[0]).toContain("healthy=false");
    expect(process.exitCode).toBe(1);
    expect(lines).toContain(
      'check name="Completed map for this workspace" status=fail detail="no completed map baseline — the graph may be partial. Run `ix map`."',
    );
  });

  it("fails a clean source graph that has no architecture map for its revision", async () => {
    scope.mapCompleted = false;

    const lines = await runDoctor();

    expect(lines[0]).toContain("healthy=false");
    expect(lines).toContain(
      'check name="Completed map for this workspace" status=fail ' +
      'detail="source graph at revision 42 has no completed architecture map — run `ix map`"',
    );
  });

  it("warns rather than fails when a cloud runner explains the missing local baseline", async () => {
    // The cloud runner writes no local baseline by design, so absence is not
    // evidence of a partial graph there — and calling it a failure would make
    // `ix doctor` permanently unhealthy on a perfectly good cloud workspace.
    scope.sourceBaseline = false;
    scope.mapCompleted = false;
    scope.cloudReady = true;

    const lines = await runDoctor();

    expect(lines[0]).toContain("healthy=true");
    expect(process.exitCode).toBeUndefined();
    expect(lines).toContain(
      'check name="Completed map for this workspace" status=warn ' +
      'detail="no local baseline — expected for a cloud-ingested workspace"',
    );
  });

  it("uses the active system scope for a co-ingested workspace", async () => {
    scope.systemId = "system-current";

    const lines = await runDoctor();

    expect(statsCalls).toEqual([{ workspaceId: undefined, systemId: "system-current" }]);
    expect(lines).toContain('check name="Graph has nodes" status=ok detail="3457 nodes in this system"');
  });

  it("says the count is unscoped when no workspace is registered", async () => {
    // A count of everything is not wrong here, but it is the one case where
    // naming a scope would be — there is no active workspace to name.
    scope.matched = undefined;
    scope.fallback = undefined;

    const lines = await runDoctor();

    expect(lines).toContain('check name="Graph has nodes" status=ok detail="22969 nodes in all workspaces"');
    expect(lines).toContain(
      'check name="Workspace for this directory" status=warn detail="none registered yet — run `ix map`"',
    );
  });

  describe("a directory no workspace is registered for (#518)", () => {
    // cwd matches nothing, and an unrelated repo holds `default: true`.
    beforeEach(() => {
      scope.matched = undefined;
      scope.fallback = OTHER;
    });

    it("does not report the run as healthy", async () => {
      const lines = await runDoctor();

      // The whole of #518: this said healthy=true, so "All checks passed" is
      // what a reader acted on.
      expect(lines[0]).toContain("healthy=false");
      expect(process.exitCode).toBe(1);
      // cwd reaches the assertion through the llm format's quoting, which
      // escapes `\`. A Windows path therefore renders as `D:\\a\\Ix`, not as the
      // raw `process.cwd()` — escape it here rather than compare against the
      // unescaped string, which passes on POSIX and fails on Windows for a
      // reason that has nothing to do with the check under test.
      const cwd = process.cwd().replace(/\\/g, "\\\\");
      expect(lines).toContain(
        'check name="Workspace for this directory" status=fail detail="no workspace registered for ' +
          `${cwd} — reads here answer from workspace 'other-repo' instead. ` +
          'Run `ix map` in this directory."',
      );
    });

    it("attributes the counts to the workspace they came from, not to this directory", async () => {
      const lines = await runDoctor();

      expect(lines).toContain(`check name="Graph has nodes" status=ok detail="7717 nodes in workspace 'other-repo'"`);
      expect(lines).toContain(`check name="Graph has edges" status=ok detail="16983 edges in workspace 'other-repo'"`);
      // The deictic phrasing is the misleading part — it must not survive for a
      // directory that resolved to someone else's graph.
      expect(lines.join("\n")).not.toContain("in this workspace");
    });
  });
});
