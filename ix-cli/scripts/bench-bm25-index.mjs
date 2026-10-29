#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

// Time and peak memory of the BM25 issue index (src/cli/explain/bm25-cache.ts)
// on a synthetic repository: cold (no index), warm (index at HEAD) and after a
// commit that changed one file. A measuring tool for a person, not a CI gate:
// timings on shared runners are too noisy to assert on.
//
//   npm run build && node scripts/bench-bm25-index.mjs [--files 19000] [--runs 5]
//                                                      [--keep DIR] [--cli-dist DIR]
//
// Each measurement is its own Node process, so its peak RSS is its own. The
// ranker time is what `ix context --from-issue` waits for before it can print;
// the save time is the index write that `saveBm25Index` does after it. Point
// --cli-dist at another build (with node_modules resolvable from it) to compare;
// a build without `saveBm25Index` writes inside the ranker. --keep reuses the
// tree across runs (it gains a commit per run).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const QUERIES = [
  "The login page crashes when the password is empty; see `validatePassword` in the session handler",
  "listByKind returns nothing for a scoped kind after the cache refresh, constructor toString",
  "Upload retries forever when the token expires: `refreshAccessToken` never resolves",
];

function parseArgs(argv) {
  const out = { files: 19000, runs: 5, keep: undefined, dist: resolve(here, "../dist") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--files") out.files = Math.max(10, parseInt(value, 10) || out.files);
    else if (flag === "--runs") out.runs = Math.max(1, parseInt(value, 10) || out.runs);
    else if (flag === "--keep") out.keep = resolve(value);
    else if (flag === "--cli-dist") out.dist = resolve(value);
    else if (flag === "-h" || flag === "--help") {
      process.stdout.write("usage: bench-bm25-index.mjs [--files N] [--runs N] [--keep DIR] [--cli-dist DIR]\n");
      process.exit(0);
    } else continue;
    i++;
  }
  return out;
}

/** A small deterministic PRNG, so every run builds the same tree. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = "ka lo mi ne su ta ri po va de fi gu ho ja ke le mo nu pa qi ra se ti vo wa xe yo zu ba ce".split(" ");

/** A vocabulary of made-up words, drawn Zipf-like so a few are everywhere and most are rare. */
function vocabulary(random, size) {
  const words = new Set();
  while (words.size < size) {
    let w = "";
    const n = 2 + Math.floor(random() * 3);
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    words.add(w);
  }
  return [...words];
}

function zipf(random, n) {
  // Inverse of a 1/x density over [1, n]: rank 1 most often.
  return Math.min(n - 1, Math.floor(Math.exp(random() * Math.log(n))) - 1);
}

function fileText(random, words, extra) {
  const lines = [];
  const fns = 2 + Math.floor(random() * 5);
  for (let f = 0; f < fns; f++) {
    const name = words[zipf(random, words.length)] + words[zipf(random, words.length)].replace(/^./, (c) => c.toUpperCase());
    lines.push(`export function ${name}(${words[zipf(random, words.length)]}: string) {`);
    const body = 2 + Math.floor(random() * 8);
    for (let b = 0; b < body; b++) {
      const parts = [];
      const k = 3 + Math.floor(random() * 8);
      for (let i = 0; i < k; i++) parts.push(words[zipf(random, words.length)]);
      lines.push(`  const ${parts[0]}_${parts[1]} = ${parts.slice(2).join("(")}${")".repeat(Math.max(0, parts.length - 3))}; // ${parts.join(" ")}`);
    }
    lines.push("}");
  }
  if (extra) lines.push(extra);
  return lines.join("\n") + "\n";
}

function git(dir, ...args) {
  return execFileSync("git", ["-c", "user.email=b@example.com", "-c", "user.name=b", ...args], {
    cwd: dir, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024,
  });
}

