// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { IxClient } from "../../src/client/api.js";
import { httpStatusOf } from "../../src/client/http-error.js";
import { loadIngestionModules } from "../../src/cli/commands/ingestion-loader.js";
import { ingestFiles } from "../../src/cli/commands/ingest.js";
import { loadIngestBaseline, loadRebuildProgress } from "../../src/cli/ingest-baseline.js";
import * as stateFiles from "../../src/cli/workspace-state.js";
import { checkout, cleanupScratch, e2eEnv, ix, resetBackend, workspaceId, type Checkout } from "./harness.js";

const rel = "job.ts";
const source = (guard = 'this.status === "queued"', to = "running") =>
  `export class Job {\n  start() {\n    if (${guard}) this.status = "${to}";\n  }\n}\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const env = e2eEnv();
const client = new IxClient(env.endpoint, undefined, { token: env.token });
let fixture: string;
let core: Awaited<ReturnType<typeof loadIngestionModules>>;
beforeAll(async () => {
  core = await loadIngestionModules();
  fixture = mkdtempSync(join(tmpdir(), "ix-behavior-fixture-"));
  writeFileSync(join(fixture, rel), source());
  writeFileSync(join(fixture, "use.ts"), 'import { Job } from "./job";\nexport function run() { new Job().start(); }\n');
});
beforeEach(() => resetBackend(env));
afterAll(() => { cleanupScratch(); if (fixture) rmSync(fixture, { recursive: true, force: true }); });

function map(co: Checkout) { ix(env, co, ["map", ".", "--silent"]); }
function id(co: Checkout, path = rel) { return core[1].symbolNodeId(workspaceId(co), path, "Job.start"); }
async function live(co: Checkout, path = rel) { return (await client.entity(id(co, path))).node; }
async function absent(co: Checkout, path = rel) {
  try { expect(await live(co, path)).toBeFalsy(); } catch (err) { if (httpStatusOf(err) !== 404) throw err; }
}
function baseline(co: Checkout) {
  const name = readdirSync(co.ixHome).find(p => p.startsWith("ingest_mtimes_"));
  if (!name) throw Error("Missing source baseline");
  return join(co.ixHome, name);
}
async function evidence(co: Checkout, code: string, path = rel) {
  const node = await live(co, path);
  expect(node).toMatchObject({ id: id(co, path), kind: "method", attrs: { language: "typescript", line_start: 2 },
    provenance: { extractor: core[1].extractorName() } });
  const p = node.provenance as { sourceHash?: string; source_hash?: string };
  expect(p.sourceHash ?? p.source_hash).toBe(sha(code));
  return node.attrs.behavior_v1 as { coverage: string; cutReason?: string; writes: {
    id: string; slotId: string; observed: { to: { value: string }; guards: unknown[] }; inferred: unknown;
  }[] } | undefined;
}

it("P1/P2/P3 maps, updates the guard and clears evidence on the surviving method", async () => {
  const co = checkout(fixture);
  map(co);
  const initial = (await evidence(co, source()))!;
  expect(initial).toMatchObject({ coverage: "complete", writes: [{ observed: {
    assignment: [3, 34, 3, 57], to: { value: "running" }, guards: [{ expression: 'this.status === "queued"', arm: "then", span: [3, 8, 3, 32] }],
  }, inferred: { from: { value: "queued" }, guardIndex: 0 } }] });
  map(co);
  expect(await evidence(co, source())).toEqual(initial);
  const revision = await client.currentRevision();
  const rev = typeof revision === "number" ? revision : (revision as { rev: number }).rev;
  expect(Number.isInteger(rev)).toBe(true);
  for (const code of [source("ready"), source("ready", "done")]) {
    writeFileSync(join(co.dir, rel), code); map(co);
    const [w] = (await evidence(co, code))!.writes;
    expect(w.slotId).toBe(initial.writes[0].slotId);
    expect(w.id).not.toBe(initial.writes[0].id);
    expect(w.inferred).toEqual({ from: "unknown" });
    expect(w.observed.to.value).toBe(code.includes('"done"') ? "done" : "running");
  }
  for (const code of ['export class Job {\n  start() {}\n}\n', source(), 'export abstract class Job {\n  abstract start(): void;\n}\n']) {
    writeFileSync(join(co.dir, rel), code); map(co);
    expect(await evidence(co, code)).toEqual(code === source() ? initial : undefined);
  }
  const old = await client.contextForNode(id(co), { depth: "full", asOfRev: rev });
  expect(old.metadata.asOfRev).toBe(rev);
  expect(old.nodes.find(n => n.id === id(co))?.attrs.behavior_v1).toEqual(initial);
});

it("P4/P8 preserves envelopes across full ingest, rename, deletion and restore", async () => {
  const co = checkout(fixture);
  map(co); const first = (await evidence(co, source()))!;
  ix(env, co, ["ingest", ".", "--force"]); map(co);
  expect(await evidence(co, source())).toEqual(first);
  renameSync(join(co.dir, rel), join(co.dir, "task.ts")); map(co);
  await absent(co);
  const renamed = (await evidence(co, source(), "task.ts"))!;
  expect(renamed.writes[0].slotId).not.toBe(first.writes[0].slotId);
  unlinkSync(join(co.dir, "task.ts")); map(co); await absent(co, "task.ts");
  writeFileSync(join(co.dir, rel), source()); map(co);
  expect(await evidence(co, source())).toEqual(first);
});

it("P5 persists the verified prefix and its file-level cut reason", async () => {
  const co = checkout(fixture);
  const code = 'export class Job {\n  start() {\n' + 'this.status="ok";\n'.repeat(257) + '}\n}\n';
  writeFileSync(join(co.dir, rel), code); map(co);
  const partial = (await evidence(co, code))!;
  expect(partial).toMatchObject({ coverage: "partial", cutReason: "writes" });
  expect(partial.writes).toHaveLength(256);
});

async function writeLegacy(co: Checkout) {
  const ws = workspaceId(co);
  const parsed = core[0].parseFile(rel, source())!;
  const { behavior: _omitted, ...structural } = parsed;
  const patch = core[1].buildPatchWithResolution(structural, sha(source()), ws, []);
  const [current, legacy] = core[1].sourcePatchIdCandidates(rel, sha(source()), ws);
  patch.source.extractor = "tree-sitter/1.30";
  patch.patchId = legacy;
  patch.replaces = [current];
  expect((await client.commitPatch(patch)).status).toBe("Ok");
  expect((await live(co)).attrs).not.toHaveProperty("behavior_v1");
}

it.each(["old", "absent", "current"])("P6/P9 recovers from a legacy writer with a %s baseline", async state => {
  const co = checkout(fixture); map(co);
  if (state === "current") ix(env, co, ["ingest", ".", "--force"]);
  const prior = (await evidence(co, source()))!;
  await writeLegacy(co);
  const path = baseline(co);
  if (state === "absent") unlinkSync(path);
  else if (state === "old") writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), extractor: "tree-sitter/1.30" }));
  if (state === "current") {
    map(co);
    expect((await live(co)).attrs.behavior_v1).toBeUndefined();
    ix(env, co, ["ingest", ".", "--force"]);
  }
  else map(co);
  expect(await evidence(co, source())).toEqual(prior);
  expect(JSON.parse(readFileSync(baseline(co), "utf8")).extractor).toBe(core[1].extractorName());
  map(co);
  expect(await evidence(co, source())).toEqual(prior);
});

it("P6/P7 resumes confirmed files and only certifies after live verification and an atomic baseline write", async () => {
  const co = checkout(fixture);
  map(co);
  const initial = await evidence(co, source());
  await writeLegacy(co);
  const path = baseline(co);
  const previous = "tree-sitter/1.30";
  const current = core[1].extractorName();
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), extractor: previous }));
  // The scoped run covers the unchanged helper alone. The workspace still needs the job.
  ix(env, co, ["ingest", "use.ts"]);
  expect(JSON.parse(readFileSync(path, "utf8")).extractor).toBe(previous);
  expect((await live(co)).attrs.behavior_v1).toBeUndefined();
  vi.stubEnv("IX_HOME", co.ixHome);
  vi.stubEnv("IX_ENDPOINT", env.endpoint);
  vi.stubEnv("IX_COMMIT_HTTP_MAX_FILES", "1");
  vi.stubEnv("IX_COMMIT_CONCURRENCY", "1");
  const run = () => ingestFiles(co.dir, { recursive: true, format: "json", mapMode: true, suppressOutput: true, printSummary: false });
  const checkpoint = () => loadRebuildProgress(co.dir, current);
  const marker = () => loadIngestBaseline(co.dir)?.extractor;
  const bulk = IxClient.prototype.commitPatchBulk;
  const entity = IxClient.prototype.entity;
  const job = id(co);
  try {
    // Separate ACK from live truth even on a release that normally reactivates this patch.
    vi.spyOn(IxClient.prototype, "commitPatchBulk").mockImplementation(function (this: IxClient, patches) {
      return patches.some(p => p.source.uri === rel) ? Promise.resolve({ status: "Idempotent", rev: 1 }) : bulk.call(this, patches);
    });
    vi.spyOn(IxClient.prototype, "entity").mockImplementation(function (this: IxClient, key) {
      if (key === job) throw Error("injected unavailable live read");
      return entity.call(this, key);
    });
    await run();
    expect(marker()).toBe(previous);
    expect([...checkpoint()!.keys()]).toEqual([join(co.dir, "use.ts")]);
    expect(loadIngestBaseline(co.dir)?.replayedFiles).toContain(rel);
    vi.restoreAllMocks();

    const attempted: string[] = [];
    vi.spyOn(IxClient.prototype, "commitPatchBulk").mockImplementation(async patches => {
      attempted.push(...patches.map(p => p.source.uri));
      throw Error("injected failed bulk");
    });
    vi.spyOn(IxClient.prototype, "commitPatch").mockImplementation(async p => {
      attempted.push(p.source.uri);
      throw Error("injected failed single");
    });
    await expect(run()).rejects.toThrow(/failed to commit/);
    expect(new Set(attempted)).toEqual(new Set([rel]));
    expect(marker()).toBe(previous);
    expect(checkpoint()?.has(join(co.dir, rel))).toBe(false);
    expect((await live(co)).attrs.behavior_v1).toBeUndefined();
    vi.restoreAllMocks();

    const write = stateFiles.writeStateAtomic;
    vi.spyOn(stateFiles, "writeStateAtomic").mockImplementation((target, version, data) => {
      if (target === path) throw Error("injected unavailable baseline");
      return write(target, version, data);
    });
    await run();
    expect(await evidence(co, source())).toEqual(initial);
    expect(marker()).toBe(previous);
    expect(checkpoint()?.size).toBe(2);
    vi.restoreAllMocks();

    const retry = vi.spyOn(IxClient.prototype, "commitPatchBulk");
    const individual = vi.spyOn(IxClient.prototype, "commitPatch");
    await run();
    expect(marker()).toBe(current);
    expect(checkpoint()).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    expect(individual).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it("P10 maps two workspaces with distinct owners and updates only the selected workspace", async () => {
  const first = checkout(fixture, "first");
  const second = { ...checkout(fixture, "second"), ixHome: first.ixHome };
  map(first);
  const before = (await evidence(first, source()))!;
  const changed = source("ready", "done");
  writeFileSync(join(second.dir, rel), changed);
  map(second);
  const other = (await evidence(second, changed))!;
  expect(other.writes[0].slotId).not.toBe(before.writes[0].slotId);
  expect(other.writes[0].id).not.toBe(before.writes[0].id);
  expect(await evidence(first, source())).toEqual(before);
});

it("P7 recovers after process death between a durable checkpoint and the next upload", async () => {
  const co = checkout(fixture);
  map(co);
  const path = baseline(co);
  const old = "tree-sitter/1.30";
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), extractor: old }));
  await writeLegacy(co);
  // Stop the real writer only after its first acknowledged file is on disk. Use an
  // import in the child process so no graceful teardown can flush extra progress.
  const interrupt = `
    import { readdirSync } from 'node:fs';
    const send = globalThis.fetch;
    globalThis.fetch = function(url, init) {
      if (/\\/v1\\/patch(?:es\\/bulk)?$/.test(String(url)) && init?.method === 'POST' &&
          readdirSync(process.env.IX_HOME).some(f => f.startsWith('ingest_rebuild_'))) {
        process.kill(process.pid, 'SIGKILL');
      }
      return send(url, init);
    };
  `;
  try {
    vi.stubEnv("NODE_OPTIONS", "--import=data:text/javascript," + encodeURIComponent(interrupt));
    vi.stubEnv("IX_COMMIT_CONCURRENCY", "1");
    vi.stubEnv("IX_COMMIT_HTTP_MAX_FILES", "1");
    expect(ix(env, co, ["ingest", "."], true).status).not.toBe(0);
  } finally { vi.unstubAllEnvs(); }
  expect(JSON.parse(readFileSync(path, "utf8")).extractor).toBe(old);
  const name = readdirSync(co.ixHome).find(f => f.startsWith("ingest_rebuild_"))!;
  const checkpoint = JSON.parse(readFileSync(join(co.ixHome, name), "utf8"));
  const confirmed = Object.keys(checkpoint.files);
  expect(confirmed).toHaveLength(1);
  // Even the already confirmed file needs fresh evidence if its bytes change during the interruption.
  const changed = source("ready", "resumed");
  writeFileSync(confirmed[0], changed);
  map(co);
  const recovered = confirmed[0] === join(co.dir, rel) ? rel : "use.ts";
  expect((await evidence(co, changed, recovered))?.writes[0].observed.to.value).toBe("resumed");
  if (recovered !== rel) expect((await evidence(co, source()))?.writes[0].observed.to.value).toBe("running");
  expect(JSON.parse(readFileSync(path, "utf8")).extractor).toBe(core[1].extractorName());
  expect(readdirSync(co.ixHome)).not.toContain(name);
});
