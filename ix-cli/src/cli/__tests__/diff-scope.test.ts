// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { Command } from "commander";

import { saveConfig } from "../config.js";
import { resetReadScope } from "../resolve.js";
import {
  DIFF_MAX_LIMIT,
  diffRequestLimit,
  diffTruncationNote,
  diffWorkspaceScope,
  registerDiffCommand,
} from "../commands/diff.js";

/**
 * `/v1/diff` scopes by `workspace_id` like the backend's other reads
 * (Ix-memory#277, WorkspaceScope), and clamps `limit` to 5000 with a default
 * of 100. `ix diff` sent neither, so every diff was global, and `--full` (no
 * limit) still got 100 changes under "Use --full to see all".
 */

let server: Server;
let endpoint: string;
let bodies: Array<Record<string, unknown>> = [];
let answer: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/v1/diff") bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
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
let elsewhere: string;
let savedCwd: string;
let out: string[];

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ix-diff-scope-")));
  process.env.IX_HOME = path.join(home, ".ix");
  process.env.IX_ENDPOINT = endpoint;
  repo = path.join(home, "repo");
  elsewhere = path.join(home, "elsewhere");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  saveConfig({
    endpoint,
    format: "text",
    workspaces: [{ workspace_id: "ws000001", workspace_name: "repo", root_path: repo, default: true }],
  });
  savedCwd = process.cwd();
  resetReadScope();
  bodies = [];
  answer = { fromRev: 3, toRev: 5, changes: [], truncated: false, totalChanges: 0 };
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
});

afterEach(() => {
  process.chdir(savedCwd);
  delete process.env.IX_HOME;
  delete process.env.IX_ENDPOINT;
  resetReadScope();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

async function diff(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerDiffCommand(program);
  await program.parseAsync(["diff", ...args], { from: "user" });
}

describe("ix diff: workspace scope", () => {
  it("sends the workspace the directory belongs to", async () => {
    process.chdir(repo);
    await diff("3", "5");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ fromRev: 3, toRev: 5, workspace_id: "ws000001" });
  });

  it("scopes --summary the same way", async () => {
    process.chdir(repo);
    answer = { fromRev: 3, toRev: 5, summary: { added: 1 }, total: 1 };
    await diff("3", "5", "--summary");
    expect(bodies[0]).toMatchObject({ summary: true, workspace_id: "ws000001" });
  });

  it("--all asks for every workspace", async () => {
    process.chdir(repo);
    await diff("3", "5", "--all");
    expect(bodies[0].workspace_id).toBe("*");
  });

  it("outside any mapped workspace it stays global, as before, rather than failing", async () => {
    process.chdir(elsewhere);
    await diff("3", "5");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].workspace_id).toBeUndefined();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("diffWorkspaceScope", () => {
    expect(diffWorkspaceScope(true, elsewhere)).toBe("*");
    expect(diffWorkspaceScope(false, repo)).toBe("ws000001");
    expect(diffWorkspaceScope(undefined, elsewhere)).toBeUndefined();
  });
});

describe("ix diff --full", () => {
  it("asks for the backend's maximum instead of sending no limit", async () => {
    process.chdir(repo);
    await diff("3", "5", "--full");
    expect(bodies[0].limit).toBe(DIFF_MAX_LIMIT);
    expect(DIFF_MAX_LIMIT).toBe(5000);
  });

  it("leaves --limit and the default as they were", () => {
    expect(diffRequestLimit({ limit: "20" })).toBe(20);
    expect(diffRequestLimit({})).toBeUndefined();
    expect(diffRequestLimit({ full: true })).toBe(5000);
  });

  it("does not tell a --full run to use --full", async () => {
    process.chdir(repo);
    answer = {
      fromRev: 3, toRev: 5, truncated: true, totalChanges: 6000,
      changes: [{ entityId: "e1", changeType: "added", atToRev: { name: "f", kind: "function" } }],
    };
    await diff("3", "5", "--full");
    const text = out.join("\n");
    expect(text).toContain("at most 5000");
    expect(text).not.toContain("Use --full");
  });

  it("the truncation note", () => {
    expect(diffTruncationNote(100, 250, false)).toBe("Showing 100 of 250 changes. Use --full to see up to 5000.");
    expect(diffTruncationNote(5000, 6000, true)).toMatch(/^Showing 5000 of 6000 changes: the backend returns at most 5000\./);
  });
});
