// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";

import { saveIngestBaseline } from "../ingest-baseline.js";
import { repoWorkspaceIdFor } from "../system.js";
import { verifyRecordPath } from "../config.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import {
  classifyFile,
  diffNodes,
  expectedNodes,
  fileIdentity,
  graphVerdict,
  loadVerifyRecord,
  pickVerifyFiles,
  recordFromReport,
  runVerify,
  saveVerifyRecord,
  storedNodes,
  VERIFY_DEFAULT_KINDS,
  verifyRecordOutdated,
  type VerifyNode,
  type VerifyReport,
} from "../verify.js";

/**
 * CL-24A: `ix verify` compares a re-parse with the stored nodes. These pin the
 * pure parts (sampling, node sets, the diff, the verdict) and, against a fake
 * client, the shapes that matter: stale vs diverged (F-01), multi-repo
 * identity, and the refusals.
 */

const node = (kind: string, name: string, lineStart: number | null = 1, lineEnd: number | null = 2): VerifyNode =>
  ({ kind, name, lineStart, lineEnd });

describe("pickVerifyFiles", () => {
  const root = "/w";
  const baseline = {
    files: new Map<string, number>([
      ["/w/a.ts", 1], ["/w/b.ts", 2], ["/w/c.ts", 3], ["/w/d.ts", 4], ["/w/e.ts", 5],
      ["/w/f.ts", 6], ["/w/g.ts", 7], ["/w/h.ts", 8], ["/w/slow.ts", 99], ["/w/x.unknown", 100],
    ]),
    replayedFiles: ["c.ts"],
    parseTimeouts: ["slow.ts"],
  };
  const supported = (rel: string) => !rel.endsWith(".unknown");

  it("is deterministic for a given seed", () => {
    const a = pickVerifyFiles(root, baseline, { sample: 6, seed: 7, supported });
    const b = pickVerifyFiles(root, baseline, { sample: 6, seed: 7, supported });
    expect(a).toEqual(b);
    expect(a).toHaveLength(6);
  });

  it("puts explicit paths first, then replayed files, then the newest", () => {
    const picked = pickVerifyFiles(root, baseline, { sample: 4, seed: 1, explicit: ["a.ts"], supported });
    expect(picked[0]).toBe("a.ts");
    expect(picked[1]).toBe("c.ts");
    // ceil(4/2) = 2 recent ones on top of the two already picked: h.ts is the newest eligible.
    expect(picked[2]).toBe("h.ts");
    expect(picked).toHaveLength(4);
  });

  it("skips parse timeouts and unsupported grammars", () => {
    const picked = pickVerifyFiles(root, baseline, { sample: 100, seed: 1, supported });
    expect(picked).not.toContain("slow.ts");
    expect(picked).not.toContain("x.unknown");
    expect(picked).toHaveLength(8);
  });

  it("reads workspace-relative baseline keys too", () => {
    const picked = pickVerifyFiles(root, { files: new Map([["src/a.ts", 1]]), replayedFiles: [], parseTimeouts: [] },
      { sample: 5, seed: 1 });
    expect(picked).toEqual(["src/a.ts"]);
  });
});

describe("expectedNodes", () => {
  it("drops chunk and external nodes, and maps section start_line/end_line", () => {
    const got = expectedNodes({ ops: [
      { type: "UpsertNode", id: "f", kind: "file", name: "a.md", attrs: { line_start: 1, line_end: 9 } },
      { type: "UpsertNode", id: "c", kind: "chunk", name: "body", attrs: { start_line: 1, end_line: 2 } },
      { type: "UpsertNode", id: "x", kind: "function", name: "ext", attrs: { external: true } },
      { type: "UpsertNode", id: "s", kind: "section", name: "Intro", attrs: { start_line: 3, end_line: 5 } },
      { type: "UpsertEdge", id: "e", src: "f", dst: "s", predicate: "CONTAINS" },
    ] });
    expect([...got.keys()]).toEqual(["f", "s"]);
    expect(got.get("s")).toEqual(node("section", "Intro", 3, 5));
  });
});

