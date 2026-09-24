// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";

import { isTestPath } from "./related-files.js";

/**
 * What git remembers about a context target's file.
 *
 * Bundles carried no history: the `provenance` row counts graph patch
 * revisions, not commits. On ix-bench's historical-bug tasks the clue was in
 * the log all along. The last commit to touch `resolve.ts` before the
 * `locate` exit-code fix is "fix(cli): fail unresolved graph commands
 * (#547)", which changed every sibling command but `locate`; the history of
 * `inventory.ts` holds "send --path as server-side scope (#229)", the same bug
 * fixed in the command next to the one the rank task asks about.
 *
 * Two things are read, both from the working tree's git, both best-effort:
 *
 *  - the target file's most recent commits (hash, date, subject);
 *  - files that changed together with it. A commit's weight is split across
 *    the files it touched, so a sweeping refactor says little about any one
 *    pair; commits touching more than `MAX_COMMIT_FILES` files count nothing,
 *    and a file must have changed with the target at least twice. On 253
 *    held-out co-change samples, mined strictly from history before each
 *    commit, the top three raised bundle recall from 0.701 to 0.764.
 */

export interface CommitRef {
  sha: string;
  date: string;
  subject: string;
}

export interface CoChange {
  path: string;
  /** Commits that changed both files. */
  commits: number;
  /** Sum over those commits of 1 / (files the commit touched). */
  score: number;
}

/** Runs `git <args>` in the repository and returns stdout, or undefined. */
export type GitRunner = (args: string[]) => string | undefined;

/** Newest commits shown, whatever they are. */
export const RECENT_COMMITS = 2;
/** Newest fixes shown besides them. */
export const RECENT_FIXES = 2;
/** Commits the newest ones and the fixes are chosen from. */
const RECENT_WINDOW = 10;
/** A conventional `fix:` / `fix(scope):`, or a subject that says fix, bug or revert. */
const FIX_SUBJECT = /^(?:fix|bugfix|hotfix|revert)\b|\b(?:fix(?:es|ed)?|bug|regression)\b/i;
export const MAX_CO_CHANGES = 3;
/** Commits of the target's file read for co-change. */
const HISTORY_DEPTH = 100;
/** A commit touching more files than this is a sweep, not a pairing. */
const MAX_COMMIT_FILES = 20;
/** Times a file must have changed with the target to count. */
const MIN_CO_CHANGES = 2;

/**
 * The newest commits to `path`, plus its newest fixes, newest first.
 *
 * The newest alone missed the clue on ix-bench's rank task: the fix to the
 * same bug in `inventory.ts` (#229) was that file's fifth commit, behind
 * three features. A fix is where a file's bug knowledge lives.
 */
export function recentCommits(git: GitRunner, path: string): CommitRef[] {
  const out = git(["log", `-${RECENT_WINDOW}`, "--format=%h%x09%ad%x09%s", "--date=short", "--", path]);
  if (!out) return [];
  const all = out.split("\n").filter(Boolean).map((line) => {
    const [sha, date, ...subject] = line.split("\t");
    return { sha, date, subject: subject.join("\t") };
  });
  const chosen = new Set([
    ...all.slice(0, RECENT_COMMITS),
    ...all.filter((c) => FIX_SUBJECT.test(c.subject)).slice(0, RECENT_FIXES),
  ]);
  return all.filter((c) => chosen.has(c));
}

export function coChangedFiles(
  git: GitRunner,
  path: string,
  exclude: ReadonlySet<string>,
  limit = MAX_CO_CHANGES,
): CoChange[] {
  // --full-diff lists every file each commit touched, not only `path`: one
  // call instead of one `git show` per commit.
  const out = git(["log", `-${HISTORY_DEPTH}`, "--format=@%h", "--name-only", "--full-diff", "--", path]);
  if (!out) return [];
  const targetIsTest = isTestPath(path);
  const tally = new Map<string, CoChange>();
  for (const block of out.split("@").slice(1)) {
    const files = [...new Set(block.split("\n").slice(1).map((l) => l.trim()).filter(Boolean))];
    if (files.length > MAX_COMMIT_FILES || !files.includes(path)) continue;
    for (const file of files) {
      if (file === path || exclude.has(file) || (!targetIsTest && isTestPath(file))) continue;
      const c = tally.get(file) ?? { path: file, commits: 0, score: 0 };
      c.commits += 1;
      c.score += 1 / files.length;
      tally.set(file, c);
    }
  }
  return [...tally.values()]
    .filter((c) => c.commits >= MIN_CO_CHANGES)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit);
}

/** `git` in `root`, or undefined when it fails (not a checkout, no history). */
export function gitRunner(root: string): GitRunner {
  return (args) => {
    try {
      return execFileSync("git", args, {
        cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return undefined;
    }
  };
}
