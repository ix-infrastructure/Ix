// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildHelpText } from "../help-text.js";
import { OSS_FALLBACK_TABLE, registerOssFallbacks } from "../register/oss-fallbacks.js";
import { planStartup } from "../register/oss-table.js";
import { registerOssCommands } from "../register/oss.js";

/**
 * `ix note` and `ix session` with Ix Pro absent: OSS answers them against the
 * local backend, with Pro's flags and Pro's `--json` (the backend record,
 * unchanged). With Pro present they are Pro's, and OSS never registers them.
 *
 * The end-to-end cases run the real CLI against a fake backend, in the exact
 * forms Peer2Peer's ext-ix uses:
 *   ix note --json show <id>
 *   ix note --tag=<t> --session=<s> --actor=p2p:<addr> --json   < text
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN = join(SRC, "cli/main.ts");
const TSX = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("tsx")).href;

const NOTE_ID = "0b6f0e3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const NOTE = {
  id: NOTE_ID, text: "the body", tag: "finding", actor: "p2p:alice", nodeIds: [],
  at: "2026-11-05T00:00:00Z", stale: false, sessionId: "s-1", sessionName: "sprint", lifecycleStatus: "active",
};
const SESSION = {
  sessionId: "5e551011-0000-4000-8000-000000000001", name: "sprint", purpose: "p", actor: "alice",
  actors: ["alice"], ttlHours: 24, createdAt: "2026-11-05T00:00:00Z", lastLoadedAt: null,
};

interface Seen { method: string; url: string; body: unknown }
let seen: Seen[] = [];
let server: Server;
let endpoint: string;
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method, url, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (method === "POST" && url === "/v1/note") {
        const b = body as { text: string; tag?: string; actor?: string; nodeIds?: string[] };
        return send(200, { id: NOTE_ID, text: b.text, tag: b.tag ?? "note", actor: b.actor ?? null, nodeIds: b.nodeIds ?? [], at: NOTE.at, stale: false });
      }
      if (method === "GET" && url === `/v1/note/${NOTE_ID}`) return send(200, NOTE);
      if (method === "GET" && url.startsWith("/v1/note/")) return send(404, { error: "not_found", message: "Note not found" });
      if (method === "GET" && url.startsWith("/v1/notes")) return send(200, [NOTE]);
      if (method === "POST" && url === `/v1/note/${NOTE_ID}/supersede`) {
        return send(200, { status: "superseded", oldNoteId: NOTE_ID, newNote: { ...NOTE, id: "new-id", ...(body as object) } });
      }
      if (method === "POST" && url === `/v1/note/${NOTE_ID}/retract`) return send(200, { status: "retracted", noteId: NOTE_ID });
      if (method === "GET" && url.startsWith("/v1/sessions")) return send(200, [SESSION]);
      if (method === "POST" && url === "/v1/session") return send(200, { ...SESSION, ...(body as object) });
      if (method === "GET" && url === "/v1/session/sprint") return send(200, SESSION);
      if (method === "GET" && url === "/v1/session/sprint/notes") return send(200, [NOTE, { ...NOTE, id: "other", tag: "note" }]);
      if (method === "POST" && url === "/v1/session/sprint/pin") return send(200, { status: "pinned", count: (body as { nodeIds: string[] }).nodeIds.length });
      if (method === "DELETE" && url === "/v1/session/sprint") return send(200, { status: "deleted" });
      send(404, { error: "not_found", message: `no route ${method} ${url}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  home = mkdtempSync(join(tmpdir(), "ix-note-home-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => { seen = []; });

interface Run { stdout: string; stderr: string; status: number | null }

function ix(args: string[], input = ""): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, IX_HOME: home, IX_ENDPOINT: endpoint, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
  for (const key of ["FORCE_COLOR", "IX_FORMAT", "IX_LOAD_ALL_COMMANDS", "IX_TOKEN"]) delete env[key];
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf-8").on("data", (d: string) => { stderr += d; });
    child.on("error", fail);
    child.on("close", (status) => done({ stdout, stderr, status }));
    child.stdin.end(input);
  });
}

describe("ix note against the local backend (Pro absent)", () => {
  it("creates a note from stdin in Peer2Peer's form and prints the backend record", async () => {
    const r = await ix(["note", "--tag=finding", "--session=sprint", "--actor=p2p:alice", "--json"], "  shared text\n");
    expect(r.status).toBe(0);
    expect(seen).toEqual([{
      method: "POST", url: "/v1/note",
      body: { text: "shared text", tag: "finding", actor: "p2p:alice", sessionId: "sprint" },
    }]);
    expect(JSON.parse(r.stdout)).toEqual({
      id: NOTE_ID, text: "shared text", tag: "finding", actor: "p2p:alice", nodeIds: [], at: NOTE.at, stale: false,
    });
  });

  it.each([
    [["note", "--json", "show", NOTE_ID]],
    [["note", "show", NOTE_ID, "--json"]],
  ])("shows a note as JSON: %j", async (args) => {
    const r = await ix(args);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(NOTE);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`GET /v1/note/${NOTE_ID}`]);
  });

  it("resolves - to the last note shown", async () => {
    await ix(["note", "show", NOTE_ID, "--json"]);
    const recent = JSON.parse(readFileSync(join(home, "recent.json"), "utf-8"));
    expect(recent.note.local).toBe(NOTE_ID);
    seen = [];
    const r = await ix(["note", "retract", "-", "--actor", "alice", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: "retracted", noteId: NOTE_ID });
    expect(seen).toEqual([{ method: "POST", url: `/v1/note/${NOTE_ID}/retract`, body: { actor: "alice" } }]);
  });

  it("filters a session's notes client-side for ls --session", async () => {
    const r = await ix(["note", "ls", "--session", "sprint", "--tag", "finding", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([NOTE]);
  });

  it("passes the list filters to /v1/notes", async () => {
    const r = await ix(["note", "ls", "--tag", "decision", "--limit", "5", "--exclude-superseded", "--json"]);
    expect(r.status).toBe(0);
    expect(seen.map((s) => s.url)).toEqual(["/v1/notes?tag=decision&limit=5&includeSuperseded=false"]);
  });

  // Commander binds --tag/--session/--actor to `note` itself even after a
  // subcommand; the subcommand must still see them.
  it("keeps the shared flags on supersede", async () => {
    const r = await ix(["note", "supersede", NOTE_ID, "new text", "--tag", "decision", "--actor", "bob", "--session", "sprint", "--json"]);
    expect(r.status).toBe(0);
    expect(seen).toEqual([{
      method: "POST", url: `/v1/note/${NOTE_ID}/supersede`,
      body: { text: "new text", tag: "decision", actor: "bob", sessionId: "sprint" },
    }]);
    expect(JSON.parse(r.stdout).oldNoteId).toBe(NOTE_ID);
  });

  it("refuses an unknown tag and empty text without calling the backend", async () => {
    const bad = await ix(["note", "x", "--tag", "bogus"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Invalid --tag "bogus"');
    const empty = await ix(["note", "--json"], "   ");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("Note text required.");
    expect(seen).toEqual([]);
  });

  it("exits 1 on a missing note", async () => {
    const r = await ix(["note", "show", "1b6f0e3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});

describe("ix session against the local backend (Pro absent)", () => {
  it("lists sessions as JSON, with --json or --format json", async () => {
    for (const flag of [["--json"], ["--format", "json"]]) {
      const r = await ix(["session", "alice", ...flag]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([SESSION]);
    }
    expect(seen.map((s) => s.url)).toEqual(["/v1/sessions?actor=alice", "/v1/sessions?actor=alice"]);
  });

  it("creates, shows, pins and deletes", async () => {
    const created = await ix(["session", "create", "sprint", "--purpose", "p", "--actor", "alice", "--ttl", "6", "--json"]);
    expect(created.status).toBe(0);
    expect(seen[0]!.body).toEqual({ name: "sprint", purpose: "p", actor: "alice", ttlHours: 6 });
    expect(JSON.parse(created.stdout).ttlHours).toBe(6);

    expect(JSON.parse((await ix(["session", "--json", "show", "sprint"])).stdout)).toEqual(SESSION);
    expect(JSON.parse((await ix(["session", "pin", "sprint", "n1", "n2", "--json"])).stdout)).toEqual({ status: "pinned", count: 2 });

    // No terminal and no --force: nothing is deleted.
    const refused = await ix(["session", "delete", "sprint"]);
    expect(refused.status).toBe(0);
    expect(refused.stdout).toContain("Cancelled.");
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);

    const deleted = await ix(["session", "delete", "sprint", "--force", "--json"]);
    expect(JSON.parse(deleted.stdout)).toEqual({ status: "deleted" });
  });
});

describe("registration: Pro wins", () => {
  it("leaves a command Pro already registered alone", async () => {
    const program = new Command();
    const proNote = program.command("note").description("Pro's note");
    await registerOssFallbacks(program);
    expect(program.commands.filter((c) => c.name() === "note")).toEqual([proNote]);
    expect(program.commands.map((c) => c.name())).toContain("session");
  });

  it("keeps the fallbacks out of the OSS set, so Pro registers them without a collision", () => {
    const program = new Command();
    registerOssCommands(program);
    for (const name of Object.keys(OSS_FALLBACK_TABLE)) {
      expect(program.commands.some((c) => c.name() === name)).toBe(false);
    }
  });

  it("takes the fast path only with Pro absent", () => {
    expect(planStartup(["note", "show", "x"], {}, () => true)).toEqual({ kind: "fallback", name: "note" });
    expect(planStartup(["session"], {}, () => true)).toEqual({ kind: "fallback", name: "session" });
    expect(planStartup(["note", "show", "x"], {}, () => false)).toEqual({ kind: "all" });
  });

  it("lists note and session in help only when Pro did not load", () => {
    expect(buildHelpText()).toMatch(/^\s{2}note \[text\]/m);
    expect(buildHelpText()).toMatch(/^\s{2}session \[actor\]/m);
    const pro = buildHelpText([{ name: "note", desc: "Pro's note" }]);
    expect(pro).not.toContain("Memory:");
  });
});

