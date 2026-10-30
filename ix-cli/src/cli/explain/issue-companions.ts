// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import { posix } from "node:path";

import { combineSignals, currentRunSignal } from "../../client/run-signal.js";
import { coChangedFiles, type CoChange, type GitRunner } from "./history.js";
import { isSourcePath, MAX_RANKED_FILES, type RankedFile } from "./issue.js";
import type { RepoAccess } from "./text-references.js";

export const COMPANION_BUDGET_MS = 750;
export const MAX_COMPANION_SEEDS = 2;
export const MAX_COMPANIONS = 3;
export const MAX_COMPANION_READS = 24;
export const MAX_COMPANION_CANDIDATES = 12;
export const MAX_COMPANION_IMPORTS = 8;
const MAX_BYTES = 64 * 1024;
const CACHE_ENTRIES = 64;
const CACHE_TTL_MS = 30_000;
const historyCache = new Map<string, { at: number; files: CoChange[] }>();

export type CompanionSource = "co-change" | "re-export" | "issue-import";
export type CompanionHistory = (path: string, signal: AbortSignal) => Promise<CoChange[]>;

/** Request-scoped history reader; cache results by repository, HEAD and target. */
export function companionHistory(root: string): CompanionHistory {
  let head: Promise<string | undefined> | undefined;
  return async (path, signal) => {
    // A failed or timed-out git call reads as "no history": never cache that.
    let failed = false;
    const run: GitRunner = (args) => new Promise((resolve) => {
      execFile("git", ["--literal-pathspecs", "-c", "core.quotepath=false", ...args], {
        cwd: root, encoding: "utf8", timeout: COMPANION_BUDGET_MS, maxBuffer: 1024 * 1024,
        signal: combineSignals(signal, currentRunSignal()),
      }, (err, stdout) => {
        if (err) failed = true;
        resolve(err ? undefined : stdout);
      });
    });
    const revision = await (head ??= run(["rev-parse", "--verify", "HEAD"]));
    if (!revision || signal.aborted) return [];
    const key = JSON.stringify([root, revision.trim(), path]);
    const cached = historyCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.files;
    const files = await coChangedFiles(run, path, new Set(), MAX_COMPANION_CANDIDATES);
    if (!signal.aborted && !failed) {
      historyCache.delete(key);
      historyCache.set(key, { at: Date.now(), files });
      while (historyCache.size > CACHE_ENTRIES) historyCache.delete(historyCache.keys().next().value!);
    }
    return files;
  };
}

interface ImportRef {
  module: string;
  names: Array<{ imported: string; local: string }>;
  exported: boolean;
}

/** Small, bounded syntax probe. Unresolved packages/aliases are left alone. */
function imports(text: string, python: boolean): ImportRef[] {
  const refs: ImportRef[] = [];
  const pattern = python
    ? /^[ \t]*from\s+([.\w]+)\s+import\s+(\([^)]{0,2000}\)|[^\r\n;]+)/gm
    : /^[ \t]*(import|export)\s+(?:type\s+)?([^;"']{1,2000}?)\s+from\s*["']([^"'\r\n]+)["']/gm;
  for (const m of text.matchAll(pattern)) {
    if (refs.length >= MAX_COMPANION_IMPORTS) break;
    const clause = m[2].replace(/[{}()]/g, "");
    const names = clause.split(",").map((part) => {
      const [imported, local] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      return { imported, local: local ?? imported };
    }).filter((n) => /^(?:[\w$]+|\*)$/.test(n.imported));
    if (!python && m[1] === "import" && /^[\w$]/.test(m[2].trim())) {
      if (names[0]) names[0].imported = "default";
    }
    refs.push({ module: python ? m[1] : m[3], names, exported: python || m[1] === "export" });
  }
  return refs;
}

function moduleFile(from: string, module: string, tracked: ReadonlySet<string>): string | undefined {
  let base: string;
  if (from.endsWith(".py")) {
    const dots = module.match(/^\.+/)?.[0].length ?? 0;
    base = dots
      ? posix.join(posix.dirname(from), ...Array<string>(dots - 1).fill(".."), module.slice(dots).replace(/\./g, "/"))
      : module.replace(/\./g, "/");
    return [base + ".py", posix.join(base, "__init__.py")].find((p) => tracked.has(p));
  }
  if (!module.startsWith(".")) return undefined;
  base = posix.normalize(posix.join(posix.dirname(from), module));
  const stem = base.replace(/\.(?:mjs|cjs|js)$/, "");
  const variants = [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((ext) => stem + ext),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => posix.join(base, name))];
  return variants.find((p) => tracked.has(p));
}

function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Expand two leading hits without changing the primary ranker's contract.
 * The primary list (starting points, then BM25 follow-ups) is kept whole and
 * in order; at most three companions not already in it are appended after it.
 * All probes share one deadline and byte/read/candidate/name caps. Missing
 * history or unsupported syntax simply leaves the primary results intact.
 */
