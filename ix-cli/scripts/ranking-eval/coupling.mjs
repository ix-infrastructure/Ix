// Copyright 2026 Ix Infrastructure Inc.

// Offline multi-file localization slice. Reads git objects at each base commit,
// never checks out a branch, and never uses the gold commit as mining evidence.
// node coupling.mjs --repo <path> --instances <single-repo.jsonl>
// Without --instances, use recent fix subjects as a labelled local proxy.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mineHistory, couplingIndex, coupledFor } from "../../dist/cli/git-coupling.js";
import { planIssue, rankIssueFiles, isSourcePath } from "../../dist/cli/explain/issue.js";
import { coChangedFiles } from "../../dist/cli/explain/history.js";
import {
  expandIssueCompanions,
  MAX_COMPANION_HISTORY,
} from "../../dist/cli/explain/issue-companions.js";
import { defSearch } from "./defs.mjs";
import { goldFiles } from "./corpus.mjs";

const args = process.argv.slice(2);
const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const root = resolve(option("--repo", "."));
const limit = Math.max(1, Number(option("--samples", "20")));
const git = (...args) =>
  execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });

function corpus(revision) {
  const files = [],
    wanted = [];
  let bytes = 0;
  for (const row of git("ls-tree", "-r", "-z", "--long", revision).split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const [mode, type, oid, size] = row.slice(0, tab).trim().split(/\s+/);
    const path = row.slice(tab + 1);
    if (type !== "blob" || mode === "120000") continue;
    files.push(path);
    if (isSourcePath(path) && Number(size) <= 200 * 1024) {
      bytes += Number(size);
      if (bytes > 128 * 1024 * 1024) throw new Error("Evaluation corpus exceeds 128 MiB");
      wanted.push({ path, oid });
    }
  }
  const texts = new Map();
  if (wanted.length) {
    const result = spawnSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: wanted.map((w) => w.oid).join("\n") + "\n",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.error || result.status) throw result.error ?? new Error("git cat-file failed");
    let pos = 0;
    for (const wantedFile of wanted) {
      const end = result.stdout.indexOf(10, pos);
      const size = Number(result.stdout.toString("utf8", pos, end).split(" ")[2]);
      texts.set(wantedFile.path, result.stdout.toString("utf8", end + 1, end + 1 + size));
      pos = end + 1 + size + 1;
    }
  }
  return { files: () => files, read: (p) => texts.get(p), grep: () => [] };
}

let instances;
const manifest = option("--instances");
if (manifest)
  instances = readFileSync(manifest, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
else {
  const state = await mineHistory(root);
  instances = (state?.commits ?? [])
    .filter((c) => /\b(?:fix|bug|regression)\b/i.test(c.subject))
    .map((c) => ({
      instance_id: c.sha,
      base_commit: `${c.fullSha}^`,
      problem_statement: c.subject,
      gold: c.entities
        .filter((e) => e.key === undefined)
        .map((e) => e.path)
        .filter(isSourcePath),
    }))
    .filter((c) => c.gold.length > 1)
    .slice(0, limit);
}
const fAt5 = (pred, gold) => gold.filter((p) => pred.slice(0, 5).includes(p)).length / gold.length;
const rows = [];
for (const row of instances.slice(0, limit)) {
  const repo = corpus(row.base_commit),
    tracked = new Set(repo.files());
  const gold = (row.gold ?? goldFiles(row.patch)).filter((p) => isSourcePath(p) && tracked.has(p));
  if (gold.length < 2) continue;
  const now = new Date(git("show", "-s", "--format=%cI", row.base_commit).trim());
  const start = performance.now();
  const state = await mineHistory(root, undefined, { revision: row.base_commit, now });
  const index = couplingIndex(state, undefined, (entity) => tracked.has(entity.path));
  const mineMs = performance.now() - start;
  const partners = coupledFor(index, { path: gold[0] }, 5).partners.map((p) => p.path);
  const plan = await planIssue(row.problem_statement, {
    repo,
    search: defSearch(repo, repo.files().filter(isSourcePath)),
  });
  const primary = rankIssueFiles({
    starts: plan.starts,
    bm25: plan.bm25,
    near: new Map(),
    sourcePaths: plan.sourcePaths,
  });
  const gitAtBase = async (args) => git(args[0], row.base_commit, ...args.slice(1));
  const before = await expandIssueCompanions(row.problem_statement, primary, {
    repo,
    history: (path) => coChangedFiles(gitAtBase, path, new Set(), MAX_COMPANION_HISTORY),
  });
  const after = await expandIssueCompanions(row.problem_statement, primary, {
    repo,
    history: async (path) =>
      coupledFor(index, { path }).partners.map((p) => ({
        path: p.path,
        commits: p.support,
        score: p.confidence,
      })),
  });
  rows.push({
    id: row.instance_id,
    gold,
    secondGoldAt5: partners.includes(gold[1]),
    beforeFAt5: fAt5(
      before.map((f) => f.path),
      gold,
    ),
    afterFAt5: fAt5(
      after.map((f) => f.path),
      gold,
    ),
    mineMs,
  });
}
const mean = (field) =>
  rows.length ? rows.reduce((sum, row) => sum + Number(row[field]), 0) / rows.length : null;
console.log(
  JSON.stringify(
    {
      dataset: manifest ? "localization manifest" : "local fix-subject proxy (not issue benchmark)",
      instances: rows.length,
      secondGoldRecallAt5: mean("secondGoldAt5"),
      beforeFAt5: mean("beforeFAt5"),
      afterFAt5: mean("afterFAt5"),
      meanMineMs: mean("mineMs"),
      rows,
    },
    null,
    2,
  ),
);
