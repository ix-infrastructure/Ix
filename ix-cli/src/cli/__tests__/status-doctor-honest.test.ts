// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

/**
 * CL-17: `ix status` said "Graph is up to date" on the evidence of file mtimes
 * alone, `ix search` in a workspace with no nodes said "try part of the name",
 * and `ix doctor` passed with the database dead. Each now reports only what it
 * checked.
 */

// A backend whose /v1/stats answer each test sets.
let stats: unknown = { nodes: { total: 0 }, edges: { total: 0 } };
let rev = 1;
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.startsWith("/v1/health")) return send(200, { status: "ok", schema_version: 3, database: "reachable" });
      if (url.startsWith("/v1/revisions/current")) return send(200, { rev });
      if (url.startsWith("/v1/stats")) return send(200, stats);
      if (url.startsWith("/v1/stitch/system/")) return send(404, { error: "not_found" });
      if (url.startsWith("/v1/search")) return send(200, []);
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let home: string;
let repo: string;
let saved: Record<string, string | undefined>;
let cwd: string;
let out: string[];

beforeEach(() => {
  vi.resetModules();
  rev += 1; // a new backend revision: no cached graph verdict carries over
  home = mkdtempSync(join(tmpdir(), "ix-honest-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  saved = { IX_HOME: process.env.IX_HOME, IX_ENDPOINT: process.env.IX_ENDPOINT, IX_GRAPH_HEALTH: process.env.IX_GRAPH_HEALTH };
  process.env.IX_HOME = home;
  process.env.IX_ENDPOINT = endpoint;
  delete process.env.IX_GRAPH_HEALTH;
  cwd = process.cwd();
  process.chdir(repo);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
});

afterEach(() => {
  process.chdir(cwd);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function registerRepo(): void {
  writeFileSync(join(home, "config.yaml"),
    `endpoint: ${endpoint}\nformat: text\nworkspaces:\n  - workspace_id: "ws1"\n    workspace_name: repo\n    root_path: ${repo}\n    default: true\n`);
}

async function run(register: (p: Command) => void, args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  register(program);
  await program.parseAsync(args, { from: "user" });
  return out.join("\n");
}

const HOLLOW = {
  nodes: { total: 400, byKind: [{ kind: "file", count: 20 }, { kind: "function", count: 380 }] },
  edges: { total: 10, byPredicate: [{ predicate: "CALLS", count: 10 }] },
};

describe("ix status", () => {
  async function status(...args: string[]): Promise<string> {
    vi.doMock("../stale.js", async (orig) => ({
      ...(await orig<typeof import("../stale.js")>()),
      detectStaleFiles: () => ({
        graphCompleted: true, mapCompleted: true, currentRev: 7, lastIngestAt: null,
        staleFiles: 0, sampleChangedFiles: [], replayedFiles: [], parseTimeouts: [],
      }),
    }));
    const { registerStatusCommand } = await import("../commands/status.js");
    return run(registerStatusCommand, ["status", ...args]);
  }

  it("says what it checked: no files changed, and the graph is degraded", async () => {
    registerRepo();
    stats = HOLLOW;
    const text = await status();
    expect(text).not.toMatch(/Graph is up to date/);
    expect(text).toMatch(/No files changed since the last ingest/);
    expect(text).toMatch(/Graph:\s+degraded/);
    expect(text).toMatch(/ix reset --workspace --yes --ingest/);
  });

  it("adds graphHealth to JSON, keeping the existing fields", async () => {
    registerRepo();
    stats = HOLLOW;
    const json = JSON.parse(await status("--format", "json"));
    expect(json.graphCompleted).toBe(true);
    expect(json.mapCompleted).toBe(true);
    expect(json.graphHealth).toMatchObject({ status: "degraded", reason: "hollow" });
  });

  it("reports graph_health and the graph record in llm", async () => {
    registerRepo();
    stats = { nodes: { total: 0 }, edges: { total: 0 } };
    const llm = await status("--format", "llm");
    expect(llm).toMatch(/^status .*graph_health=empty/m);
    expect(llm).toMatch(/^graph status=empty reason=no_nodes/m);
  });

  it("says unverified, not ok, when the directory is in no workspace", async () => {
    stats = HOLLOW;
    const json = JSON.parse(await status("--format", "json"));
    expect(json.graphHealth.status).toBe("unverified");
  });
});

describe("ix search in a workspace with no nodes", () => {
  it("says the workspace is empty instead of suggesting another term", async () => {
    registerRepo();
    stats = { nodes: { total: 0 }, edges: { total: 0 } };
    const { registerSearchCommand } = await import("../commands/search.js");
    const json = JSON.parse(await run(registerSearchCommand, ["search", "greet", "--format", "json"]));
    const codes = json.diagnostics.map((d: { code: string }) => d.code);
    expect(codes).toContain("workspace_empty");
    expect(json.diagnostics.find((d: { code: string }) => d.code === "no_results").message).toMatch(/ix map/);
  });

  it("keeps the usual hint when the workspace has nodes", async () => {
    registerRepo();
    stats = { nodes: { total: 50, byKind: [], }, edges: { total: 60, byPredicate: [] } };
    const { registerSearchCommand } = await import("../commands/search.js");
    const llm = await run(registerSearchCommand, ["search", "greet", "--format", "llm"]);
    expect(llm).not.toMatch(/workspace_empty/);
    expect(llm).toMatch(/hint text="No entity name matches/);
  });
});

describe("doctor checks", () => {
  it("Database reachable: from the backend's own report, else from a read that touches it", async () => {
    const { assessDatabase } = await import("../commands/doctor.js");
    const never = async () => { throw new Error("must not probe"); };
    expect(await assessDatabase({ status: "ok", database: "reachable" }, never)).toMatchObject({ ok: true });
    expect(await assessDatabase({ status: "degraded", database: "unreachable" }, never))
      .toMatchObject({ ok: false, detail: expect.stringMatching(/ArangoDB/) });
    expect(await assessDatabase(new Error("fetch failed"), never)).toMatchObject({ ok: true, detail: expect.stringMatching(/skipped/) });
    // An older backend: health says nothing about the database.
    expect(await assessDatabase({ status: "ok" }, async () => ({ rev: 3 }))).toMatchObject({ ok: true });
    expect(await assessDatabase({ status: "ok" }, async () => { throw new Error("500: arango connection refused"); }))
      .toMatchObject({ ok: false, detail: expect.stringMatching(/could not read its database: 500/) });
  });

  it("a 503 health body is an answer, anything else is not", async () => {
    const { healthFromError } = await import("../commands/doctor.js");
    expect(healthFromError(new Error('503: {"status":"degraded","database":"unreachable"}')))
      .toEqual({ status: "degraded", database: "unreachable" });
    expect(healthFromError(new Error("503: <html>bad gateway</html>"))).toBeNull();
    expect(healthFromError(new Error('500: {"status":"x"}'))).toBeNull();
  });

  it("Config file parses", async () => {
    const { assessConfigFile } = await import("../commands/doctor.js");
    expect(assessConfigFile("c.yaml", () => null)).toMatchObject({ ok: true, detail: expect.stringMatching(/defaults/) });
    expect(assessConfigFile("c.yaml", () => "endpoint: http://localhost:8090\n")).toMatchObject({ ok: true });
    expect(assessConfigFile("c.yaml", () => "endpoint: [unclosed\n")).toMatchObject({ ok: false, detail: expect.stringMatching(/does not parse/) });
    expect(assessConfigFile("c.yaml", () => "- a\n- b\n")).toMatchObject({ ok: false });
  });

  it("ripgrep on PATH warns, never fails", async () => {
    const { checkRipgrep } = await import("../commands/doctor.js");
    expect(checkRipgrep(() => "ripgrep 15.1.0\n")).toEqual({ ok: true, detail: "ripgrep 15.1.0" });
    expect(checkRipgrep(() => { throw new Error("ENOENT"); })).toMatchObject({ ok: false, warn: true });
  });
});
