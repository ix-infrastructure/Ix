// Copyright 2026 Ix Infrastructure Inc.

/**
 * The on-disk check `ix context` runs before it suggests `ix read <name>
 * --path <file>`, and the workspace walk it shares with `ix read`.
 *
 * Kept out of commands/ so `ix context` does not load the read command module
 * (the fast path in register/oss-table.ts loads only the command it runs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { absoluteFromSourceUri, isReadablePath } from "./config.js";
import { bareName, countDeclarations } from "./edge-sites.js";
import { readBoundedFile } from "./bounded-read.js";

/** Directories a workspace walk must not descend into. Mirrors stale.ts. */
export const WALK_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next",
  ".cache", "__pycache__", ".ix", ".claude",
]);

/** How many directory entries a single basename lookup will look at. */
export const WALK_ENTRY_BUDGET = 40_000;

/** Whether a file named `entryName` is one `read` would open for `target`. */
export function basenameMatcher(target: string): (entryName: string) => boolean {
  const wanted = path.basename(target);
  const wantedNoExt = wanted.replace(/\.[^.]+$/, "");
  return (entryName) => {
    const nameNoExt = entryName.replace(/\.[^.]+$/, "");
    return entryName === wanted || nameNoExt === wanted || nameNoExt === wantedNoExt;
  };
}

/** The workspace's files, from one walk; `exhaustive` is false when it ran out of budget. */
export interface WorkspaceFiles {
  paths: string[];
  exhaustive: boolean;
}

/**
 * Every file under `root`, by the walk `findLocalBasenameMatches` makes (same
 * ignored directories, same entry budget, symlinks not followed). Listed once
 * so one bundle's symbol suggestions share a single walk instead of one each.
 */
export function listWorkspaceFiles(root: string): WorkspaceFiles {
  const paths: string[] = [];
  const stack = [root];
  let budget = WALK_ENTRY_BUDGET;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (--budget <= 0) return { paths, exhaustive: false };
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || WALK_IGNORE_DIRS.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      paths.push(path.join(current, entry.name));
    }
  }
  return { paths, exhaustive: true };
}

/**
 * Whether `a` and `b` name the same file. Resolved first, and compared without
 * case on Windows, where `C:\Repo\x.ts` and `c:/repo/x.ts` are one file: a
 * plain `!==` there made a file collide with itself, so the symbol form was
 * never suggested.
 */
export function sameFsPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
  }
  return path.posix.resolve(a) === path.posix.resolve(b);
}

/**
 * Whether the workspace holds a file that would turn `ix read <name> --path
 * <file>` away from the `name` declared in `file` (at `abs`):
 *
 * - a file named `name`: Step 3 above opens it before any symbol lookup, and
 *   --path does not stop it;
 * - another file whose path contains `file`: --path is a substring test on the
 *   graph's source path (resolve.ts), so `src/util.ts` also keeps
 *   `lib/src/util.ts` and `src/util.tsx`, and a `name` declared there too
 *   leaves the lookup to return candidates or the wrong one.
 *
 * Says yes when the walk ran out of budget, since then neither is ruled out.
 * Files outside the workspace (another repo in the same system) are not seen.
 */
function suggestionCollides(files: WorkspaceFiles, name: string, abs: string, file: string): boolean {
  if (!files.exhaustive) return true;
  const named = basenameMatcher(name);
  const needle = file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  for (const other of files.paths) {
    if (named(path.basename(other))) return true;
    if (other.replace(/\\/g, "/").toLowerCase().includes(needle) && !sameFsPath(other, abs)) return true;
  }
  return false;
}

/** Past this a file is not read just to vet a suggestion; the range form stands. */
const SUGGEST_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * A superset of what ingest's role classifier (core-ingestion
 * role-classifier.ts) calls test or fixture: any one signal counts here, where
 * the classifier weighs them. Too broad only costs a symbol suggestion.
 */
