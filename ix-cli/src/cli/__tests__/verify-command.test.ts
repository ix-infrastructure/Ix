// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

/**
 * CL-24A: `ix verify` end to end against a fake backend serving /v1/list,
 * /v1/source-hashes and /v1/health. Every verdict exits 0; only a usage error
 * or an unreachable backend exits 1, the way `ix status` does.
 */

let rows: any[] = [];
let hashes: Array<{ workspaceId: string; uri: string; hash: string }> = [];
let listStatus = 200;
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.startsWith("/v1/health")) return send(200, { status: "ok" });
      if (url.startsWith("/v1/source-hashes")) return send(200, hashes);
      if (url.startsWith("/v1/stats")) {
        const kinds = [...new Set(rows.map((r) => r.kind))];
        return send(200, { nodes: { total: rows.length, byKind: kinds.map((kind) => ({ kind, count: 1 })) }, edges: { total: 0 } });
      }
      if (url.startsWith("/v1/list")) {
        if (listStatus !== 200) return send(listStatus, { error: "nope" });
        const q = JSON.parse(body || "{}");
        return send(200, rows.filter((r) => r.kind === q.kind && r.provenance.sourceUri.includes(q.scope ?? "")));
      }
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
  home = realpathSync(mkdtempSync(join(tmpdir(), "ix-verify-cmd-")));
  repo = join(home, "repo");
  mkdirSync(repo);
  saved = { IX_HOME: process.env.IX_HOME, IX_ENDPOINT: process.env.IX_ENDPOINT };
  process.env.IX_HOME = home;
  process.env.IX_ENDPOINT = endpoint;
  cwd = process.cwd();
  process.chdir(repo);
  out = [];
  rows = [];
  hashes = [];
  listStatus = 200;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});