describe("storedNodes", () => {
  const row = (id: string, uri: string, extra: Record<string, unknown> = {}) => ({
    id, kind: "function", name: id, attrs: { line_start: 1, line_end: 2 }, provenance: { sourceUri: uri }, ...extra,
  });

  it("keeps an exact source path only, not a substring hit", () => {
    const got = storedNodes([row("a", "src/a.ts"), row("b", "src/a.ts.bak"), row("c", "lib/src/a.ts")], "src/a.ts");
    expect([...got.keys()]).toEqual(["a"]);
  });

  it("accepts both source_uri spellings and Windows separators", () => {
    const got = storedNodes([
      { id: "a", kind: "function", name: "a", attrs: {}, provenance: { source_uri: "src/a.ts" } } as any,
      row("b", "src\\a.ts"),
    ], "src\\a.ts");
    expect([...got.keys()].sort()).toEqual(["a", "b"]);
  });

  it("drops chunks, externals and tombstones", () => {
    const got = storedNodes([
      row("a", "a.ts", { kind: "chunk" }),
      row("b", "a.ts", { attrs: { external: true } }),
      row("c", "a.ts", { deletedRev: 4 }),
      row("d", "a.ts"),
    ], "a.ts");
    expect([...got.keys()]).toEqual(["d"]);
  });
});

describe("diffNodes", () => {
  it("reports missing, extra and changed name, kind and line spans", () => {
    const exp = new Map([["1", node("function", "f", 1, 5)], ["2", node("class", "C")], ["3", node("function", "g")]]);
    const got = new Map([["1", node("method", "f2", 2, 6)], ["2", node("class", "C")], ["4", node("function", "old")]]);
    const diff = diffNodes(exp, got);
    expect(diff.missing).toEqual([{ id: "3", kind: "function", name: "g" }]);
    expect(diff.extra).toEqual([{ id: "4", kind: "function", name: "old" }]);
    expect(diff.changed.map((c) => c.field).sort()).toEqual(["kind", "lineEnd", "lineStart", "name"]);
  });
});

describe("classifyFile", () => {
  const empty = { missing: [], extra: [], changed: [] };
  const missing = { missing: [{ id: "1", kind: "function", name: "f" }], extra: [], changed: [] };

  it("clean when hashes match and nodes match", () => {
    expect(classifyFile("h", "h", empty, false, 3)).toEqual({ state: "clean" });
  });
  it("stale when the bytes changed since ingest", () => {
    expect(classifyFile("h2", "h1", missing, false, 3).state).toBe("stale");
  });
  it("diverged when the hash is equal and nodes are missing", () => {
    expect(classifyFile("h", "h", missing, false, 0)).toEqual({ state: "diverged" });
  });
  it("F-01: the stored hash is the edit in between, so only a recorded replay makes it diverged", () => {
    // The backend's source hash is the newest stored patch's; an Idempotent
    // revert writes none, so the hashes differ even though nothing is pending.
    expect(classifyFile("h2", "h1", missing, false, 3, true)).toEqual({ state: "diverged", reason: "replayed_not_applied" });
    // Not recorded as replayed: indistinguishable from an edit since the map.
    expect(classifyFile("h2", "h1", missing, false, 3, false)).toEqual({ state: "stale", reason: "changed_since_ingest" });
  });
  it("unverified when truncated, with no comparison, or with no hash and no nodes", () => {
    expect(classifyFile("h", "h", empty, true).state).toBe("unverified");
    expect(classifyFile("h", "h", null, false).state).toBe("unverified");
    expect(classifyFile("h", undefined, missing, false, 0)).toEqual({ state: "unverified", reason: "not_in_graph" });
  });
  it("without a hash lookup, a match is still clean and a mismatch is not judged", () => {
    expect(classifyFile("h", null, empty, false, 1).state).toBe("clean");
    expect(classifyFile("h", null, missing, false, 1)).toEqual({ state: "unverified", reason: "hash_unknown" });
  });
});

describe("graphVerdict", () => {
  it("does not call stale files divergence", () => {
    expect(graphVerdict({ files: 3, clean: 2, stale: 1, diverged: 0, unverified: 0 })).toEqual({ graph: "clean", fix: "ix map" });
    expect(graphVerdict({ files: 3, clean: 1, stale: 1, diverged: 1, unverified: 0 }).graph).toBe("diverged");
    expect(graphVerdict({ files: 2, clean: 0, stale: 0, diverged: 0, unverified: 2 }).graph).toBe("unverified");
  });
});

// ── With a workspace on disk ────────────────────────────────────────────

let home: string;
let savedIxHome: string | undefined;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-verify-")));
  savedIxHome = process.env.IX_HOME;
  process.env.IX_HOME = home;
});

