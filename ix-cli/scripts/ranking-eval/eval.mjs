// Copyright 2026 Ix Infrastructure Inc.

// Score BM25 variants on the dev (or, once, the test) split.
//
//   node eval.mjs --set dev --variants base,code --out results/dev.jsonl [--plan] [--check]
//
// For each instance: read the snapshot at base_commit from ix-bench's bare
// clone, rank the tracked source files against the problem statement with
// each variant, and record file recall @5/@10/@20 against the gold patch's
// source files that exist at the base commit. --plan also scores the plan's
// order (starting files from pickStartingPoints with a regex definition
// search standing in for the graph, then BM25) -- rankIssueFiles with no
// graph closeness. --check asserts `base` equals the baseline bm25Rank.
// The variant `impl` is the built dist/ (the current issue.ts): its own
// isSourcePath, bm25Rank, pickStartingPoints and rankIssueFiles. The variant
// `picks` is the same for fix/issue-start-picking, the branch this is on.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as dist from "../../dist/cli/explain/issue.js";
import { leanContextCandidates, selectContextItems } from "../../dist/cli/precise-context.js";
import { contextPrecisionComparison } from "../../../bench/agent-eval/precision.mjs";
// Gold, the file list and the `base` plan use issue.ts as it was before this
// branch, so the baseline and the scoring stay fixed while issue.ts changes.
import { bm25Rank, isSourcePath, pickStartingPoints, rankIssueFiles } from "./baseline-issue.mjs";
import * as picks from "./picks-issue.mjs";
import { goldFiles, loadCorpus } from "./corpus.mjs";
import { defSearch } from "./defs.mjs";
import { VARIANTS } from "./configs.mjs";
import { rank } from "./variants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
const set = args.set ?? "dev";
if (set === "test" && args.final !== "yes-once") {
  console.error("The test split is scored once, for the final variant: pass --final yes-once.");
  process.exit(2);
}
const split = JSON.parse(readFileSync(`${HERE}/split.json`, "utf8"));
const ids = new Set(split[set]);
const only = args.only ? new Set(String(args.only).split(",")) : undefined;
if (typeof args.dataset !== "string") throw new Error("Pass --dataset <polybench_verified.jsonl>; evaluation data is not bundled with Ix");
const rows = readFileSync(args.dataset, "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => ids.has(r.instance_id) && (!only || only.has(r.instance_id)));
const MODULES = { impl: dist, picks };
const variantNames = String(args.variants ?? "base").split(",");
for (const v of variantNames) if (!VARIANTS[v] && !MODULES[v]) throw new Error(`unknown variant ${v}`);
const out = args.out ?? `${HERE}/results/${set}.jsonl`;
mkdirSync(dirname(out), { recursive: true });

const recall = (pred, gold) => gold.filter((g) => pred.includes(g)).length / gold.length;
const at = (list, gold) => [5, 10, 20].map((k) => recall(list.slice(0, k), gold));

const lines = [];
let done = 0;
for (const row of rows) {
  const t0 = Date.now();
  const repo = loadCorpus(row.repo, row.base_commit);
  const all = repo.files();
  const tracked = new Set(all);
  const source = all.filter(isSourcePath);
  const gold = goldFiles(row.patch).filter((p) => isSourcePath(p) && tracked.has(p));
  const loadMs = Date.now() - t0;
  if (gold.length === 0) {
    lines.push({ id: row.instance_id, lang: row.language, repo: row.repo, skipped: "no source gold at base" });
    continue;
  }
  const query = row.problem_statement;
  if (args.check) {
    const a = bm25Rank(repo, source, query).map((h) => h.path).slice(0, 50);
    const b = rank(repo, source, query, VARIANTS.base).map((h) => h.path).slice(0, 50);
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`base != bm25Rank on ${row.instance_id}`);
  }
  const search = args.plan ? defSearch(repo, source) : undefined;
  for (const v of variantNames) {
    const t1 = Date.now();
    const mod = MODULES[v];
    const hits = mod ? mod.bm25Rank(repo, all.filter(mod.isSourcePath), query) : rank(repo, source, query, VARIANTS[v]);
    const ms = Date.now() - t1;
    const ranked = hits.map((h) => h.path);
    const rec = { id: row.instance_id, lang: row.language, repo: row.repo, variant: v, gold, ms, loadMs,
      nfiles: source.length, bm25: at(ranked, gold), top: ranked.slice(0, 20) };
    if (search) {
      // Starting points depend on BM25 only through fileScore's tie-break.
      const scores = new Map(hits.map((h) => [h.path, h.score]));
      const lib = mod ?? { pickStartingPoints, rankIssueFiles };
      const { starts } = await lib.pickStartingPoints(query, { files: all, search, fileScore: (p) => scores.get(p) ?? 0 });
      const plannedFiles = lib.rankIssueFiles({ starts, bm25: hits, near: new Map() });
      const planned = plannedFiles.map((r) => r.path);
      rec.plan = at(planned, gold);
      rec.starts = starts.map((s) => s.path);
      // This offline study has lexical definitions, not a backend graph. Use
      // the production selector; graph-related precision needs agent traces.
      const page = selectContextItems(leanContextCandidates({ confidence: "high", startingPoints: starts,
        alsoRanked: plannedFiles, unresolved: [] }, { read: repo.read, issueQuery: query }));
      rec.contextPrecision = contextPrecisionComparison(planned, page.items, gold);
      rec.precise = at(page.items.map((item) => item.path), gold);
      rec.selection = page.selection;
    }
    lines.push(rec);
  }
  done++;
  process.stderr.write(`${done}/${rows.length} ${row.instance_id} files=${source.length} load=${loadMs}ms\n`);
}
writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.error(`wrote ${out}`);