afterEach(() => {
  process.chdir(cwd);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

/** A mapped one-file workspace, with the backend holding what ingest would have written. */
async function mapped(opts: { dropFunction?: boolean; staleHash?: boolean } = {}): Promise<void> {
  writeFileSync(join(home, "config.yaml"),
    `endpoint: ${endpoint}\nformat: text\nworkspaces:\n  - workspace_id: "ws1"\n    workspace_name: repo\n    root_path: ${repo}\n    default: true\n`);
  const src = "export function greet() { return 'hi'; }\n";
  writeFileSync(join(repo, "a.ts"), src);
  const { loadIngestionModules } = await import("../commands/ingestion-loader.js");
  const [{ parseFile }, { buildPatchWithResolution, extractorName }] = await loadIngestionModules();
  const build = buildPatchWithResolution as (...a: unknown[]) => { ops: Array<Record<string, any>> };
  const patch = build(parseFile("a.ts", src), sha(src), "ws1", [], undefined, undefined);
  rows = patch.ops
    .filter((o) => o.type === "UpsertNode" && !(opts.dropFunction && o.kind === "function"))
    .map((o) => ({ id: o.id, kind: o.kind, name: o.name, attrs: o.attrs, provenance: { sourceUri: "a.ts" } }));
  hashes = [{ workspaceId: "ws1", uri: "a.ts", hash: opts.staleHash ? "older" : sha(src) }];
  const { saveIngestBaseline } = await import("../ingest-baseline.js");
  saveIngestBaseline(repo, new Map([[join(repo, "a.ts"), 1]]), 3, new Date(), new Map(), extractorName());
}

async function verify(...args: string[]): Promise<string> {
  const { registerVerifyCommand } = await import("../commands/verify.js");
  const program = new Command().exitOverride();
  registerVerifyCommand(program);
  await program.parseAsync(["verify", ...args], { from: "user" });
  return out.join("\n");
}

describe("ix verify output", () => {
  it("clean: one llm record, exit 0", async () => {
    await mapped();
    const llm = await verify("--format", "llm");
    expect(llm).toMatch(/^verify graph=clean files=1 clean=1 stale=0 diverged=0 unverified=0$/m);
    expect(llm).not.toMatch(/^file /m);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("stale: the file is listed, the graph is not diverged", async () => {
    await mapped({ staleHash: true });
    const llm = await verify("--format", "llm");
    expect(llm).toMatch(/^verify graph=clean .*stale=1 .*fix="ix map"/m);
    expect(llm).toMatch(/^file path=a\.ts state=stale/m);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("diverged: llm, json and text all name the fix, exit 0", async () => {
    await mapped({ dropFunction: true });
    const llm = await verify("--format", "llm");
    expect(llm).toMatch(/^verify graph=diverged files=1 clean=0 stale=0 diverged=1 unverified=0 fix="ix reset --workspace --yes --ingest"$/m);
    expect(llm).toMatch(/^file path=a\.ts state=diverged missing=1 extra=0 changed=0$/m);

    out.length = 0;
    const json = JSON.parse(await verify("--format", "json"));
    expect(json).toMatchObject({ graph: "diverged", counts: { diverged: 1 }, fix: "ix reset --workspace --yes --ingest" });
    expect(json.files[0].missing[0]).toMatchObject({ kind: "function", name: "greet" });

    out.length = 0;
    const text = await verify();
    expect(text).toMatch(/Graph:?\s+diverged/);
    expect(text).toMatch(/ix reset --workspace --yes --ingest/);
    expect(text).toMatch(/edges are not compared/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("unverified/not_mapped with no workspace, exit 0", async () => {
    const llm = await verify("--format", "llm");
    expect(llm).toMatch(/^verify graph=unverified reason=not_mapped files=0 .*fix="ix map"/m);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a 404 or 500 on /v1/list makes the file unverified, not a crash", async () => {
    for (const status of [404, 500]) {
      await mapped();
      listStatus = status;
      out.length = 0;
      const llm = await verify("--format", "llm");
      expect(llm).toMatch(/^file path=a\.ts state=unverified reason=list_failed/m);
      expect(process.exitCode ?? 0).toBe(0);
    }
  });

  it("writes the record ix status reads", async () => {
    await mapped({ dropFunction: true });
    await verify("--format", "llm");
    const { verifyRecordPath } = await import("../config.js");
    expect(JSON.parse(readFileSync(verifyRecordPath(repo), "utf-8"))).toMatchObject({ graph: "diverged", diverged: 1 });
  });
});

describe("ix verify roots and the record", () => {
  it("a named path does not replace the record ix status reads", async () => {
    await mapped({ dropFunction: true });
    await verify("a.ts", "--format", "llm");
    const { verifyRecordPath } = await import("../config.js");
    expect(existsSync(verifyRecordPath(repo))).toBe(false);
  });

  it("--root . and --root with a trailing slash find the mapped workspace", async () => {
    await mapped();
    for (const root of [".", `${repo}/`]) {
      out.length = 0;
      expect(await verify("--root", root, "--format", "llm")).toMatch(/^verify graph=clean files=1 clean=1/m);
    }
  });
});

describe("ix verify errors", () => {
  it("--sample 0 and --sample abc are usage errors through errors.ts", async () => {
    const { CliUsageError, renderCliError } = await import("../errors.js");
    for (const bad of ["0", "abc"]) {
      const err = await verify("--sample", bad).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(CliUsageError);
      expect(() => renderCliError(err)).toThrow("exit 1");
    }
    expect(out.join("\n")).toMatch(/--sample/);
    expect(out.join("\n")).not.toMatch(/at .*verify\.ts/); // no stack trace
  });

  it("an unreachable backend gives the uniform llm error record and exit 1, like status", async () => {
    await mapped();
    // A port nothing listens on (port 1 is one fetch refuses to dial at all).
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    process.env.IX_ENDPOINT = `http://127.0.0.1:${port}`;
    const err = await verify("--format", "llm").then(() => null, (e) => e);
    expect(String(err)).toMatch(/exit 1/);
    expect(out.join("\n")).toMatch(/^error code=backend_unreachable message=/m);
  });
});