afterEach(() => {
  if (savedIxHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = savedIxHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function register(root: string, workspaceId = "ws1"): void {
  fs.writeFileSync(nodePath.join(home, "config.yaml"),
    `endpoint: http://127.0.0.1:1\nformat: text\nworkspaces:\n  - workspace_id: "${workspaceId}"\n` +
    `    workspace_name: repo\n    root_path: ${root}\n    default: true\n`);
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

/** What ingest would have stored for `rel`, as `/v1/list` rows. */
async function ingestedRows(root: string, rel: string, workspaceId: string) {
  const [{ parseFile }, { buildPatchWithResolution, extractorName }] = await loadIngestionModules();
  const src = fs.readFileSync(nodePath.join(root, rel), "utf-8");
  const { fileWorkspaceId, fileMultiRepo } = fileIdentity(root, workspaceId);
  const build = buildPatchWithResolution as (...a: unknown[]) => { ops: Array<Record<string, any>> };
  const patch = build(parseFile(rel, src), sha(src), fileWorkspaceId(rel), [], undefined, fileMultiRepo(rel));
  return {
    extractor: extractorName(),
    ws: fileWorkspaceId(rel),
    hash: sha(src),
    rows: patch.ops.filter((o) => o.type === "UpsertNode").map((o) => ({
      id: o.id, kind: o.kind, name: o.name, attrs: o.attrs, provenance: { sourceUri: rel, sourceHash: sha(src) },
    })),
  };
}

function fakeClient(store: { rows: any[]; hashes: Array<{ workspaceId: string; uri: string; hash: string }>; stats?: boolean }) {
  const calls: Array<{ kind: string; scope?: string; workspaceId?: string }> = [];
  return {
    calls,
    client: {
      // /v1/stats byKind: every kind the store holds, as the backend counts them.
      ...(store.stats ? {
        async stats() {
          const kinds = [...new Set(store.rows.map((r) => r.kind as string))];
          return { nodes: { total: store.rows.length, byKind: kinds.map((kind) => ({ kind, count: 1 })) } };
        },
      } : {}),
      async listByKind(kind: string, opts?: { scope?: string; workspaceId?: string }) {
        calls.push({ kind, scope: opts?.scope, workspaceId: opts?.workspaceId });
        return store.rows.filter((r) => r.kind === kind && r.provenance.sourceUri.includes(opts?.scope ?? ""));
      },
      async getSourceHashes() { return store.hashes; },
    } as any,
  };
}

describe("runVerify", () => {
  it("is unverified/not_mapped with no workspace, and suggests ix map", async () => {
    const root = nodePath.join(home, "nowhere");
    fs.mkdirSync(root);
    const report = await runVerify(fakeClient({ rows: [], hashes: [] }).client, root);
    expect(report).toMatchObject({ graph: "unverified", reason: "not_mapped", fix: "ix map" });
  });

  it("refuses to judge when the extractor changed", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    register(root);
    saveIngestBaseline(root, new Map([[nodePath.join(root, "a.ts"), 1]]), 3, new Date(), new Map(), "old-extractor/0");
    const report = await runVerify(fakeClient({ rows: [], hashes: [] }).client, root);
    expect(report).toMatchObject({ graph: "unverified", reason: "extractor_changed", fix: "ix map" });
  });

  it("clean, stale, and diverged (same bytes, nodes missing)", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    fs.writeFileSync(nodePath.join(root, "b.ts"), "export function b() { return 2; }\nexport class B {}\n");
    fs.writeFileSync(nodePath.join(root, "c.ts"), "export function c() { return 3; }\n");
    register(root);
    const a = await ingestedRows(root, "a.ts", "ws1");
    const b = await ingestedRows(root, "b.ts", "ws1");
    const c = await ingestedRows(root, "c.ts", "ws1");
    saveIngestBaseline(root, new Map(["a.ts", "b.ts", "c.ts"].map((f, i) => [nodePath.join(root, f), i])), 3,
      new Date(), new Map(), a.extractor);
    // b.ts: the graph lost its function (hash still current). c.ts: edited since ingest.
    const store = {
      rows: [...a.rows, ...b.rows.filter((r) => r.kind !== "function"), ...c.rows],
      hashes: [
        { workspaceId: "ws1", uri: "a.ts", hash: a.hash },
        { workspaceId: "ws1", uri: "b.ts", hash: b.hash },
        { workspaceId: "ws1", uri: "c.ts", hash: "older" },
      ],
    };
    const { client, calls } = fakeClient(store);
    const report = await runVerify(client, root, { sample: 10 });
    const state = Object.fromEntries(report.files.map((f) => [f.path, f.state]));
    expect(state).toEqual({ "a.ts": "clean", "b.ts": "diverged", "c.ts": "stale" });
    expect(report.graph).toBe("diverged");
    expect(report.fix).toBe("ix reset --workspace --yes --ingest");
    expect(report.files.find((f) => f.path === "b.ts")!.missing).toEqual([expect.objectContaining({ kind: "function", name: "b" })]);
    // Scoped, per-file workspace, never a chunk read.
    expect(calls.every((c) => c.workspaceId === "ws1" && c.kind !== "chunk")).toBe(true);
    // No edge fields anywhere in the report.
    expect(JSON.stringify(report)).not.toMatch(/edge|predicate|CONTAINS/i);
    // The record is saved for status/doctor.
    expect(loadVerifyRecord(root)).toMatchObject({ graph: "diverged", files: 3, diverged: 1, stale: 1, divergedFiles: ["b.ts"] });
  });

  it("diverged when the graph holds an extra node the re-parse does not (hash current)", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    register(root);
    const a = await ingestedRows(root, "a.ts", "ws1");
    saveIngestBaseline(root, new Map([[nodePath.join(root, "a.ts"), 1]]), 3, new Date(), new Map(), a.extractor);
    // A leftover from an older edit that was never retracted.
    const fn = a.rows.find((r) => r.kind === "function")!;
    const ghost = { ...fn, id: "ghost-node-id", name: "removedLongAgo" };
    const { client } = fakeClient({ rows: [...a.rows, ghost], hashes: [{ workspaceId: "ws1", uri: "a.ts", hash: a.hash }] });
    const report = await runVerify(client, root, { sample: 10 });
    expect(report.graph).toBe("diverged");
    expect(report.files[0]).toMatchObject({ path: "a.ts", state: "diverged", missing: [] });
    expect(report.files[0].extra).toEqual([expect.objectContaining({ id: "ghost-node-id", name: "removedLongAgo" })]);
  });

  it("F-01 end to end: a recorded not-applied revert is diverged, an unrecorded one is only stale", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    // On disk: the reverted bytes. In the graph: the edit in between, whose
    // patch is still the newest, so its hash is the stored one.
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function between() { return 2; }\n");
    register(root);
    const between = await ingestedRows(root, "a.ts", "ws1");
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    const store = { rows: between.rows, hashes: [{ workspaceId: "ws1", uri: "a.ts", hash: between.hash }] };
    const ingestedAt = new Date(Date.now() + 5_000); // after the revert's mtime
    const files = new Map([[nodePath.join(root, "a.ts"), 1]]);

    saveIngestBaseline(root, files, 3, ingestedAt, new Map(), between.extractor, { replayedFiles: ["a.ts"] });
    const recorded = await runVerify(fakeClient(store).client, root, { sample: 5 });
    expect(recorded.files[0]).toMatchObject({ path: "a.ts", state: "diverged", reason: "replayed_not_applied" });
    expect(recorded.graph).toBe("diverged");

    saveIngestBaseline(root, files, 3, ingestedAt, new Map(), between.extractor);
    const unrecorded = await runVerify(fakeClient(store).client, root, { sample: 5 });
    expect(unrecorded.files[0]).toMatchObject({ path: "a.ts", state: "stale", reason: "changed_since_ingest" });
    expect(unrecorded.graph).toBe("clean");
  });

  it("reads every kind the workspace holds: a stored node of a kind the parse never produces is extra", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    register(root);
    const a = await ingestedRows(root, "a.ts", "ws1");
    saveIngestBaseline(root, new Map([[nodePath.join(root, "a.ts"), 1]]), 3, new Date(), new Map(), a.extractor);
    // `section` is neither in VERIFY_DEFAULT_KINDS nor anything a .ts parse makes.
    expect(VERIFY_DEFAULT_KINDS).not.toContain("section");
    expect([...expectedNodes({ ops: [] }).values()]).toEqual([]);
    const leftover = { id: "old-section-id", kind: "section", name: "Old heading", attrs: { start_line: 1, end_line: 1 },
      provenance: { sourceUri: "a.ts", sourceHash: a.hash } };
    const store = { rows: [...a.rows, leftover], hashes: [{ workspaceId: "ws1", uri: "a.ts", hash: a.hash }], stats: true };
    const { client, calls } = fakeClient(store);
    const report = await runVerify(client, root, { sample: 5 });
    expect(calls.some((c) => c.kind === "section" && c.scope === "a.ts")).toBe(true);
    expect(report.graph).toBe("diverged");
    expect(report.files[0]).toMatchObject({ path: "a.ts", state: "diverged", missing: [] });
    expect(report.files[0].extra).toEqual([{ id: "old-section-id", kind: "section", name: "Old heading" }]);
  });

  it("a named path whose parse timed out, or over ingest's size limit, is unverified and never parsed", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "slow.ts"), "export function slow() { return 1; }\n");
    fs.writeFileSync(nodePath.join(root, "big.ts"), `export const big = "${"x".repeat(1024 * 1024)}";\n`);
    register(root);
    const [parser, builder, languages] = await loadIngestionModules();
    let parsed = 0;
    const loadModules = async (): Promise<Awaited<ReturnType<typeof loadIngestionModules>>> => [
      { ...parser, parseFile: (...args: Parameters<typeof parser.parseFile>) => { parsed++; return parser.parseFile(...args); } },
      builder,
      languages,
    ];
    saveIngestBaseline(root, new Map(), 3, new Date(), new Map(), builder.extractorName(), { parseTimeouts: ["slow.ts"] });
    const report = await runVerify(fakeClient({ rows: [], hashes: [] }).client, root, { paths: ["slow.ts", "big.ts"], sample: 2, loadModules });
    expect(report.files).toEqual([
      expect.objectContaining({ path: "slow.ts", state: "unverified", reason: "parse_timed_out" }),
      expect.objectContaining({ path: "big.ts", state: "unverified", reason: "too_large" }),
    ]);
    expect(parsed).toBe(0);
  });

  it("only a whole-root run saves the status record; named paths and record:false do not", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    register(root);
    const a = await ingestedRows(root, "a.ts", "ws1");
    saveIngestBaseline(root, new Map([[nodePath.join(root, "a.ts"), 1]]), 3, new Date(), new Map(), a.extractor);
    const store = { rows: a.rows, hashes: [{ workspaceId: "ws1", uri: "a.ts", hash: a.hash }] };
    await runVerify(fakeClient(store).client, root, { paths: ["a.ts"] });
    await runVerify(fakeClient(store).client, root, { record: false });
    expect(fs.existsSync(verifyRecordPath(root))).toBe(false);
    await runVerify(fakeClient(store).client, root);
    expect(loadVerifyRecord(root)).toMatchObject({ graph: "clean", files: 1 });
  });

  it("a non-canonical root (trailing slash, '.', a symlink) finds the canonical baseline and record", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    register(root);
    const a = await ingestedRows(root, "a.ts", "ws1");
    saveIngestBaseline(root, new Map([[nodePath.join(root, "a.ts"), 1]]), 3, new Date(), new Map(), a.extractor);
    const link = nodePath.join(home, "link");
    fs.symlinkSync(root, link);
    const store = { rows: a.rows, hashes: [{ workspaceId: "ws1", uri: "a.ts", hash: a.hash }] };
    for (const input of [`${root}/`, `${root}/.`, link]) {
      const report = await runVerify(fakeClient(store).client, input);
      expect(report).toMatchObject({ root, graph: "clean" });
      expect(loadVerifyRecord(input)).toMatchObject({ root, graph: "clean" });
    }
  });

  it("a failed list makes that file unverified, not a crash", async () => {
    const root = nodePath.join(home, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(nodePath.join(root, "a.ts"), "export function a() { return 1; }\n");
    register(root);
    const a = await ingestedRows(root, "a.ts", "ws1");
    saveIngestBaseline(root, new Map([[nodePath.join(root, "a.ts"), 1]]), 3, new Date(), new Map(), a.extractor);
    const client = {
      async listByKind() { throw new Error("500: boom"); },
      async getSourceHashes() { throw new Error("404: not found"); },
    } as any;
    const report = await runVerify(client, root);
    expect(report.files).toEqual([expect.objectContaining({ path: "a.ts", state: "unverified", reason: "list_failed" })]);
    expect(report.graph).toBe("unverified");
  });

  it("multi-repo: per-repo workspace ids and member-relative ids, as ingest builds them", async () => {
    const root = nodePath.join(home, "system");
    for (const repo of ["repo-a", "repo-b"]) {
      fs.mkdirSync(nodePath.join(root, repo, ".git"), { recursive: true });
      fs.mkdirSync(nodePath.join(root, repo, "src"), { recursive: true });
      fs.writeFileSync(nodePath.join(root, repo, "package.json"), `{"name":"${repo}"}`);
      fs.writeFileSync(nodePath.join(root, repo, "src", "x.ts"), "export function x() { return 1; }\n");
    }
    const { fileWorkspaceId, fileMultiRepo } = fileIdentity(root, "system-ws");
    expect(fileWorkspaceId("repo-a/src/x.ts")).toBe(repoWorkspaceIdFor(root, "repo-a"));
    expect(fileWorkspaceId("repo-b/src/x.ts")).toBe(repoWorkspaceIdFor(root, "repo-b"));
    expect(fileMultiRepo("repo-a/src/x.ts")).toMatchObject({ repoId: "repo-a", systemId: expect.any(String) });

    // A member's node ids are the ids its own solo ingest gives it.
    const coIngested = await ingestedRows(root, "repo-a/src/x.ts", "system-ws");
    const solo = await ingestedRows(nodePath.join(root, "repo-a"), "src/x.ts", repoWorkspaceIdFor(root, "repo-a"));
    expect(coIngested.rows.map((r) => r.id).sort()).toEqual(solo.rows.map((r) => r.id).sort());
    expect(coIngested.ws).toBe(solo.ws);

    // And verify, run over the system, finds them clean.
    register(root, "system-ws");
    saveIngestBaseline(root, new Map([[nodePath.join(root, "repo-a/src/x.ts"), 1]]), 3, new Date(), new Map(), coIngested.extractor);
    const { client, calls } = fakeClient({
      rows: coIngested.rows,
      hashes: [{ workspaceId: coIngested.ws, uri: "repo-a/src/x.ts", hash: coIngested.hash }],
    });
    const report = await runVerify(client, root);
    expect(report.files).toEqual([expect.objectContaining({ path: "repo-a/src/x.ts", state: "clean" })]);
    expect(calls.every((c) => c.workspaceId === repoWorkspaceIdFor(root, "repo-a"))).toBe(true);
  });
});

