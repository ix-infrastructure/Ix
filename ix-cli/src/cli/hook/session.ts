// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * What the post-edit hook knows without the graph: the working tree's diff
 * against HEAD, and what it already told this session.
 *
 * Agents do not only edit with Edit and Write. In benchmark runs they rewrote
 * files with `python3 - <<EOF` through Bash just as often, and a hook keyed on
 * the edit tools never fired. The diff sees every editing path. It also says
 * where each edit is in the base commit -- the hunk's old side -- which is the
 * text the graph indexed.
 *
 * Builtins only: this runs on every hooked tool call, and the common answer is
 * "nothing new", which must cost a git call, not the CLI's module graph.
 */

/** 1-based inclusive range on the old side of a hunk; `insertion` marks a pure insertion point. */
export interface OldRange {
  start: number;
  end: number;
  insertion?: boolean;
}

export interface FileDiff {
  /** Repository-relative path in the base commit; undefined for a new file. */
  oldPath?: string;
  /** Repository-relative path in the working tree; undefined for a deleted file. */
  newPath?: string;
  /** Where the edits are, in the base commit's file. */
  oldRanges: OldRange[];
}

const GIT_TIMEOUT_MS = 2000;

/**
 * A path with its symlinks -- and, on Windows, its 8.3 short names -- resolved,
 * as far as it exists: a deleted file takes its directory's spelling.
 *
 * git names the repository's top level this way, while `--worktree`,
 * `--graph-root`, a registered workspace and a tool's `file_path` come as
 * someone typed them. Compared as given, a checkout reached through a link
 * (macOS's temp directory, for one) puts every edited file "outside" the
 * workspace, and the hook says nothing.
 */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try { return fs.realpathSync.native(resolved); } catch { /* does not exist: resolve what does */ }
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(canonicalPath(parent), path.basename(resolved));
}

// This runs from session hooks in whatever checkout the agent is in. Reading
// the index (diff HEAD) runs a core.fsmonitor command the repository's own
// config names; never let it.
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** The repository's top level, or undefined outside one. */
export function gitTopLevel(dir: string): string | undefined {
  try {
    const out = git(dir, ["rev-parse", "--show-toplevel"]).trim();
    return out ? canonicalPath(out) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tracked changes against HEAD, with no context lines. Untracked files are
 * not in it, and need not be: a file that is new has no graph facts.
 */
export function gitDiffHead(repoRoot: string): string {
  // The prefixes are spelled out because the user's config can change them:
  // `diff.mnemonicPrefix` writes `c/` and `w/`, `diff.noprefix` none, and
  // `parseUnifiedDiff` strips `a/` and `b/`. --no-textconv: a textconv driver
  // is a command from the repository's config, and the line numbers wanted
  // here are the file's own, not a converted rendering's.
  return git(repoRoot, [
    "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--",
  ]);
}

/** A file's content in HEAD, or undefined when HEAD has no such file. */
export function gitShowHead(repoRoot: string, repoPath: string): string | undefined {
  try {
    return git(repoRoot, ["show", `HEAD:${repoPath}`]);
  } catch {
    return undefined;
  }
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92 };

/**
 * A path as git quotes it when it holds unusual characters: C escapes, and
 * every byte of a non-ASCII name in octal (`"a/sp\303\251cial.ts"`) unless
 * `core.quotePath` is off. The octal bytes are UTF-8, so they are collected
 * as bytes and decoded together; JSON.parse cannot read them.
 */
function unquoteGitPath(p: string): string {
  if (!(p.length >= 2 && p.startsWith("\"") && p.endsWith("\""))) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\" || i + 1 >= body.length) {
      bytes.push(...Buffer.from(ch, "utf-8"));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const esc = C_ESCAPES[body[i + 1]];
    if (esc !== undefined) { bytes.push(esc); i += 1; continue; }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString("utf-8");
}

function diffPath(raw: string, prefix: "a/" | "b/"): string | undefined {
  const p = unquoteGitPath(raw.trim());
  if (p === "/dev/null") return undefined;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * The files of a `git diff -U0` and, for each, where its hunks sit on the old
 * side. A hunk `-a,b +c,d` with `b > 0` replaced or removed old lines
 * `a..a+b-1`; with `b == 0` it inserted after old line `a`, between `a` and
 * `a+1`.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  // Inside a file's hunks, a removed line `-- x` reads `--- x` and an added
  // `++ x` reads `+++ x`: the `---` / `+++` headers only come before them.
  let inHunks = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { oldRanges: [] };
      files.push(cur);
      inHunks = false;
    } else if (!cur) {
      continue;
    } else if (!inHunks && line.startsWith("--- ")) {
      cur.oldPath = diffPath(line.slice(4), "a/");
    } else if (!inHunks && line.startsWith("+++ ")) {
      cur.newPath = diffPath(line.slice(4), "b/");
    } else if (line.startsWith("@@")) {
      inHunks = true;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) cur.oldRanges.push({ start, end: start + count - 1 });
      else cur.oldRanges.push({ start: Math.max(1, start), end: start + 1, insertion: true });
    }
  }
  return files.filter((f) => f.oldRanges.length > 0);
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// ── Per-session state ───────────────────────────────────────────────────────

export interface HookState {
  /** The diff last fully reported on. The same diff again has nothing new in it. */
  fingerprint?: string;
  /** `path#id` of every symbol this session was already told about. */
  reported: string[];
}

/** A session's file is dropped this long after the hook last wrote it. */
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One file per (session, worktree), under IX_HOOK_STATE_DIR or
 * `<IX_HOME>/hook-state`. The worktree is keyed by its canonical path, so one
 * checkout is one memory however it was reached.
 *
 * Not the OS temp directory: that is shared, the names here are predictable,
 * and another user could plant a link where the hook is about to write.
 */
export function statePath(sessionId: string | undefined, worktree: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.IX_HOOK_STATE_DIR || path.join(env.IX_HOME || path.join(os.homedir(), ".ix"), "hook-state");
  const key = fingerprint(`${sessionId ?? "no-session"}\0${canonicalPath(worktree)}`).slice(0, 24);
  return path.join(dir, `${key}.json`);
}

/**
 * Sessions end without telling the hook, and nothing else cleans this
 * directory: drop what has not been written for a week. The age is read off a
 * descriptor, and a file removed just as its session came back only makes the
 * hook repeat itself once.
 */
export function pruneStates(dir: string, now = Date.now()): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
    const file = path.join(dir, name);
    try {
      const fd = fs.openSync(file, "r");
      let stale: boolean;
      try { stale = now - fs.fstatSync(fd).mtimeMs > STATE_MAX_AGE_MS; } finally { fs.closeSync(fd); }
      if (stale) fs.unlinkSync(file);
    } catch { /* gone already, or not ours to remove */ }
  }
}

export function loadState(file: string): HookState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<HookState>;
    return {
      fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined,
      reported: Array.isArray(parsed.reported) ? parsed.reported.filter((r): r is string => typeof r === "string") : [],
    };
  } catch {
    return { reported: [] };
  }
}

/** Written whole and renamed into place, so a concurrent reader never sees half a file. */
export function saveState(file: string, state: HookState): void {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
    pruneStates(dir);
  } catch { /* a hook that cannot remember only repeats itself */ }
}

export function symbolKey(relPath: string, id: string): string {
  return `${relPath}#${id}`;
}
