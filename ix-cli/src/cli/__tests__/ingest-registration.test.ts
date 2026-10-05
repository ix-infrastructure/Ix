// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { workspaceStateFor } from "../bootstrap.js";
import { registerIngestCommand } from "../commands/ingest.js";
import { registerReadCommand } from "../commands/read.js";
import { createIxMcpServer, type IxRunner } from "../../mcp/server.js";

/**
 * Every registered workspace is a root `ix read` may open files from. `ix
 * ingest <path>` registered the path's workspace before it ingested anything,
 * so one failed ingest of a directory outside the workspace (backend down, or
 * a path nobody meant) made that directory readable for good:
 *
 *   ix read <outside>/secret.txt     -> path_outside_workspace
 *   ix ingest <outside>/x.json       -> commit fails, config.yaml gains <outside>
 *   ix read <outside>/secret.txt     -> the secret
 */

let t: string;
let ws: string;
let outside: string;
let config: string;
let savedCwd: string;
const savedEnv = { IX_HOME: process.env.IX_HOME, IX_ENDPOINT: process.env.IX_ENDPOINT };

beforeEach(() => {
  t = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ix-ingest-reg-")));
  ws = path.join(t, "ws");
  outside = path.join(t, "outside");
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(t, "home"));
  fs.writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-VALUE\n");
  fs.writeFileSync(path.join(outside, "x.json"), '{"k": 1}\n');
  config = path.join(t, "home", "config.yaml");
  fs.writeFileSync(config, [
    "endpoint: http://127.0.0.1:1",
    "format: text",
    "workspaces:",
    "  - workspace_id: ws1",
    "    workspace_name: ws",
    `    root_path: ${ws}`,
    "    default: true",
    "",
  ].join("\n"));
  process.env.IX_HOME = path.join(t, "home");
  process.env.IX_ENDPOINT = "http://127.0.0.1:1"; // nothing listens: every commit fails
  savedCwd = process.cwd();
  process.chdir(ws);
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

async function run(register: (p: Command) => void, args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as never);
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
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

describe("ix ingest registers a workspace only once something was ingested", () => {
  it("leaves config.yaml unchanged after a failed ingest, so reads stay confined", async () => {
    const before = fs.readFileSync(config, "utf8");
    const secret = path.join(outside, "secret.txt");

    const first = await run(registerReadCommand, ["read", secret, "--root", ws, "--format", "json"]);
    expect(first.out).toContain("path_outside_workspace");

    const ingest = await run(registerIngestCommand, ["ingest", path.join(outside, "x.json")]);
    // It got as far as the commit, which is where a registration made up
    // front would already be on disk. (An ingest that cannot load its parser
    // -- core-ingestion not built -- fails earlier and would prove nothing.)
    expect(ingest.err).toContain("committed nothing");
    expect(fs.readFileSync(config, "utf8")).toBe(before);

    const second = await run(registerReadCommand, ["read", secret, "--root", ws, "--format", "json"]);
    expect(second.out).toContain("path_outside_workspace");
    expect(second.out).not.toContain("TOP-SECRET-VALUE");
    expect(second.exitCode).toBe(1);
  }, 60_000);

  it("workspaceStateFor gives a new root's id without writing anything", () => {
    const before = fs.readFileSync(config, "utf8");
    const state = workspaceStateFor(outside);
    expect(state.pending).toBe(true);
    expect(state.name).toBe("outside");
    expect(fs.readFileSync(config, "utf8")).toBe(before);
    // A registered root is the existing workspace (its legacy id migrated, as before).
    expect(workspaceStateFor(ws)).toEqual(expect.objectContaining({ name: "ws", pending: false }));
  });
});

describe("ix read refuses an outside path before looking at it", () => {
  it("answers path_outside_workspace for a path that does not exist, too", async () => {
    const missing = await run(registerReadCommand, ["read", path.join(outside, "nope.txt"), "--root", ws, "--format", "json"]);
    const present = await run(registerReadCommand, ["read", path.join(outside, "secret.txt"), "--root", ws, "--format", "json"]);
    expect(missing.out).toContain("path_outside_workspace");
    expect(present.out).toContain("path_outside_workspace");
  });
});

describe("MCP ix_ingest is confined like ix_read", () => {
  async function connect(runIx: IxRunner): Promise<Client> {
    const server = createIxMcpServer({ version: "test", runIx, proAvailable: false, tools: "all" });
    const client = new Client({ name: "ix-ingest-reg-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it("refuses a path outside the workspace without running the CLI", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => { calls.push(args); return { ok: true, stdout: "{}", stderr: "" }; });
    const result = (await client.callTool({ name: "ix_ingest", arguments: { path: path.join(outside, "x.json") } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("path_outside_workspace");
    expect(calls).toEqual([]);
    await client.close();
  });

  it("still ingests a path inside the workspace", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => { calls.push(args); return { ok: true, stdout: "{}", stderr: "" }; });
    await client.callTool({ name: "ix_ingest", arguments: { path: "a.ts" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("a.ts");
    await client.close();
  });
});