export async function expandIssueCompanions(
  issue: string,
  primary: RankedFile[],
  deps: { repo?: RepoAccess; history?: CompanionHistory; now?: () => number },
  limit = MAX_RANKED_FILES,
): Promise<RankedFile[]> {
  if (!deps.repo || primary.length === 0 || limit <= 1) return primary.slice(0, Math.max(0, limit));
  const repo = deps.repo;
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + COMPANION_BUDGET_MS;
  const controller = new AbortController();
  const signal = combineSignals(controller.signal, currentRunSignal())!;
  if (signal.aborted) return primary.slice(0, limit);
  const timer = setTimeout(() => controller.abort(), COMPANION_BUDGET_MS);
  let onAbort: () => void;
  const stopped = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const live = () => !signal.aborted && now() < deadline;
  const tracked = new Set<string>();
  for (const file of repo.files()) {
    if (!live()) break;
    if (isSourcePath(file)) tracked.add(file);
  }
  const seeds = primary.filter((f) => tracked.has(f.path)).slice(0, MAX_COMPANION_SEEDS);
  const seedPaths = new Set([primary[0].path, ...seeds.map((s) => s.path)]);
  const words = new Set(issue.slice(0, MAX_BYTES).match(/[A-Za-z_$][\w$]*/g) ?? []);
  const texts = new Map<string, string | undefined>();
  const read = (path: string): string | undefined => {
    if (!live() || !tracked.has(path)) return undefined;
    if (texts.has(path)) return texts.get(path);
    if (texts.size >= MAX_COMPANION_READS) return undefined;
    const text = repo.read(path);
    const bounded = text !== undefined && Buffer.byteLength(text) <= MAX_BYTES ? text : undefined;
    texts.set(path, bounded);
    return live() ? bounded : undefined;
  };
  const found = new Map<string, { path: string; source: CompanionSource; seed: string; weight: number }>();
  const credit = (path: string, source: CompanionSource, seed: string, weight: number) => {
    if (!live() || seedPaths.has(path) || !tracked.has(path)) return;
    const prior = found.get(path);
    if (!prior && found.size >= MAX_COMPANION_CANDIDATES) return;
    if (!prior || weight > prior.weight) found.set(path, { path, source, seed, weight });
  };
  const definition = (path: string, name: string, depth = 0): string | undefined => {
    const text = read(path);
    if (!text) return undefined;
    const declaration = name === "default" ? /\bexport\s+default\b/
      : new RegExp(`\\b(?:def|class|function|interface|type|enum|const|let|var)\\s+${escaped(name)}\\b|^\\s*${escaped(name)}\\s*(?::[^=\\n]+)?=`, "m");
    if (declaration.test(text)) return path;
    if (depth >= 2) return undefined;
    for (const ref of imports(text, path.endsWith(".py"))) {
      const imported = ref.names.find((n) => n.local === name || n.imported === "*");
      const target = imported && moduleFile(path, ref.module, tracked);
      if (target && ref.exported) {
        const result = definition(target, imported!.imported === "*" ? name : imported!.imported, depth + 1);
        if (result) return result;
      }
    }
    return undefined;
  };
  try {
    for (const seed of seeds) {
      if (!live()) break;
      const text = read(seed.path);
      const dir = posix.dirname(seed.path);
      let entries = 0;
      // Only sibling/parent package entry points, not a repository-wide grep.
      for (const file of tracked) {
        if (!live() || texts.size >= MAX_COMPANION_READS) break;
        const parent = posix.dirname(file);
        if (parent !== dir && parent !== posix.dirname(dir)) continue;
        if (!/^(?:__init__\.py|(?:index|registry|[\w]+_registry)\.(?:py|[cm]?[jt]sx?))$/.test(posix.basename(file))) continue;
        if (entries++ >= MAX_COMPANION_IMPORTS) break;
        const text = read(file);
        if (!text) continue;
        for (const ref of imports(text, file.endsWith(".py"))) {
          if (moduleFile(file, ref.module, tracked) !== seed.path) continue;
          if (ref.exported || ref.names.some((n) => new RegExp(`\\bexport\\b[\\s\\S]{0,2000}\\b${escaped(n.local)}\\b`).test(text))) {
            credit(file, "re-export", seed.path, 1);
          }
        }
      }
      let names = 0;
      for (const ref of imports(text ?? "", seed.path.endsWith(".py"))) {
        for (const name of ref.names) {
          if (names >= MAX_COMPANION_IMPORTS || !live()) break;
          // A default import is named in the issue only by its local binding:
          // the word "default" in prose is not a reference to it.
          if (!words.has(name.local) && (name.imported === "default" || !words.has(name.imported))) continue;
          names++;
          const target = moduleFile(seed.path, ref.module, tracked);
          const path = target && definition(target, name.imported);
          if (path) credit(path, "issue-import", seed.path, 0.9);
        }
      }
    }
    for (const seed of seeds) {
      if (!deps.history || !live()) break;
      // A provider that ignores cancellation still cannot delay this pass.
      const changes = await Promise.race([deps.history(seed.path, signal).catch(() => []), stopped]);
      for (const change of (changes ?? []).slice(0, MAX_COMPANION_CANDIDATES)) {
        credit(change.path, "co-change", seed.path, 0.8 * Math.min(1, Math.max(0, change.score)));
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal.removeEventListener("abort", onAbort!);
  }
  const primaryPaths = new Set(primary.map((f) => f.path));
  const companions: RankedFile[] = [...found.values()]
    .filter((c) => !primaryPaths.has(c.path))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))
    .slice(0, MAX_COMPANIONS)
    .map((c) => ({ path: c.path, score: Math.max(0, primary[0].score) * 0.8 * c.weight,
      reason: `companion (${c.source} of ${c.seed})`, companion: { source: c.source, seed: c.seed } }));
  return [...primary.slice(0, limit), ...companions];
}
