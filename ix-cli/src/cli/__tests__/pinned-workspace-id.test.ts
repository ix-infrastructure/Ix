// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { parse } from "yaml";

// `ix map` routes to a cloud runner when Pro reports one ready; the default
// here is local, and one test flips it.
const cloud = vi.hoisted(() => ({ ready: false, ran: false }));
vi.mock("../remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remote.js")>()),
  isCloudReady: async () => cloud.ready,
  getRemoteRunner: () => ({ runIngestion: async () => { cloud.ran = true; } }),
}));

import {
  assertStaleWorkspacePruneAllowed,
  bootstrap,
  ensureWorkspaceIdState,
  pinnedWorkspaceIdWarning,
  resetWorkspaceIdMemosForTests,
  staleWorkspaceCleanup,
  workspaceStateFor,
} from "../bootstrap.js";
import { registerIngestCommand } from "../commands/ingest.js";
import { registerMapCommand } from "../commands/map.js";
import { acquireMapLock } from "../single-flight.js";
import { workspaceIdForPath } from "../system.js";
import { loadWorkspaces, resetMalformedPruneWarningsForTests } from "../config.js";
import { createClient } from "../../client/factory.js";

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

// ── A fake backend: answers the ingest + map path, records every request ────
const requests: { method: string; url: string; body: string }[] = [];
// Per-test behaviour of the fake backend.
const mode = { failCommits: false, reset: "ok" as "ok" | "fail" | "redirect" };
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      const url = (req.url ?? "").split("?")[0];
      const json = (v: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (mode.failCommits && url.startsWith("/v1/patch")) return json({ error: "rejected" }, 422);
      if (url === "/v1/reset/workspace" && mode.reset === "redirect") {
        res.writeHead(307, { location: `${baseUrl}/redirected` });
        return res.end();
      }
      if (url === "/v1/reset/workspace" && mode.reset === "fail") return json({ error: "boom" }, 500);
      if (url === "/v1/map") return json({ file_count: 1, regions: [], levels: 0, map_rev: 1, outcome: "completed" });
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
const deletedIds = () => deletes().map((d) => (JSON.parse(d.body) as { workspaceId: string }).workspaceId);

// ── Per-test IX_HOME and workspace ──────────────────────────────────────────
let t: string;
let ws: string;
let configPath: string;
let savedCwd: string;
const savedEnv = { IX_HOME: process.env.IX_HOME, IX_ENDPOINT: process.env.IX_ENDPOINT };

// Quoted: an 8-hex id can read as a number to YAML (see bootstrap-migration.test.ts).
const PINNED = "abcd1234";

interface WsFixture { id: string; root: string; name: string; pinned?: boolean; extra?: string[] }

function writeConfig(endpoint: string, workspaces: WsFixture[]): void {
  fs.writeFileSync(configPath, [
    `endpoint: ${endpoint}`,
    "format: text",
    "workspaces:",
    ...workspaces.flatMap((w, i) => [
      `  - workspace_id: "${w.id}"`,
      `    workspace_name: ${w.name}`,
      `    root_path: ${w.root}`,
      `    default: ${i === 0}`,
      ...(w.pinned ? ["    pinned: true"] : []),
      ...(w.extra ?? []),
    ]),
    "",
  ].join("\n"));
}

interface CfgWs { root_path: string; workspace_id: string; pinned?: boolean; pending_prune_of?: { workspace_id: string; endpoint: string }[] }
function configWorkspaces(): CfgWs[] {
  return ((parse(fs.readFileSync(configPath, "utf8")) as { workspaces?: CfgWs[] }).workspaces ?? []);
}
function registeredIds(): Record<string, string> {
  return Object.fromEntries(configWorkspaces().map((w) => [w.root_path, String(w.workspace_id)]));
}
function pendingFor(root: string): { workspace_id: string; endpoint: string }[] | undefined {
  return configWorkspaces().find((w) => w.root_path === root)?.pending_prune_of;
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
  mode.failCommits = false;
  mode.reset = "ok";
  cloud.ready = false;
  cloud.ran = false;
  resetWorkspaceIdMemosForTests();
  resetMalformedPruneWarningsForTests();
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

type Run = { out: string; err: string; exitCode: number; fetches: number };

async function run(register: (p: Command) => void, args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as never);
  // Every request the CLI makes, to any host -- not only the fake backend.
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  process.exitCode = undefined;
  const program = new Command().exitOverride();
  register(program);
  let exitCode: number;
  try {
    await program.parseAsync(args, { from: "user" });
    exitCode = Number(process.exitCode ?? 0);
  } catch (thrown) {
    const m = /^exit (\d+)$/.exec((thrown as Error).message);
    if (!m) err.push((thrown as Error).message);
    exitCode = m ? Number(m[1]) : 1;
  }
  const fetches = fetchSpy.mock.calls.length;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { out: out.join("\n"), err: err.join("\n"), exitCode, fetches };
}
const runIngest = (args: string[]) => run(registerIngestCommand, ["ingest", ...args]);
const runMap = (args: string[]) => run(registerMapCommand, ["map", ...args]);

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

  it("does not warn when quiet, or when the workspace says pinned: true", () => {
    const errs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { errs.push(String(c)); return true; });
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    ensureWorkspaceIdState(ws, { quiet: true });
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone", pinned: true }]);
    resetWorkspaceIdMemosForTests();
    ensureWorkspaceIdState(ws);
    expect(errs.filter((e) => e.includes("Keeping"))).toEqual([]);
  });

  it("re-keys only when asked (adoptPathId), recording the previous id for the prune", () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const state = ensureWorkspaceIdState(ws, { adoptPathId: true });
    expect(state).toEqual(expect.objectContaining({ workspaceId: workspaceIdForPath(ws), migrated: true, previousWorkspaceId: PINNED }));
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    expect(pendingFor(ws)).toEqual([{ workspace_id: PINNED, endpoint: baseUrl }]);
  });

  it("bootstrap's re-key is still seen by the ingest's later lookup in the same run", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await bootstrap(ws, { adoptPathId: true });
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    // The config already holds the path id now; the memo carries the re-key.
    expect(workspaceStateFor(ws, { adoptPathId: true })).toEqual(expect.objectContaining({
      workspaceId: workspaceIdForPath(ws), migrated: true, previousWorkspaceId: PINNED,
      pendingPrune: [{ workspace_id: PINNED, endpoint: baseUrl }],
    }));
  });

  it("ix ingest: a pinned id is neither re-keyed nor deleted after a clean ingest", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const r = await runIngest([ws]);

    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).toContain(`Keeping ${PINNED}`);
    expect(registeredIds()[ws]).toBe(PINNED);
    expect(deletes()).toEqual([]);
    // The patches went out under the pinned id, not the path-derived one.
    const committed = requests.filter((q) => q.url.startsWith("/v1/patch")).map((q) => q.body).join("");
    expect(committed).toContain(PINNED);
    expect(committed).not.toContain(workspaceIdForPath(ws));
  }, 60_000);

  it("ix ingest --format json: no warning on stderr for a machine consumer", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const r = await runIngest([ws, "--format", "json"]);
    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).not.toContain("Keeping");
    expect(deletes()).toEqual([]);
  }, 60_000);

  it("ix ingest: an ordinary single-user workspace is unchanged -- no warning, no re-key, no delete", async () => {
    writeConfig(baseUrl, [{ id: workspaceIdForPath(ws), root: ws, name: "clone" }]);
    const r = await runIngest([ws]);

    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).not.toContain("Keeping");
    expect(r.err).not.toContain("Re-keyed");
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    expect(pendingFor(ws)).toBeUndefined();
    expect(deletes()).toEqual([]);
  }, 60_000);
});

