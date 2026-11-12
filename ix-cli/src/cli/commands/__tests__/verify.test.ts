// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend } from "../../__tests__/helpers/fake-backend.js";
import { runCommand } from "../../__tests__/helpers/run-command.js";
import { loadIngestionModules } from "../ingestion-loader.js";
import { saveIngestBaseline } from "../../ingest-baseline.js";
import { verifyRecordPath } from "../../config.js";

/**
 * CL-24A: `ix verify` end to end, through `runCommand`, against the shared
 * `FakeBackend` holding what the parser would have committed. Every verdict
 * exits 0; only a usage error or an unreachable backend exits 1, the way
 * `ix status` does.
 */

let backend: FakeBackend;
let home: string;
let repo: string;
let savedHome: string | undefined;

beforeEach(async () => {
  backend = new FakeBackend({ semantics: "head" });
  await backend.start();
  // realpathSync.native, as ingest canonicalizes its root: plain realpathSync
  // keeps a Windows 8.3 name (RUNNER~1) that `ix verify` expands.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-verify-cmd-")));
  repo = join(home, "repo");
  mkdirSync(repo);
  savedHome = process.env.IX_HOME;
  process.env.IX_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = savedHome;
  await backend.stop();
  expect(backend.unknownPaths, "endpoints the fake does not implement").toEqual([]);
  rmSync(home, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

/**
 * A mapped one-file workspace: the parser's own patch for it, committed to the
 * backend through `/v1/patch`, and the baseline `ix map` leaves.
 * `dropFunction` commits it without the function node (a graph that lost one);
 * `staleHash` records an older source hash than the file on disk.
 */
async function mapped(opts: { dropFunction?: boolean; staleHash?: boolean } = {}): Promise<void> {
  writeFileSync(join(home, "config.yaml"),
    `endpoint: ${backend.url}\nformat: text\nworkspaces:\n  - workspace_id: "ws1"\n    workspace_name: repo\n    root_path: ${repo}\n    default: true\n`);
  const src = "export function greet() { return 'hi'; }\n";
  writeFileSync(join(repo, "a.ts"), src);
  const [{ parseFile }, { buildPatchWithResolution, extractorName }] = await loadIngestionModules();
  const build = buildPatchWithResolution as (...a: unknown[]) => {
    source: { sourceHash?: string }; ops: Array<Record<string, unknown>>;
  };
  const patch = build(parseFile("a.ts", src), sha(src), "ws1", [], undefined, undefined);
  if (opts.staleHash) patch.source.sourceHash = "older";
  if (opts.dropFunction) patch.ops = patch.ops.filter((o) => !(o.type === "UpsertNode" && o.kind === "function"));
  const res = await fetch(`${backend.url}/v1/patch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });
  expect(res.status).toBe(200);
  saveIngestBaseline(repo, new Map([[join(repo, "a.ts"), 1]]), 3, new Date(), new Map(), extractorName());
}

const verify = (...args: string[]) => runCommand(["verify", ...args], backend, { cwd: repo });

describe("ix verify output", () => {
  it("clean: one llm record, exit 0", async () => {
    await mapped();
    const { stdout, exitCode } = await verify("--format", "llm");
    expect(stdout).toMatch(/^verify graph=clean files=1 clean=1 stale=0 diverged=0 unverified=0$/m);
    expect(stdout).not.toMatch(/^file /m);
    expect(exitCode).toBe(0);
  });

  it("stale: the file is listed, the graph is stale -- not diverged, not clean", async () => {
    await mapped({ staleHash: true });
    const { stdout, exitCode } = await verify("--format", "llm");
    expect(stdout).toMatch(/^verify graph=stale files=1 clean=0 stale=1 diverged=0 unverified=0 fix="ix map"$/m);
    expect(stdout).toMatch(/^file path=a\.ts state=stale/m);
    expect(exitCode).toBe(0);
  });

  it("diverged: llm, json and text all name the fix, exit 0", async () => {
    await mapped({ dropFunction: true });
    const llm = await verify("--format", "llm");
    expect(llm.stdout).toMatch(/^verify graph=diverged files=1 clean=0 stale=0 diverged=1 unverified=0 fix="ix reset --workspace --yes --ingest"$/m);
    expect(llm.stdout).toMatch(/^file path=a\.ts state=diverged missing=1 extra=0 changed=0$/m);
    expect(llm.exitCode).toBe(0);

    const json = await verify("--format", "json");
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toMatchObject({ graph: "diverged", counts: { diverged: 1 }, fix: "ix reset --workspace --yes --ingest" });
    expect(parsed.files[0].missing[0]).toMatchObject({ kind: "function", name: "greet" });
    expect(json.exitCode).toBe(0);

    const text = await verify();
    expect(text.stdout).toMatch(/Graph:?\s+diverged/);
    expect(text.stdout).toMatch(/ix reset --workspace --yes --ingest/);
    expect(text.stdout).toMatch(/edges are not compared/);
    expect(text.exitCode).toBe(0);
  });

  it("unverified/not_mapped with no workspace, exit 0", async () => {
    const { stdout, exitCode } = await verify("--format", "llm");
    expect(stdout).toMatch(/^verify graph=unverified reason=not_mapped files=0 .*fix="ix map"/m);
    expect(exitCode).toBe(0);
  });

  it("a 404 or 500 on /v1/list makes the file unverified, not a crash", async () => {
    await mapped();
    for (const status of [404, 500]) {
      backend.failList = status;
      const { stdout, exitCode } = await verify("--format", "llm");
      expect(stdout).toMatch(/^file path=a\.ts state=unverified reason=list_failed/m);
      expect(exitCode).toBe(0);
    }
  });

  it("writes the record ix status reads", async () => {
    await mapped({ dropFunction: true });
    await verify("--format", "llm");
    expect(JSON.parse(readFileSync(verifyRecordPath(repo), "utf-8"))).toMatchObject({ graph: "diverged", diverged: 1 });
  });
});

describe("ix verify roots and the record", () => {
  it("a named path does not replace the record ix status reads", async () => {
    await mapped({ dropFunction: true });
    await verify("a.ts", "--format", "llm");
    expect(existsSync(verifyRecordPath(repo))).toBe(false);
  });

  it("a deleted file named through a symlinked path is stale, not outside the workspace", async () => {
    await mapped();
    rmSync(join(repo, "a.ts"));
    // macOS's /tmp and /var are such links. realpath cannot resolve a path
    // that no longer exists, so its existing parent has to be resolved instead.
    const link = join(home, "link");
    symlinkSync(repo, link, "junction");
    expect((await verify(join(link, "a.ts"), "--format", "llm")).stdout)
      .toMatch(/^file path=a\.ts state=stale reason=missing_on_disk/m);
  });

  it("--root . and --root with a trailing slash find the mapped workspace", async () => {
    await mapped();
    for (const root of [".", `${repo}/`]) {
      expect((await verify("--root", root, "--format", "llm")).stdout).toMatch(/^verify graph=clean files=1 clean=1/m);
    }
  });
});

describe("ix verify errors", () => {
  it("--sample 0 and --sample abc are usage errors: exit 1, the message, no stack trace", async () => {
    for (const bad of ["0", "abc"]) {
      const { stdout, stderr, exitCode } = await verify("--sample", bad);
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toMatch(/--sample/);
      expect(stdout + stderr).not.toMatch(/at .*verify\.ts/);
    }
    const llm = await verify("--sample", "0", "--format", "llm");
    expect(llm.exitCode).toBe(1);
    expect(llm.stdout).toMatch(/^error code=usage_error message=.*--sample/m);
  });

  it("an unreachable backend gives the uniform llm error record and exit 1, like status", async () => {
    await mapped();
    // A port nothing listens on (port 1 is one fetch refuses to dial at all).
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const { stdout, exitCode } = await runCommand(["verify", "--format", "llm"], `http://127.0.0.1:${port}`, { cwd: repo });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^error code=backend_unreachable message=/m);
  });
});