const TEST_LIKE_DIR = /(?:^|\/)(?:__tests__|__fixtures__|tests?|specs?|fixtures?|testdata|[^/]*\.tests?)(?:\/)/i;
const TEST_LIKE_FILE = /(?:^|[._-])(?:tests?|spec|fixtures?|mocks?|stubs?|fakes?|samples?|conftest)(?:[._-]|$)/i;
/** Case-sensitive, as in the classifier: `FooTest.java`, `FakeClock.java`, but not `latest.ts`. */
const TEST_LIKE_CLASS_FILE = /(?:Tests?|Spec)\.[^.]+$|^(?:Stub|Fake|Mock)[A-Z]/;
const TEST_LIKE_IMPORT = new RegExp([
  /from ['"](?:jest|vitest|mocha|chai|sinon|jasmine|@testing-library)/.source,
  /require\(['"](?:jest|vitest|mocha|chai|sinon|jasmine)['"]\)/.source,
  /(?:import|from)\s+(?:unittest|pytest)/.source,
  /import\s+(?:org\.junit|org\.testng|io\.mockk|org\.mockito|org\.scalatest|munit|zio\.test)/.source,
  /require\s+['"](?:rspec|minitest)['"]/.source,
  /using\s+(?:NUnit\.Framework|Xunit|Microsoft\.VisualStudio\.TestTools\.UnitTesting)/.source,
  /^import\s*(?:\([^)]*"testing"|"testing")/.source,
].join("|"), "m");

/** Whether ingest may have filed `file` as a test or a fixture. */
function mayBeTestOrFixture(file: string, source: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return TEST_LIKE_DIR.test(normalized)
    || TEST_LIKE_FILE.test(path.posix.basename(normalized))
    || TEST_LIKE_CLASS_FILE.test(path.posix.basename(normalized))
    || TEST_LIKE_IMPORT.test(source);
}

/**
 * Whether `ix read <name> --path <file>` would show the one declaration of
 * `name` in `file`, so `ix context` may suggest it instead of a line range.
 *
 * No when `file` resolves outside every readable workspace root (`ix read`
 * would refuse it, and a `..` in a graph path must not make this open it).
 * No when a workspace file has `name` as its basename, or another workspace
 * file's path contains `file` (see `suggestionCollides`). No unless the
 * file on disk declares `name` exactly once: two (`save` in two classes) leave
 * the lookup to return candidates or the other one, and none leaves the stale
 * re-anchor nothing to find. A bundle's entities are only the target's graph
 * neighbours, so they cannot answer this; the file can. No for a test or
 * fixture file: the resolver drops test and fixture symbols whenever a
 * production one shares the name, before --path is applied, so the read finds
 * nothing and exits 1. Unreadable, missing or oversized files say no.
 *
 * One-off; a caller vetting several rows should use `symbolReadChecker`, which
 * walks the workspace once for all of them.
 */
export function readsOneSymbol(root: string, name: string, file: string): boolean {
  return symbolReadChecker(root)(name, file);
}

/**
 * `readsOneSymbol` for many rows against one workspace: the workspace is
 * walked at most once (lazily, only when a row gets past the per-file checks),
 * and each (name, file) is answered once, so calling it again — from a
 * budget-fitting loop that re-renders the same bundle — costs a map lookup.
 * `listFiles` is injectable for tests.
 */
export function symbolReadChecker(
  root: string,
  listFiles: (root: string) => WorkspaceFiles = listWorkspaceFiles,
): (name: string, file: string) => boolean {
  let files: WorkspaceFiles | undefined;
  const answers = new Map<string, boolean>();
  const check = (name: string, file: string): boolean => {
    const abs = absoluteFromSourceUri(file, root);
    if (!isReadablePath(abs, root)) return false;
    // One open, fstat and read on the same handle (CodeQL js/file-system-race).
    const text = readBoundedFile(abs, { maxBytes: SUGGEST_MAX_FILE_BYTES });
    if (text === null) return false;
    if (mayBeTestOrFixture(file, text)) return false;
    if (countDeclarations(text.split("\n"), bareName(name)) !== 1) return false;
    // Last: the file read above is cheaper than the walk of the workspace.
    files ??= listFiles(root);
    return !suggestionCollides(files, name, abs, file);
  };
  return (name, file) => {
    const key = `${name}\n${file}`;
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = check(name, file);
      answers.set(key, answer);
    }
    return answer;
  };
}