describe("ix ingest --prune-stale-workspace", () => {
  it("re-keys and deletes the old id's graph on a loopback backend after a clean ingest", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const r = await runIngest([ws, "--format", "json", "--prune-stale-workspace"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    expect(deletedIds()).toEqual([PINNED]);
    expect(pendingFor(ws)).toBeUndefined();
    expect(r.err).toContain(`Deleted the previous workspace graph ${PINNED}`);
  }, 60_000);

  it("after an unclean re-ingest keeps the old id recorded, and the next run deletes it", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    mode.failCommits = true;
    const first = await runIngest([ws, "--prune-stale-workspace"]);

    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    expect(deletes()).toEqual([]);
    expect(pendingFor(ws)).toEqual([{ workspace_id: PINNED, endpoint: baseUrl }]);
    expect(first.err).toContain(`Kept the previous workspace graph ${PINNED}`);
    expect(first.err).toContain("the next ix map --prune-stale-workspace retries the deletion");

    // Without the flag nothing is deleted, and the record survives.
    mode.failCommits = false;
    resetWorkspaceIdMemosForTests();
    await runIngest([ws]);
    expect(deletes()).toEqual([]);
    expect(pendingFor(ws)).toHaveLength(1);

    resetWorkspaceIdMemosForTests();
    const retry = await runIngest([ws, "--prune-stale-workspace"]);
    expect(retry.exitCode, retry.err).toBe(0);
    expect(retry.err).toContain(`Retrying the deletion of previous workspace graph ${PINNED}`);
    expect(deletedIds()).toEqual([PINNED]);
    expect(pendingFor(ws)).toBeUndefined();
  }, 60_000);

  it("a failed delete stays recorded and is retried", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    mode.reset = "fail";
    const first = await runIngest([ws, "--prune-stale-workspace"]);
    expect(first.err).toContain(`Could not delete the previous workspace graph ${PINNED}`);
    expect(pendingFor(ws)).toHaveLength(1);

    mode.reset = "ok";
    resetWorkspaceIdMemosForTests();
    await runIngest([ws, "--prune-stale-workspace"]);
    expect(pendingFor(ws)).toBeUndefined();
  }, 60_000);

  it("does not follow a redirect on the delete", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    mode.reset = "redirect";
    const r = await runIngest([ws, "--prune-stale-workspace"]);
    expect(r.err).toContain(`Could not delete the previous workspace graph ${PINNED}`);
    expect(requests.filter((q) => q.url === "/redirected")).toEqual([]);
    expect(pendingFor(ws)).toHaveLength(1);
  }, 60_000);

  it("keeps the old graph when another registered root still uses that id", async () => {
    const other = path.join(t, "other");
    fs.mkdirSync(other);
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }, { id: PINNED, root: other, name: "other" }]);
    const r = await runIngest([ws, "--format", "json", "--prune-stale-workspace"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(deletes()).toEqual([]);
    expect(r.err).toContain(`Kept the previous workspace graph ${PINNED}: another registered workspace still uses that id`);
  }, 60_000);

  it("keeps an old id recorded against another endpoint, even when this one is loopback too", async () => {
    // Recorded against loopback endpoint A; this run talks to loopback endpoint B.
    const endpointA = "http://127.0.0.1:1";
    writeConfig(baseUrl, [{
      id: workspaceIdForPath(ws), root: ws, name: "clone",
      extra: ["    pending_prune_of:", `      - workspace_id: "${PINNED}"`, `        endpoint: ${endpointA}`],
    }]);
    const r = await runIngest([ws, "--prune-stale-workspace"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(deletes()).toEqual([]);
    expect(r.err).toContain(`Kept the previous workspace graph ${PINNED}: it was recorded against a different endpoint`);
    expect(pendingFor(ws)).toEqual([{ workspace_id: PINNED, endpoint: endpointA }]);
  }, 60_000);

  it("refuses to re-key a root marked pinned: true, and keeps the marker", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone", pinned: true }]);
    const before = fs.readFileSync(configPath, "utf8");
    const r = await runIngest([ws, "--prune-stale-workspace"]);

    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('is marked "pinned: true"');
    expect(r.err).toContain("Nothing was changed");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(r.fetches).toBe(0);
  });

  it("ix map refuses it the same way for a pinned root", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone", pinned: true }]);
    const before = fs.readFileSync(configPath, "utf8");
    const r = await runMap([ws, "--prune-stale-workspace"]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('is marked "pinned: true"');
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(r.fetches).toBe(0);
  });

  it("is refused on a non-loopback endpoint before anything changes or is sent", async () => {
    process.env.IX_ENDPOINT = "https://ix.example.com";
    writeConfig("https://ix.example.com", [{ id: PINNED, root: ws, name: "clone" }]);
    const before = fs.readFileSync(configPath, "utf8");
    const r = await runIngest([ws, "--format", "json", "--prune-stale-workspace"]);

    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("only runs against a local (loopback) backend");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(r.fetches).toBe(0);
    expect(requests).toEqual([]);
  });

  it("is refused while another map or ingest holds the workspace, instead of coalescing", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const lock = acquireMapLock(ws, "test holder");
    expect(lock).not.toBeNull();
    try {
      const r = await runIngest([ws, "--prune-stale-workspace"]);
      expect(r.exitCode).toBe(1);
      expect(r.err).toContain("run --prune-stale-workspace again once it finishes");
      expect(registeredIds()[ws]).toBe(PINNED);
      expect(r.fetches).toBe(0);
    } finally {
      lock!.release();
    }
  });

  it("is rejected with --github rather than ignored", async () => {
    const r = await runIngest(["--github", "owner/repo", "--prune-stale-workspace"]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("--prune-stale-workspace applies to a path ingest, not --github");
    expect(r.fetches).toBe(0);
  });
});