function makeTree(dir, count) {
  const random = rng(42);
  const words = vocabulary(random, 60_000);
  const plant = [
    "export function validatePassword(password: string) { /* login session */ }",
    "export function listByKind(kind: string) { /* scoped cache refresh */ }",
    "export async function refreshAccessToken(token: string) { /* upload retries */ }",
  ];
  for (let i = 0; i < count; i++) {
    const d = `src/m${i % 97}/p${Math.floor(i / 97) % 23}`;
    mkdirSync(join(dir, d), { recursive: true });
    const ext = ["ts", "py", "java", "go", "js"][i % 5];
    writeFileSync(join(dir, d, `${words[i % words.length]}${i}.${ext}`), fileText(random, words, i % 1000 === 0 ? plant[i % 3] : ""));
  }
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "synthetic tree");
}

/** One measurement, in this process: what the parent spawned us to do. */
async function child([dist, root, mode]) {
  const cache = await import(pathToFileURL(join(dist, "cli/explain/bm25-cache.js")).href);
  const { isSourcePath } = await import(pathToFileURL(join(dist, "cli/explain/issue.js")).href);
  const { gitRepoAccess } = await import(pathToFileURL(join(dist, "cli/explain/text-references.js")).href);
  const repo = gitRepoAccess(root);
  const files = repo.files().filter(isSourcePath);
  const deferred = typeof cache.saveBm25Index === "function";
  const rank = deferred ? cache.cachedBm25Ranker(root, { deferSave: true }) : cache.cachedBm25Ranker(root);
  const query = QUERIES[mode === "warm" ? 1 : 0];
  const t0 = performance.now();
  const hits = rank(repo, files, query);
  const t1 = performance.now();
  if (deferred) cache.saveBm25Index();
  const t2 = performance.now();
  process.stdout.write(JSON.stringify({
    rankMs: t1 - t0, saveMs: t2 - t1, rssMb: process.resourceUsage().maxRSS / 1024, hits: hits.length, top: hits[0]?.path,
  }) + "\n");
}

function runChild(opts, root, home, mode) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", opts.dist, root, mode], {
    env: { ...process.env, IX_HOME: home }, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`child ${mode} failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function indexBytes(home) {
  const dir = join(home, "cache");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.startsWith("bm25")).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
}

async function main() {
  if (process.argv[2] === "--child") return child(process.argv.slice(3));
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(join(opts.dist, "cli/explain/bm25-cache.js"))) {
    process.stderr.write(`No built CLI at ${opts.dist}: run \`npm run build\` first.\n`);
    process.exit(1);
  }
  const base = opts.keep ?? mkdtempSync(join(tmpdir(), "ix-bm25-bench-"));
  const root = join(base, "repo");
  const home = join(base, "home");
  try {
    if (!existsSync(join(root, ".git"))) {
      mkdirSync(root, { recursive: true });
      process.stderr.write(`building a ${opts.files}-file tree in ${root}...\n`);
      makeTree(root, opts.files);
    }
    const rows = { cold: [], warm: [], "1-file HEAD move": [] };
    for (let run = 0; run < opts.runs; run++) {
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home, { recursive: true });
      rows.cold.push(runChild(opts, root, home, "cold"));
      rows.warm.push(runChild(opts, root, home, "warm"));
      // One file changed and committed: the index is one HEAD behind.
      const victim = git(root, "ls-files", "-z").split("\0").filter(Boolean)[run * 31 + 7];
      writeFileSync(join(root, victim), `// touched ${run} validatePassword\n` + "export const x = 1;\n", { flag: "a" });
      git(root, "commit", "-q", "-am", `touch ${run}`);
      rows["1-file HEAD move"].push(runChild(opts, root, home, "moved"));
    }
    const out = [
      `files: ${opts.files}, runs: ${opts.runs}, index on disk: ${(indexBytes(home) / 1024 / 1024).toFixed(1)} MB`,
      "",
      "| case | ranker ms (median) | save ms (median) | peak RSS MB (max) |",
      "| --- | ---: | ---: | ---: |",
    ];
    for (const [name, rs] of Object.entries(rows)) {
      out.push(`| ${name} | ${median(rs.map((r) => r.rankMs)).toFixed(0)} | ${median(rs.map((r) => r.saveMs)).toFixed(0)} | ${Math.max(...rs.map((r) => r.rssMb)).toFixed(0)} |`);
    }
    process.stdout.write(out.join("\n") + "\n");
  } finally {
    if (!opts.keep) rmSync(base, { recursive: true, force: true });
  }
}

await main();
