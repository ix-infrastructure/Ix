// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { parse } from "yaml";

import {
  assertStaleWorkspacePruneAllowed,
  ensureWorkspaceIdState,
  pinnedWorkspaceIdWarning,
  resetWorkspaceIdMemosForTests,
  staleWorkspaceCleanup,
  workspaceStateFor,
} from "../bootstrap.js";
import { registerIngestCommand } from "../commands/ingest.js";
import { workspaceIdForPath } from "../system.js";

/**
 * A registered workspace_id that differs from the path-derived one is honoured.
 *
 * It used to be re-keyed to the path id silently, and the next clean ingest
 * then deleted the old id's whole workspace. On a shared backend that wiped a
 * pinned workspace for everyone whenever one user's clone sat at a different
 * absolute path from the root the id was derived from. Re-keying is now
 * `--prune-stale-workspace`, and the deletion it carries only ever runs
 * against a loopback endpoint.
 */

// ── A fake backend: answers the ingest path, records every request ──────────
const requests: { method: string; url: string; body: string }[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      const url = (req.url ?? "").split("?")[0];
      const json = (v: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (url === "/v1/patches/batch") {
        const n = (() => { try { return (JSON.parse(body) as unknown[]).length; } catch { return 0; } })();
        return json(Array.from({ length: n }, (_, i) => ({ status: "Ok", rev: i + 1 })));
      }
      if (url === "/v1/patches/bulk" || url === "/v1/patch") return json({ status: "Ok", rev: 1 });
      if (url === "/v1/source-hashes/exists") return json({ exists: false });
      if (url === "/v1/source-hashes") return json([]);
      if (url === "/v1/stitch") return json({ stitched: 0, systemId: null, edges: [] });
      if (url.startsWith("/v1/stitch/system/")) return json({ systemId: null });
      if (url === "/v1/health") return json({ status: "ok" });
      return json({});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const deletes = () => requests.filter((r) => r.url.startsWith("/v1/reset"));

// ── Per-test IX_HOME and workspace ──────────────────────────────────────────
let t: string;
let ws: string;
let configPath: string;
let savedCwd: string;
const savedEnv = { IX_HOME: process.env.IX_HOME, IX_ENDPOINT: process.env.IX_ENDPOINT };

// Quoted: an 8-hex id can read as a number to YAML (see bootstrap-migration.test.ts).
const PINNED = "abcd1234";

function writeConfig(endpoint: string, workspaces: { id: string; root: string; name: string }[]): void {
  fs.writeFileSync(configPath, [
    `endpoint: ${endpoint}`,
    "format: text",
    "workspaces:",
    ...workspaces.flatMap((w, i) => [
      `  - workspace_id: "${w.id}"`,
      `    workspace_name: ${w.name}`,
      `    root_path: ${w.root}`,
      `    default: ${i === 0}`,
    ]),
    "",
  ].join("\n"));
}

function registeredIds(): Record<string, string> {
  const cfg = parse(fs.readFileSync(configPath, "utf8")) as { workspaces?: { root_path: string; workspace_id: string }[] };
  return Object.fromEntries((cfg.workspaces ?? []).map((w) => [w.root_path, String(w.workspace_id)]));
}

beforeEach(() => {
  t = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ix-pinned-ws-")));
  ws = path.join(t, "clone");
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(t, "home"));
  fs.writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
  configPath = path.join(t, "home", "config.yaml");
  process.env.IX_HOME = path.join(t, "home");
  process.env.IX_ENDPOINT = baseUrl;
  savedCwd = process.cwd();
  process.chdir(ws);
  requests.length = 0;
  resetWorkspaceIdMemosForTests();
  // Sanity: the pinned id is not what this clone's path derives.
  expect(workspaceIdForPath(ws)).not.toBe(PINNED);
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  fs.rmSync(t, { recursive: true, force: true });
});

async function runIngest(args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as never);
  process.exitCode = undefined;
  const program = new Command().exitOverride();
  registerIngestCommand(program);
  let exitCode: number;
  try {
    await program.parseAsync(["ingest", ...args], { from: "user" });
    exitCode = Number(process.exitCode ?? 0);
  } catch (thrown) {
    const m = /^exit (\d+)$/.exec((thrown as Error).message);
    if (!m) err.push((thrown as Error).message);
    exitCode = m ? Number(m[1]) : 1;
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

describe("a pinned workspace_id is honoured", () => {
  it("keeps the pinned id for a clone at a different path, and warns once", () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const errs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { errs.push(String(c)); return true; });

    const first = ensureWorkspaceIdState(ws);
    const second = workspaceStateFor(ws);

    expect(first).toEqual(expect.objectContaining({ workspaceId: PINNED, migrated: false, previousWorkspaceId: undefined }));
    expect(second).toEqual(expect.objectContaining({ workspaceId: PINNED, migrated: false, pending: false }));
    expect(registeredIds()[ws]).toBe(PINNED);
    const warnings = errs.filter((e) => e.includes("Keeping " + PINNED));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(pinnedWorkspaceIdWarning(ws, PINNED, workspaceIdForPath(ws)));
  });

  it("re-keys only when asked (adoptPathId), reporting the previous id", () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const state = ensureWorkspaceIdState(ws, { adoptPathId: true });
    expect(state).toEqual(expect.objectContaining({ workspaceId: workspaceIdForPath(ws), migrated: true, previousWorkspaceId: PINNED }));
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
  });

  it("ix ingest: a pinned id is neither re-keyed nor deleted after a clean ingest", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const r = await runIngest([ws, "--format", "json"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).toContain(`Keeping ${PINNED}`);
    expect(registeredIds()[ws]).toBe(PINNED);
    expect(deletes()).toEqual([]);
    // The patches went out under the pinned id, not the path-derived one.
    const committed = requests.filter((q) => q.url.startsWith("/v1/patch")).map((q) => q.body).join("");
    expect(committed).toContain(PINNED);
    expect(committed).not.toContain(workspaceIdForPath(ws));
  }, 60_000);

  it("ix ingest: an ordinary single-user workspace is unchanged -- no warning, no re-key, no delete", async () => {
    writeConfig(baseUrl, [{ id: workspaceIdForPath(ws), root: ws, name: "clone" }]);
    const r = await runIngest([ws, "--format", "json"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).not.toContain("Keeping");
    expect(r.err).not.toContain("Re-keyed");
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    expect(deletes()).toEqual([]);
  }, 60_000);
});