describe("ix map --prune-stale-workspace", () => {
  it("re-keys in bootstrap, re-ingests, and deletes the old id on a loopback backend", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const r = await runMap([ws, "--format", "json", "--prune-stale-workspace"]);

    expect(r.exitCode, r.err).toBe(0);
    expect(registeredIds()[ws]).toBe(workspaceIdForPath(ws));
    expect(deletedIds()).toEqual([PINNED]);
    expect(pendingFor(ws)).toBeUndefined();
    // The re-ingest went out under the new id.
    const committed = requests.filter((q) => q.url.startsWith("/v1/patch")).map((q) => q.body).join("");
    expect(committed).toContain(workspaceIdForPath(ws));
  }, 60_000);

  it("without the flag: keeps the pinned id and deletes nothing", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const r = await runMap([ws, "--format", "json"]);
    expect(r.exitCode, r.err).toBe(0);
    expect(registeredIds()[ws]).toBe(PINNED);
    expect(deletes()).toEqual([]);
    // json is a machine format: no warning.
    expect(r.err).not.toContain("Keeping");
  }, 60_000);

  it("is refused on a non-loopback endpoint before anything changes or is sent", async () => {
    process.env.IX_ENDPOINT = "https://ix.example.com";
    writeConfig("https://ix.example.com", [{ id: PINNED, root: ws, name: "clone" }]);
    const before = fs.readFileSync(configPath, "utf8");
    const r = await runMap([ws, "--prune-stale-workspace"]);

    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("only runs against a local (loopback) backend");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(r.fetches).toBe(0);
  });

  it("is refused when the active backend is a remote cloud runner", async () => {
    cloud.ready = true;
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const before = fs.readFileSync(configPath, "utf8");
    const r = await runMap([ws, "--prune-stale-workspace"]);

    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("the active backend is remote");
    expect(cloud.ran).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(r.fetches).toBe(0);
  });

  it("is refused while another map holds the workspace, with a JSON record for --format json", async () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone" }]);
    const lock = acquireMapLock(ws, "test holder");
    expect(lock).not.toBeNull();
    try {
      const r = await runMap([ws, "--format", "json", "--prune-stale-workspace"]);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.out)).toEqual(expect.objectContaining({ error: "map_in_progress" }));
      expect(registeredIds()[ws]).toBe(PINNED);
      expect(r.fetches).toBe(0);
    } finally {
      lock!.release();
    }
  });
});

