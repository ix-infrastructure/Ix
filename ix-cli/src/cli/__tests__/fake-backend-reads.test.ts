// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend, SMALL_READ_GRAPH } from "./helpers/fake-backend.js";
import { runInProcess } from "./helpers/run-command.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";

/**
 * The FakeBackend read routes a command test relies on answer in the shape the
 * CLI reads, in both modes (`semantics` and `readGraph`).
 */

let backend: FakeBackend;
let home: string;
let repo: string;
let savedHome: string | undefined;

beforeEach(async () => {
  backend = new FakeBackend({ semantics: "head" });
  await backend.start();
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-fake-reads-")));
  repo = join(home, "repo");
  mkdirSync(repo);
  savedHome = process.env.IX_HOME;
  process.env.IX_HOME = home;
  writeFileSync(join(home, "config.yaml"),
    `endpoint: ${backend.url}\nformat: text\nworkspaces:\n  - workspace_id: "ws1"\n    workspace_name: repo\n    root_path: ${repo}\n    default: true\n`);
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = savedHome;
  await backend.stop();
  expect(backend.unknownPaths, "endpoints the fake does not implement").toEqual([]);
  rmSync(home, { recursive: true, force: true });
});

/** Commit the parser's own patch for one file, as `ix map` would. */
async function commitOneFile(): Promise<void> {
  const src = "import { b } from './b';\nexport function greet() { return b(); }\n";
  const [{ parseFile }, { buildPatchWithResolution }] = await loadIngestionModules();
  const build = buildPatchWithResolution as (...a: unknown[]) => unknown;
  const sha = createHash("sha256").update(Buffer.from(src)).digest("hex");
  const res = await fetch(`${backend.url}/v1/patch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(build(parseFile("a.ts", src), sha, "ws1", [], undefined, undefined)),
  });
  expect(res.status).toBe(200);
}

const ix = (...argv: string[]) =>
  runInProcess(argv, { endpoint: backend.url!, cwd: repo, env: { IX_HOME: home } });

describe("FakeBackend /v1/stats", () => {
  it("semantics mode answers edges by predicate, and `ix stats` reads it", async () => {
    await commitOneFile();
    const raw = await (await fetch(`${backend.url}/v1/stats?workspace_id=ws1`)).json() as {
      nodes: { total: number; byKind: Array<{ kind: string; count: number }> };
      edges: { total: number; byPredicate: Array<{ predicate: string; count: number }> };
    };
    expect(raw.nodes.total).toBeGreaterThan(0);
    expect(raw.edges.total).toBeGreaterThan(0);
    expect(raw.edges).not.toHaveProperty("byKind");
    expect(raw.edges.byPredicate.every((e) => typeof e.predicate === "string")).toBe(true);
    expect(raw.edges.byPredicate.reduce((n, e) => n + e.count, 0)).toBe(raw.edges.total);

    for (const format of ["json", "llm", "text"]) {
      const run = await ix("stats", "--format", format);
      expect(run.stderr, format).not.toMatch(/not iterable/);
      expect(run.exitCode, format).toBe(0);
    }
    const json = JSON.parse((await ix("stats", "--format", "json")).stdout);
    expect(json.edges.byPredicate).toEqual(raw.edges.byPredicate);
  });

  it("semantics and readGraph modes answer the same shape", async () => {
    const semantics = await (await fetch(`${backend.url}/v1/stats`)).json() as Record<string, Record<string, unknown>>;
    backend.readGraph = SMALL_READ_GRAPH;
    const read = await (await fetch(`${backend.url}/v1/stats`)).json() as Record<string, Record<string, unknown>>;
    expect(Object.keys(semantics.edges).sort()).toEqual(Object.keys(read.edges).sort());
    expect(Object.keys(semantics.nodes).sort()).toEqual(Object.keys(read.nodes).sort());
  });
});

describe("FakeBackend failList", () => {
  it("fails /v1/list in readGraph mode too", async () => {
    backend.readGraph = SMALL_READ_GRAPH;
    const list = () => fetch(`${backend.url}/v1/list`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "function" }),
    });
    expect((await list()).status).toBe(200);
    for (const status of [404, 500]) {
      backend.failList = status;
      expect((await list()).status).toBe(status);
    }
  });
});
