// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { combineSignals, currentRunSignal } from "../client/run-signal.js";
import { ingestSymbolsPath } from "./config.js";
import type { CommitRef } from "./explain/history.js";

export const HISTORY_DEFAULTS = {
  maxCommits: 2000,
  maxFiles: 50,
  maxMonths: 12,
  minSupport: 3,
  minConfidence: 0.3,
  maxEdges: 20,
  maxFixes: 3,
  symbolFiles: 200,
  budgetMs: 30_000,
} as const;
const FIX = /\b(?:fix(?:es|ed)?|bug(?:fix)?|regression|hotfix)\b|#\d+/i;
const SWEEP =
  /^(?:style|format)(?:\([^)]*\))?:|^(?:chore(?:\([^)]*\))?:\s*)?(?:format(?:ting)?|reformat)\b|\b(?:prettier|clang-format|rustfmt|gofmt|dependabot|renovate)\b|\[[^\]]*bot\]/i;
const OMIT =
  /(?:^|\/)(?:vendor|vendored|third_party|third-party|node_modules|dist|build|generated|__generated__|\.git)(?:\/|$)|(?:\.min\.[cm]?js|\.(?:generated|g|pb)\.[^/]+|_pb2\.py|\.lock(?:b|file)?|lock\.json|lock\.yaml|lock\.yml)$|(?:^|\/)(?:go\.sum|npm-shrinkwrap\.json|\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx)|id_rsa|credentials(?:\.[^/]*)?)$/i;

export interface HistoryEntity {
  path: string;
  name?: string;
  key?: string;
  id?: string;
}
interface HistoryCommit extends CommitRef {
  fullSha: string;
  entities: HistoryEntity[];
}
export interface HistoryState {
  version: 1;
  head: string;
  commits: HistoryCommit[];
  mined: number;
  window: number;
  symbolFiles: number;
  symbolSkipped: number;
  index?: CouplingIndex;
  edgeIds?: string[];
  patchId?: string;
  workspaceId?: string;
}
export interface CouplingEdge {
  source: string;
  target: string;
  support: number;
  confidence: number;
  lastCoChange: string;
}
export interface CouplingIndex {
  head: string;
  entities: Record<string, HistoryEntity>;
  edges: CouplingEdge[];
  fixes: Record<string, CommitRef[]>;
}
interface Parsed {
  entities: Array<{
    name: string;
    kind: string;
    container?: string;
    lineStart: number;
    lineEnd: number;
  }>;
}
export interface HistoryOptions {
  maxCommits?: number;
  now?: Date;
  signal?: AbortSignal;
  budgetMs?: number;
  symbolFiles?: number;
  parseFile?: (path: string, source: string) => Parsed | null;
  /** Offline evaluation at a base commit; normal ingestion always uses HEAD. */
  revision?: string;
}
export const historyKey = (e: HistoryEntity): string =>
  JSON.stringify(e.key === undefined ? [e.path] : [e.path, e.key]);
export const historyCachePath = (root: string): string => `${ingestSymbolsPath(root)}.history`;