describe("--prune-stale-workspace", () => {
  it("re-keys and deletes the old id's graph on a loopback backend after a clean ingest", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const r = await runIngest([ws, "--format", "json", "--prune-stale-workspace"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    expect(deletes().map((d) => JSON.parse(d.body))).toEqual([{ workspaceId: PINNED }]);
    expect(r.err).toContain(`Deleted the previous workspace graph ${PINNED}`);
  }, 60_000);

  it("keeps the old graph when another registered root still uses that id", async () => {
    const other = path.join(t, "other");
    fs.mkdirSync(other);
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }, { id: PINNED, root: other, name: "other" }]);
    const r = await runIngest([ws, "--format", "json", "--prune-stale-workspace"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(deletes()).toEqual([]);
    expect(r.err).toContain(`Kept the previous workspace graph ${PINNED}`);
  }, 60_000);

  it("is refused on a non-loopback endpoint before anything changes or is sent", async () => {
    // Never contacted: the refusal comes first.
    process.env.IX_ENDPOINT = "https://ix.example.com";
    writeConfig("https://ix.example.com", [{ id: PINNED, root: ws, name: "clone" }]);
    const before = fs.readFileSync(configPath, "utf8");
    const r = await runIngest([ws, "--format", "json", "--prune-stale-workspace"]);

    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("only runs against a local (loopback) backend");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(requests).toEqual([]);
  });
});

describe("staleWorkspaceCleanup: the deletion rule", () => {
  const base = {
    migrated: true,
    previousWorkspaceId: PINNED,
    currentWorkspaceId: "11112222",
    pruneOptIn: true,
    endpoint: "http://localhost:8090",
    ingestClean: true,
    otherRegisteredIds: [] as string[],
  };

  it("deletes only when opted in, re-keyed, clean, unshared and loopback", () => {
    expect(staleWorkspaceCleanup(base)).toEqual({ action: "delete", workspaceId: PINNED });
  });

  it("never deletes without the opt-in", () => {
    expect(staleWorkspaceCleanup({ ...base, pruneOptIn: false })).toEqual(expect.objectContaining({ action: "keep", reason: "not_opted_in" }));
  });

  it.each([
    "https://ix.example.com",
    "http://10.0.0.5:8090",
    "http://192.168.1.20:8090",
    "http://127.0.0.1.example.com:8090",
    "http://team-graph:8090",
    "not a url",
  ])("never deletes on a non-loopback endpoint (%s), even opted in", (endpoint) => {
    expect(staleWorkspaceCleanup({ ...base, endpoint })).toEqual(expect.objectContaining({ action: "keep", reason: "non_local_endpoint" }));
    expect(() => assertStaleWorkspacePruneAllowed(endpoint)).toThrow(/loopback/);
  });

  it.each(["http://localhost:8090", "http://127.0.0.1:9999", "http://[::1]:8090"])("allows loopback %s", (endpoint) => {
    expect(staleWorkspaceCleanup({ ...base, endpoint }).action).toBe("delete");
    expect(() => assertStaleWorkspacePruneAllowed(endpoint)).not.toThrow();
  });

  it("keeps the graph after an unclean ingest, a shared id, or no re-key", () => {
    expect(staleWorkspaceCleanup({ ...base, ingestClean: false })).toEqual(expect.objectContaining({ reason: "ingest_unclean" }));
    expect(staleWorkspaceCleanup({ ...base, otherRegisteredIds: [PINNED] })).toEqual(expect.objectContaining({ reason: "shared_in_config" }));
    expect(staleWorkspaceCleanup({ ...base, migrated: false })).toEqual(expect.objectContaining({ reason: "not_migrated" }));
    expect(staleWorkspaceCleanup({ ...base, previousWorkspaceId: base.currentWorkspaceId })).toEqual(expect.objectContaining({ reason: "not_migrated" }));
  });
});
