// Copyright 2026 Ix Infrastructure Inc.

// Reproducible ingestion overhead on a synthetic 5,000-file / 2,000-commit
// repository, real parsers and git, and the existing in-process HTTP backend.
// No external backend, checkout or benchmark download is needed.
// Run from ix-cli: npx tsx scripts/bench-git-coupling.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { FakeBackend } from "../src/cli/__tests__/helpers/fake-backend.js";
import { ingestFiles } from "../src/cli/commands/ingest.js";
import { loadIngestionModules } from "../src/cli/commands/ingestion-loader.js";
import { loadHistory } from "../src/cli/git-coupling.js";

const root = mkdtempSync(
  join(fileURLToPath(new URL("../../", import.meta.url)), ".coupling-bench-"),
);
const priorEndpoint = process.env.IX_ENDPOINT,
  priorIxHome = process.env.IX_HOME;
const backend = new FakeBackend({ semantics: "head" });
try {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [];
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  for (let commit = 0; commit <= 2000; commit++) {
    lines.push(
      `commit refs/heads/main\nmark :${commit + 1}\ncommitter Fixture <fixture@example.org> ${now - 2000 + commit} +0000\n`,
    );
    lines.push(data(commit ? `fix paired ${commit}` : "initial fixture"));
    if (commit) lines.push(`from :${commit}\n`);
    const files = commit
      ? [(commit % 100) * 2, (commit % 100) * 2 + 1]
      : Array.from({ length: 5000 }, (_, i) => i);
    for (const i of files) {
      lines.push(`M 100644 inline f${i}.ts\n`);
      lines.push(data(`export function f${i}() {\n  return ${commit};\n}\n`));
    }
    lines.push("\n");
  }
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: root,
    input: lines.join(""),
    maxBuffer: 1024 * 1024,
  });
  git("reset", "--hard", "main");
  process.env.IX_HOME = join(root, ".git", "ix-home");
  process.env.IX_ENDPOINT = await backend.start();
  await loadIngestionModules();
  const options = {
    root,
    recursive: true,
    format: "json",
    force: true,
    suppressOutput: true,
    printSummary: false,
    mapMode: true,
  };
  const baselineStart = performance.now();
  await ingestFiles(root, { ...options, gitHistory: false });
  const baselineMs = performance.now() - baselineStart;
  const baseline = backend.graphSignature();
  const enabledStart = performance.now();
  const enabled = await ingestFiles(root, options);
  const enabledMs = performance.now() - enabledStart;
  if (!enabled.gitHistory || enabled.gitHistoryWarning)
    throw new Error(enabled.gitHistoryWarning ?? "History was not mined");
  const graph = backend.graphSignature();
  const unchangedStart = performance.now();
  const unchanged = await ingestFiles(root, { ...options, force: false });
  const unchangedMs = performance.now() - unchangedStart;
  const historyOps = [...backend.lastOps]
    .filter(([uri]) => uri.startsWith("ix:git-history/"))
    .flatMap(([, ops]) => ops);
  console.log(
    JSON.stringify(
      {
        fixture: { files: 5000, commits: 2000 },
        backend: "in-process protocol fixture",
        baselineMs,
        enabledMs,
        overheadMs: enabledMs - baselineMs,
        unchangedMs,
        baselineNodes: baseline.nodes.length,
        baselineEdges: baseline.edges.length,
        addedNodes: graph.nodes.length - baseline.nodes.length,
        addedEdges: graph.edges.length - baseline.edges.length,
        edgeOpsBytes: Buffer.byteLength(JSON.stringify(historyOps)),
        historyCacheBytes: Buffer.byteLength(JSON.stringify(loadHistory(root))),
        history: enabled.gitHistory,
        unchangedMined: unchanged.gitHistory?.mined,
      },
      null,
      2,
    ),
  );
} finally {
  await backend.stop();
  if (priorEndpoint === undefined) delete process.env.IX_ENDPOINT;
  else process.env.IX_ENDPOINT = priorEndpoint;
  if (priorIxHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = priorIxHome;
  rmSync(root, { recursive: true, force: true });
}