describe("deleteWorkspace", () => {
  it("refuses a redirect instead of following it", async () => {
    mode.reset = "redirect";
    await expect(createClient({ endpoint: baseUrl }).deleteWorkspace("ws")).rejects.toThrow(/redirected \(307/);
    expect(requests.map((q) => q.url)).toEqual(["/v1/reset/workspace"]);
  });
});

describe("staleWorkspaceCleanup: the deletion rule", () => {
  const local = "http://localhost:8090";
  const base = {
    prune: { workspace_id: PINNED, endpoint: local },
    currentWorkspaceId: "11112222",
    pruneOptIn: true,
    endpoint: local,
    ingestClean: true,
    otherRegisteredIds: [] as string[],
  };

  it("deletes only when opted in, recorded here, clean, unshared and loopback", () => {
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
    expect(staleWorkspaceCleanup({ ...base, endpoint, prune: { workspace_id: PINNED, endpoint } }))
      .toEqual(expect.objectContaining({ action: "keep", reason: "non_local_endpoint" }));
    expect(() => assertStaleWorkspacePruneAllowed(endpoint)).toThrow(/loopback/);
  });

  it.each(["http://localhost:8090", "http://127.0.0.1:9999", "http://[::1]:8090", "http://0.0.0.0:8090"])("allows loopback %s", (endpoint) => {
    expect(staleWorkspaceCleanup({ ...base, endpoint, prune: { workspace_id: PINNED, endpoint } }).action).toBe("delete");
    expect(() => assertStaleWorkspacePruneAllowed(endpoint)).not.toThrow();
  });

  it("keeps the graph for another endpoint, an unclean ingest, a shared id, or the current id", () => {
    expect(staleWorkspaceCleanup({ ...base, endpoint: "http://localhost:9999" })).toEqual(expect.objectContaining({ reason: "endpoint_changed" }));
    expect(staleWorkspaceCleanup({ ...base, ingestClean: false })).toEqual(expect.objectContaining({ reason: "ingest_unclean" }));
    expect(staleWorkspaceCleanup({ ...base, otherRegisteredIds: [PINNED] })).toEqual(expect.objectContaining({ reason: "shared_in_config" }));
    expect(staleWorkspaceCleanup({ ...base, currentWorkspaceId: PINNED })).toEqual(expect.objectContaining({ reason: "current_id" }));
  });
});

describe("config.yaml markers", () => {
  it("keeps pinned: true across a config rewrite", () => {
    writeConfig(baseUrl, [{ id: PINNED, root: ws, name: "clone", pinned: true }]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const other = path.join(t, "other");
    fs.mkdirSync(other);
    ensureWorkspaceIdState(other); // registers a second workspace: a full rewrite
    expect(configWorkspaces().map((w) => w.root_path)).toContain(other);
    expect(configWorkspaces().find((w) => w.root_path === ws)?.pinned).toBe(true);
  });

  it("skips malformed pending_prune_of markers with one warning, never coercing them", async () => {
    writeConfig(baseUrl, [{
      id: workspaceIdForPath(ws), root: ws, name: "clone",
      extra: [
        "    pending_prune_of:",
        `      - endpoint: ${baseUrl}`, // no workspace_id
        `      - workspace_id: 12345678`, // unquoted: YAML reads a number
        `        endpoint: ${baseUrl}`,
        `      - workspace_id: "${PINNED}"`, // well-formed
        `        endpoint: ${baseUrl}`,
      ],
    }]);
    const errs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { errs.push(String(c)); return true; });
    const first = loadWorkspaces().find((w) => w.root_path === ws);
    expect(first?.pending_prune_of).toEqual([{ workspace_id: PINNED, endpoint: baseUrl }]);
    fs.appendFileSync(configPath, "\n"); // defeat the read memo
    loadWorkspaces();
    expect(errs.filter((e) => e.includes("malformed pending_prune_of"))).toHaveLength(1);
    vi.restoreAllMocks();

    // End to end: only the well-formed marker is acted on.
    const r = await runIngest([ws, "--prune-stale-workspace"]);
    expect(r.exitCode, r.err).toBe(0);
    expect(deletedIds()).toEqual([PINNED]);
    expect(deletedIds()).not.toContain("undefined");
  }, 60_000);
});