/** Bounded subprocesses share one deadline; failure never advances the cursor. */
export async function mineHistory(
  root: string,
  previous?: HistoryState,
  opts: HistoryOptions = {},
): Promise<HistoryState | undefined> {
  const signal = combineSignals(
    combineSignals(opts.signal, currentRunSignal()),
    AbortSignal.timeout(opts.budgetMs ?? HISTORY_DEFAULTS.budgetMs),
  );
  const maxCommits = Math.max(
    1,
    Math.min(opts.maxCommits ?? HISTORY_DEFAULTS.maxCommits, HISTORY_DEFAULTS.maxCommits),
  );
  if (previous?.window !== maxCommits) previous = undefined;
  const git = (args: string[], maxBuffer = 16 * 1024 * 1024, input?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        ["--literal-pathspecs", "-c", "core.quotepath=false", ...args],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer,
          signal,
          timeout: 5000,
        },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
      if (input !== undefined) {
        child.stdin?.on("error", reject);
        child.stdin?.end(input);
      }
    });
  let head: string;
  try {
    head = (
      await git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${opts.revision ?? "HEAD"}^{commit}`,
      ])
    ).trim();
  } catch (err) {
    if (signal?.aborted) throw err;
    // A non-repository or unborn branch has no history.
    return undefined;
  }
  if (previous) {
    try {
      await git(["merge-base", "--is-ancestor", previous.head, head]);
    } catch {
      if (signal?.aborted) throw new Error("Git history deadline exceeded");
      previous = undefined;
    }
  }
  const now = opts.now ?? new Date();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - HISTORY_DEFAULTS.maxMonths);
  // A merge can introduce older side-branch commits. Read only the bounded
  // window's IDs to retain git's order; metadata/hunks below are new commits only.
  const windowIds = (
    await git([
      "log",
      head,
      `--max-count=${maxCommits}`,
      `--since=${cutoff.toISOString()}`,
      "--no-merges",
      "--format=%H",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const inWindow = new Set(windowIds);
  // NUL separates fields; a double NUL starts each record. Git paths cannot
  // contain NUL, including paths containing tabs, newlines or "@".
  const prefix = (await git(["rev-parse", "--show-prefix"])).trim();
  const log = await git([
    "log",
    head,
    ...(previous ? [`^${previous.head}`] : []),
    `--max-count=${maxCommits}`,
    `--since=${cutoff.toISOString()}`,
    "--no-merges",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--format=%x00%x00%H%x00%cs%x00%s",
    "--name-only",
    "--relative",
    "-z",
  ]);
  const raw = log
    .split(/\0\0+/)
    .filter(Boolean)
    .map((block) => {
      const [fullSha, date, subject, ...names] = block.split("\0");
      if (!/^[a-f0-9]{40,64}$/.test(fullSha) || !date || subject === undefined)
        throw new Error("Incomplete git history record");
      const files = names.map((p, i) => (i === 0 ? p.replace(/^\n/, "") : p)).filter(Boolean);
      return { fullSha, date, subject, files };
    })
    .filter((c) => inWindow.has(c.fullSha));
  // Attributes depend on the path, not the commit: probe each unique path once,
  // in bounded stdin batches rather than spawning git for every commit.
  const attributePaths = [
    ...new Set(
      raw
        .filter((c) => c.files.length <= HISTORY_DEFAULTS.maxFiles && !SWEEP.test(c.subject))
        .flatMap((c) => c.files.filter((p) => !OMIT.test(p))),
    ),
  ];
  const denied = new Set<string>();
  for (let offset = 0; offset < attributePaths.length; offset += 1024) {
    const attrs = await git(
      ["check-attr", "-z", "--stdin", "linguist-generated", "linguist-vendored"],
      16 * 1024 * 1024,
      attributePaths.slice(offset, offset + 1024).join("\0") + "\0",
    );
    const fields = attrs.split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (!["unspecified", "unset", "false"].includes(fields[i + 2])) denied.add(fields[i]);
    }
  }
  const records: HistoryCommit[] = [];
  let symbolFiles = 0,
    symbolSkipped = 0;
  for (const { fullSha, date, subject, files } of raw) {
    signal?.throwIfAborted();
    const entities: HistoryEntity[] = [];
    let symbolCount = 0;
    if (files.length <= HISTORY_DEFAULTS.maxFiles && !SWEEP.test(subject)) {
      for (const path of files.filter((p) => !OMIT.test(p) && !denied.has(p))) {
        entities.push({ path });
        if (!opts.parseFile) continue;
        if (
          symbolFiles >= (opts.symbolFiles ?? HISTORY_DEFAULTS.symbolFiles) ||
          symbolCount >= 250
        ) {
          symbolSkipped++;
          continue;
        }
        symbolFiles++;
        // Only post-image hunks can be assigned reliably. Deletions and binary
        // changes still count at file level. No diff or blob is persisted.
        let source: string;
        try {
          source = await git(["show", `${fullSha}:${prefix}${path}`], 200 * 1024);
        } catch {
          if (signal?.aborted) throw new Error("Git history deadline exceeded");
          symbolSkipped++;
          continue;
        }
        let parsed: Parsed | null;
        try {
          parsed = opts.parseFile(path, source);
        } catch {
          symbolSkipped++;
          continue;
        }
        if (!parsed) continue;
        let diff: string;
        try {
          diff = await git(
            [
              "diff-tree",
              "--root",
              "--no-commit-id",
              "-r",
              "-p",
              "--unified=0",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              fullSha,
              "--",
              path,
            ],
            1024 * 1024,
          );
        } catch {
          if (signal?.aborted) throw new Error("Git history deadline exceeded");
          symbolSkipped++;
          continue;
        }
        const ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
          .map((m) => ({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) }))
          .filter((r) => r.count > 0);
        const symbols = parsed.entities.filter(
          (e) => !["file", "module", "import", "chunk"].includes(e.kind),
        );
        for (const e of symbols.slice(0, 250)) {
          if (symbolCount >= 250) break;
          if (!ranges.some((r) => e.lineStart <= r.start + r.count - 1 && e.lineEnd >= r.start))
            continue;
          // A hunk inside a method belongs to the method, not also its class.
          if (
            !ranges.some(
              (r) =>
                e.lineStart <= r.start + r.count - 1 &&
                e.lineEnd >= r.start &&
                !symbols.some(
                  (child) =>
                    child !== e &&
                    child.lineStart >= e.lineStart &&
                    child.lineEnd <= e.lineEnd &&
                    child.lineEnd - child.lineStart < e.lineEnd - e.lineStart &&
                    child.lineStart <= r.start &&
                    child.lineEnd >= r.start + r.count - 1,
                ),
            )
          )
            continue;
          entities.push({
            path,
            name: e.name,
            key: e.container ? `${e.container}.${e.name}` : e.name,
          });
          symbolCount++;
        }
      }
    }
    records.push({
      fullSha,
      sha: fullSha.slice(0, 12),
      date,
      subject,
      entities: [...new Map(entities.map((e) => [historyKey(e), e])).values()],
    });
  }
  const bySha = new Map([...(previous?.commits ?? []), ...records].map((c) => [c.fullSha, c]));
  const commits = windowIds
    .map((sha) => bySha.get(sha))
    .filter((c): c is HistoryCommit => c !== undefined);
  return {
    version: 1,
    head,
    commits,
    window: maxCommits,
    mined: records.length,
    symbolFiles,
    symbolSkipped,
  };
}

/** Directed confidence uses every eligible source commit, including solo edits. */
export function couplingIndex(
  state: HistoryState,
  signal?: AbortSignal,
  eligible: (entity: HistoryEntity) => boolean = () => true,
): CouplingIndex {
  const entities: CouplingIndex["entities"] = Object.create(null);
  const fixes: CouplingIndex["fixes"] = Object.create(null);
  const touches = new Map<string, Array<{ keys: string[]; date: string }>>();
  for (const commit of state.commits) {
    const present = commit.entities.filter(eligible);
    const keys = [...new Set(present.map(historyKey))];
    for (const e of present) entities[historyKey(e)] = e;
    const files = keys.filter((k) => entities[k].key === undefined);
    const symbols = keys.filter((k) => entities[k].key !== undefined);
    for (const source of keys) {
      const list = touches.get(source) ?? [];
      touches.set(source, list);
      list.push({ keys: entities[source].key === undefined ? files : symbols, date: commit.date });
      if (FIX.test(commit.subject)) {
        const list = (fixes[source] ??= []);
        if (list.length < HISTORY_DEFAULTS.maxFixes)
          list.push({ sha: commit.sha, date: commit.date, subject: commit.subject });
      }
    }
  }
  const edges: CouplingEdge[] = [];
  // Tally one source at a time: 2,000 disjoint 50-file commits must not leave
  // millions of below-threshold pair objects resident in memory together.
  for (const [source, commits] of touches) {
    signal?.throwIfAborted();
    if (commits.length < HISTORY_DEFAULTS.minSupport) continue;
    const targets = new Map<string, { support: number; lastCoChange: string }>();
    for (const { keys, date } of commits)
      for (const target of keys) {
        if (source === target) continue;
        const pair = targets.get(target) ?? { support: 0, lastCoChange: date };
        pair.support++;
        pair.lastCoChange = pair.lastCoChange > date ? pair.lastCoChange : date;
        targets.set(target, pair);
      }
    edges.push(
      ...[...targets]
        .map(([target, attrs]) => ({
          source,
          target,
          ...attrs,
          confidence: attrs.support / commits.length,
        }))
        .filter(
          (e) =>
            e.support >= HISTORY_DEFAULTS.minSupport &&
            e.confidence >= HISTORY_DEFAULTS.minConfidence,
        )
        .sort(
          (a, b) =>
            b.confidence - a.confidence ||
            b.support - a.support ||
            a.target.localeCompare(b.target),
        )
        .slice(0, HISTORY_DEFAULTS.maxEdges),
    );
  }
  return { head: state.head, entities, edges, fixes };
}

export function coupledFor(
  index: CouplingIndex,
  target: HistoryEntity,
  limit: number = HISTORY_DEFAULTS.maxEdges,
) {
  const key = target.id
    ? Object.keys(index.entities).find((k) => index.entities[k].id === target.id)
    : target.key !== undefined
      ? historyKey(target)
      : target.name
        ? Object.keys(index.entities).find(
            (k) => index.entities[k].path === target.path && index.entities[k].name === target.name,
          )
        : historyKey(target);
  return {
    minedHead: index.head,
    partners: index.edges
      .filter((e) => e.source === key)
      .slice(0, limit)
      .map((e) => ({
        ...index.entities[e.target],
        support: e.support,
        confidence: e.confidence,
        lastCoChange: e.lastCoChange,
      })),
    recentFixes: key ? (index.fixes[key] ?? []) : [],
  };
}

export function loadHistory(root: string): HistoryState | undefined {
  try {
    const state = JSON.parse(readFileSync(historyCachePath(root), "utf8")) as HistoryState;
    return state.version === 1 &&
      /^[a-f0-9]{40,64}$/.test(state.head) &&
      Array.isArray(state.commits)
      ? state
      : undefined;
  } catch {
    return undefined;
  }
}
export function saveHistory(root: string, state: HistoryState): void {
  const path = historyCachePath(root),
    temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, path);
}
export function historyId(value: string): string {
  const h = createHash("sha256").update(value).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join(
    "-",
  );
}
export const couplingEdgeId = (source: string, target: string): string =>
  historyId(`CO_CHANGES:${source}:${target}`);

export function readCoupling(root: string): CouplingIndex | undefined {
  return loadHistory(root)?.index;
}