describe("verify record", () => {
  const report: VerifyReport = {
    at: "2026-10-11T00:00:00.000Z", root: "/r", lastIngestAt: "2026-10-10T00:00:00.000Z",
    graph: "diverged", fix: "ix reset --workspace --yes --ingest", sample: 20, seed: 24,
    counts: { files: 2, clean: 1, stale: 0, diverged: 1, unverified: 0 },
    files: [
      { path: "a.ts", state: "clean", expectedNodes: 1, storedNodes: 1, missing: [], extra: [], changed: [] },
      { path: "b.ts", state: "diverged", expectedNodes: 2, storedNodes: 1, missing: [], extra: [], changed: [] },
    ],
  };

  it("round-trips", () => {
    expect(saveVerifyRecord(recordFromReport(report))).toBe(true);
    expect(loadVerifyRecord("/r")).toEqual(recordFromReport(report));
    expect(loadVerifyRecord("/other")).toBeNull();
  });

  it("is outdated once the workspace has been ingested after it ran", () => {
    const record = recordFromReport(report);
    expect(verifyRecordOutdated(record, report.lastIngestAt)).toBe(false);
    expect(verifyRecordOutdated(record, "2026-10-12T00:00:00.000Z")).toBe(true);
    expect(verifyRecordOutdated(record, null)).toBe(false);
    expect(verifyRecordOutdated({ lastIngestAt: null }, "2026-10-12T00:00:00.000Z")).toBe(true);
  });

  it("reads a corrupt record as null", () => {
    fs.writeFileSync(verifyRecordPath("/r"), "{not json");
    expect(loadVerifyRecord("/r")).toBeNull();
  });
});

describe("docs/llm-format.md", () => {
  // Every reason verify can emit is documented: a consumer branching on
  // `reason=` must not meet an undocumented value (e.g. `no_files`).
  it("lists every reason verify.ts emits", () => {
    const here = nodePath.dirname(new URL(import.meta.url).pathname);
    const src = fs.readFileSync(nodePath.join(here, "..", "verify.ts"), "utf-8");
    const doc = fs.readFileSync(nodePath.join(here, "..", "..", "..", "..", "docs", "llm-format.md"), "utf-8");
    const reasons = new Set<string>();
    for (const re of [/reason: "([a-z_]+)"/g, /unverified\("([a-z_]+)"/g, /"(?:unverified|stale|diverged)", "([a-z_]+)"\)/g]) {
      for (const m of src.matchAll(re)) reasons.add(m[1]);
    }
    expect(reasons).toContain("no_files");
    expect(reasons).toContain("parse_timed_out");
    for (const reason of reasons) expect(doc, reason).toMatch(new RegExp(`[\`=]${reason}\``));
  });
});
