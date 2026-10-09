// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `ix doctor` with a $IX_HOME/config.yaml that does not parse. `loadConfig()`
// throws ConfigParseError for that file (every other command stops on it), and
// doctor used to stop on it too, before its own "Config file parses" check ran.
// Nothing about the config layer is mocked here: the point is what the real
// loadConfig does to doctor.

const endpointsSeen: string[] = [];

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    constructor(readonly endpoint: string = "http://localhost:8090") {
      endpointsSeen.push(endpoint);
    }
    async stats() { return { nodes: { total: 10 }, edges: { total: 20 } }; }
    async conflicts() { return []; }
    async fetchCapabilities() { return {}; }
    async currentRevision() { return { rev: 1 }; }
  },
}));

vi.mock("../resolve.js", async (orig) => ({
  ...(await orig<typeof import("../resolve.js")>()),
  resolveReadSystemId: async () => undefined,
}));

vi.mock("../remote.js", async (orig) => ({
  ...(await orig<typeof import("../remote.js")>()),
  isCloudReady: async () => false,
}));

// No docker inspect or socket connects: see doctor-stats-once.test.ts.
vi.mock("../backend-status.js", async (orig) => ({
  ...(await orig<typeof import("../backend-status.js")>()),
  checkBackendImage: () => ({ kind: "docker-unavailable" as const }),
  checkBackendSchema: async () => ({ ok: true as const }),
  isNonStandardBackend: () => false,
}));

vi.mock("../commands/upgrade.js", async (orig) => ({
  ...(await orig<typeof import("../commands/upgrade.js")>()),
  readBackendHealth: async () => ({ status: "ok", schema_version: 3, database: "reachable" }),
}));

const BROKEN = "endpoint: [unclosed\nworkspaces:\n  - workspace_id: abc\n";

let savedEndpoint: string | undefined;
let savedHome: string | undefined;
let savedToken: string | undefined;
let savedExitCode: number | string | undefined;
let configPath: string;

beforeEach(() => {
  vi.resetModules();
  endpointsSeen.length = 0;
  savedEndpoint = process.env.IX_ENDPOINT;
  process.env.IX_ENDPOINT = "http://127.0.0.1:9";
  savedToken = process.env.IX_TOKEN;
  delete process.env.IX_TOKEN;
  savedHome = process.env.IX_HOME;
  process.env.IX_HOME = mkdtempSync(join(tmpdir(), "ix-doctor-broken-"));
  configPath = join(process.env.IX_HOME, "config.yaml");
  writeFileSync(configPath, BROKEN);
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  if (savedEndpoint === undefined) delete process.env.IX_ENDPOINT;
  else process.env.IX_ENDPOINT = savedEndpoint;
  if (savedToken === undefined) delete process.env.IX_TOKEN;
  else process.env.IX_TOKEN = savedToken;
  rmSync(process.env.IX_HOME!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = savedHome;
  process.exitCode = savedExitCode;
});

async function runDoctor(format: string): Promise<{ out: string[]; err: string[] }> {
  const { registerDoctorCommand } = await import("../commands/doctor.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerDoctorCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...args) => err.push(args.join(" ")));
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });
  try {
    await program.parseAsync(["doctor", "--format", format], { from: "user" });
  } catch (e) {
    // Doctor itself throwing is the bug: record it so the assertions see it.
    err.push(`THREW: ${(e as Error)?.stack ?? String(e)}`);
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return { out, err };
}

const escapedPath = () => configPath.replace(/\\/g, "\\\\");

describe("ix doctor with a config.yaml that does not parse", () => {
  it("still runs the other checks, fails 'Config file parses' naming the file, and exits 1", async () => {
    const { out, err } = await runDoctor("llm");
    const all = [...out, ...err].join("\n");

    expect(err.join("\n")).not.toContain("THREW");
    expect(out[0]).toContain("healthy=false");
    expect(process.exitCode).toBe(1);

    const configLine = out.find((l) => l.includes('name="Config file parses"'));
    expect(configLine).toMatch(/status=fail/);
    expect(configLine).toContain(escapedPath());
    // What is true: other commands stop on this file. Not "runs on defaults".
    expect(configLine).toMatch(/refuse to run until it is fixed/);
    expect(all).not.toMatch(/runs on defaults/);
    // The parser's message, first line only, and no stack trace anywhere.
    expect(configLine).toMatch(/does not parse, so .*until it is fixed: \S/);
    expect(all).not.toMatch(/\n\s+at\s/);
    expect(all).not.toMatch(/ConfigParseError/);

    // The checks that do not need the config ran and answered.
    expect(out).toContain('check name="Server reachable" status=ok detail="http://127.0.0.1:9 → ok"');
    expect(out.find((l) => l.includes('name="Database reachable"'))).toMatch(/status=ok/);
    expect(out.find((l) => l.includes('name="No unresolved conflicts"'))).toMatch(/status=ok detail=clean/);

    // The ones that do say they were not checked, rather than guessing.
    for (const name of [
      "Workspace for this directory",
      "No stray nested workspaces",
      "Completed map for this workspace",
      "Graph has nodes",
      "Graph has edges",
    ]) {
      expect(out).toContain(`check name="${name}" status=ok detail="not checked: config.yaml does not parse"`);
    }
  });

  it("falls back to the default endpoint when IX_ENDPOINT is unset", async () => {
    delete process.env.IX_ENDPOINT;

    const { out, err } = await runDoctor("llm");

    expect(err.join("\n")).not.toContain("THREW");
    expect(endpointsSeen).toContain("http://localhost:8090");
    expect(out).toContain('check name="Server reachable" status=ok detail="http://localhost:8090 → ok"');
    expect(process.exitCode).toBe(1);
  });

  it("keeps the JSON shape and adds the failing check to it", async () => {
    const { out, err } = await runDoctor("json");

    expect(err.join("\n")).not.toContain("THREW");
    const body = JSON.parse(out.join(""));
    expect(body).toMatchObject({ healthy: false, hasWarnings: expect.any(Boolean) });
    expect(Array.isArray(body.checks)).toBe(true);
    const check = body.checks.find((c: { name: string }) => c.name === "Config file parses");
    expect(check).toMatchObject({ ok: false });
    expect(check.detail).toContain(configPath);
    expect(check.detail).not.toMatch(/\n\s+at\s/);
    expect(process.exitCode).toBe(1);
  });
});
