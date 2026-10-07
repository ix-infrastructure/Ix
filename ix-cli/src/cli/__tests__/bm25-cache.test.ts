// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bm25IndexPath, cachedBm25Ranker, readGitState, TOKENIZER_FINGERPRINT } from "../explain/bm25-cache.js";
import { bm25Rank, isSourcePath, MAX_BM25_BYTES } from "../explain/issue.js";
import { gitRepoAccess, type RepoAccess } from "../explain/text-references.js";

const QUERIES = [
  "The login page crashes when the password is empty; see `validatePassword`",
  "listByKind returns nothing for a scoped kind -- constructor toString hasOwnProperty",
  "session token refresh races the logout handler",
];

let dir: string;
let home: string;

function write(path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function git(...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf-8" });
}

/** A repo access that counts reads, so a test can tell a hit from a rebuild. */
function counting(repo: RepoAccess): RepoAccess & { reads: string[] } {
  const reads: string[] = [];
  return { ...repo, reads, read: (path) => { reads.push(path); return repo.read(path); } };
}

function sourceFiles(repo: RepoAccess) {
  return repo.files().filter(isSourcePath);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ix-bm25-cache-"));
  home = mkdtempSync(join(tmpdir(), "ix-bm25-home-"));
  process.env.IX_HOME = home;
  git("init", "-q");
  write("src/auth/login.ts", "export function validatePassword(p: string) { if (!p) throw new Error('empty password'); }\n");
  write("src/auth/session.ts", "export function refreshToken() {}\nexport function logout() { /* session token */ }\n");
  write("src/list.ts", "export function listByKind(kind: string) { return []; } // constructor toString\n");
  write("src/big.ts", `// ${"x".repeat(MAX_BM25_BYTES + 10)}\n`);
  write("src/util/strings.ts", "export const constructor = 1; export function hasOwnProperty() {}\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  delete process.env.IX_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("cachedBm25Ranker", () => {
  it("scores exactly as bm25Rank, building the index on the first call and reading it after", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    const rank = cachedBm25Ranker(dir);

    // Cold: builds and stores the index.
    for (const q of QUERIES) expect(rank(repo, files, q)).toEqual(bm25Rank(repo, files, q));
    expect(existsSync(bm25IndexPath(dir))).toBe(true);
    expect(bm25IndexPath(dir).startsWith(home)).toBe(true);

    // Warm: no file is read at all.
    const watched = counting(repo);
    for (const q of QUERIES) {
      expect(rank(watched, files, q)).toEqual(bm25Rank(repo, files, q));
    }
    expect(watched.reads).toEqual([]);
  });

  it("reads a file that differs from HEAD fresh, staged or not, and leaves the rest to the index", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    cachedBm25Ranker(dir)(repo, files, QUERIES[0]); // build at HEAD

    write("src/auth/session.ts", "export function logout() { validatePassword(''); password password }\n");
    write("src/list.ts", "export const nothing = 0;\n");
    git("add", "src/list.ts");

    const watched = counting(repo);
    const cached = cachedBm25Ranker(dir)(watched, files, QUERIES[0]);

    expect(cached).toEqual(bm25Rank(repo, files, QUERIES[0]));
    expect(watched.reads.sort()).toEqual(["src/auth/session.ts", "src/list.ts"]);
  });

  it("does not store a dirty file's text under HEAD", async () => {
    write("src/auth/login.ts", "export const changed = 'nothing about passwords';\n");
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    cachedBm25Ranker(dir)(repo, files, QUERIES[0]); // build while login.ts is dirty

    git("checkout", "--", "src/auth/login.ts"); // back to HEAD's text
    const cached = cachedBm25Ranker(dir)(repo, files, QUERIES[0]);

    expect(cached).toEqual(bm25Rank(repo, files, QUERIES[0]));
    expect(cached[0].path).toBe("src/auth/login.ts");
  });

  it("after a HEAD move, reads only the files whose blob changed", async () => {
    const repo = gitRepoAccess(dir)!;
    cachedBm25Ranker(dir)(repo, sourceFiles(repo), QUERIES[0]);

    write("src/auth/session.ts", "export function logout() { validatePassword(''); password }\n");
    write("src/auth/refresh.ts", "export function refreshSessionToken() { /* races logout */ }\n");
    git("add", ".");
    git("commit", "-q", "-m", "touch two files");
    const moved = gitRepoAccess(dir)!;
    const files = sourceFiles(moved);
    const watched = counting(moved);

    for (const q of QUERIES) {
      expect(cachedBm25Ranker(dir)(q === QUERIES[0] ? watched : moved, files, q)).toEqual(bm25Rank(moved, files, q));
    }
    expect(watched.reads.sort()).toEqual(["src/auth/refresh.ts", "src/auth/session.ts"]);
  });

  it("keys reuse on HEAD's blob, not a staged one the worktree has reverted", async () => {
    const original = readFileSync(join(dir, "src/list.ts"), "utf-8");
    const staged = "export function validatePassword() { password password password }\n";
    // Staged, then the worktree put back to HEAD's text: clean against HEAD,
    // but the index holds the staged blob.
    write("src/list.ts", staged);
    git("add", "src/list.ts");
    write("src/list.ts", original);
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    cachedBm25Ranker(dir)(repo, files, QUERIES[0]);

    // Commit what was staged, then bring the worktree up to it.
    git("commit", "-q", "-m", "commit the staged text");
    git("checkout", "--", "src/list.ts");
    const moved = gitRepoAccess(dir)!;

    expect(cachedBm25Ranker(dir)(moved, files, QUERIES[0])).toEqual(bm25Rank(moved, files, QUERIES[0]));
  });

  it("after a HEAD move that deletes and renames files, scores exactly as bm25Rank", async () => {
    const repo = gitRepoAccess(dir)!;
    cachedBm25Ranker(dir)(repo, sourceFiles(repo), QUERIES[0]);

    git("mv", "src/auth/login.ts", "src/auth/signin.ts");
    git("rm", "-q", "src/list.ts");
    git("commit", "-q", "-m", "rename and delete");
    const moved = gitRepoAccess(dir)!;
    const files = sourceFiles(moved);
    const watched = counting(moved);

    for (const q of QUERIES) {
      expect(cachedBm25Ranker(dir)(q === QUERIES[0] ? watched : moved, files, q)).toEqual(bm25Rank(moved, files, q));
    }
    expect(watched.reads).toEqual(["src/auth/signin.ts"]);
    const index = JSON.parse(readFileSync(bm25IndexPath(dir), "utf-8"));
    expect(index.paths).not.toContain("src/list.ts");
    expect(index.paths).not.toContain("src/auth/login.ts");
  });

  it("rebuilds when HEAD moves", async () => {
    const repo = gitRepoAccess(dir)!;
    cachedBm25Ranker(dir)(repo, sourceFiles(repo), QUERIES[2]);
    const before = JSON.parse(readFileSync(bm25IndexPath(dir), "utf-8")).head;

    write("src/auth/refresh.ts", "export function refreshSessionToken() { /* races logout */ }\n");
    git("add", ".");
    git("commit", "-q", "-m", "more");
    const moved = gitRepoAccess(dir)!;
    const files = sourceFiles(moved);

    expect(cachedBm25Ranker(dir)(moved, files, QUERIES[2])).toEqual(bm25Rank(moved, files, QUERIES[2]));
    expect(JSON.parse(readFileSync(bm25IndexPath(dir), "utf-8")).head).not.toBe(before);
  });

  it("rebuilds an index a different tokenizer built", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    cachedBm25Ranker(dir)(repo, files, QUERIES[0]);
    const path = bm25IndexPath(dir);
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    expect(stored.tok).toBe(TOKENIZER_FINGERPRINT);
    // As an older build would have left it: same HEAD, other tokens.
    writeFileSync(path, JSON.stringify({ ...stored, tok: "an-older-tokenizer", postings: {} }));

    const watched = counting(repo);
    expect(cachedBm25Ranker(dir)(watched, files, QUERIES[0])).toEqual(bm25Rank(repo, files, QUERIES[0]));
    expect(watched.reads.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path, "utf-8")).tok).toBe(TOKENIZER_FINGERPRINT);
  });

  it("keeps skipping a file too large to score without reading it again", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    const rank = cachedBm25Ranker(dir);
    rank(repo, files, QUERIES[1]);

    const watched = counting(repo);
    rank(watched, files, QUERIES[1]);

    expect(JSON.parse(readFileSync(bm25IndexPath(dir), "utf-8")).skipped).toEqual(["src/big.ts"]);
    expect(watched.reads).toEqual([]);
  });

  it("ignores an index from another version or root, a malformed one and a corrupt one", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    const rank = cachedBm25Ranker(dir);
    rank(repo, files, QUERIES[0]);
    const path = bm25IndexPath(dir);
    const good = JSON.parse(readFileSync(path, "utf-8"));

    for (const bad of [{ ...good, v: 0 }, { ...good, root: "/elsewhere" }, { ...good, blobs: [] }, "{not json"]) {
      writeFileSync(path, typeof bad === "string" ? bad : JSON.stringify(bad));
      const watched = counting(repo);
      expect(rank(watched, files, QUERIES[0])).toEqual(bm25Rank(repo, files, QUERIES[0]));
      expect(watched.reads.length).toBeGreaterThan(0);
    }
  });

  it("falls back to plain BM25 outside a git checkout", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    const rank = cachedBm25Ranker(dir, { state: () => undefined });

    expect(rank(repo, files, QUERIES[0])).toEqual(bm25Rank(repo, files, QUERIES[0]));
    expect(existsSync(bm25IndexPath(dir))).toBe(false);
  });
});

describe("readGitState", () => {
  it("lists paths relative to a subdirectory root, as git ls-files there does", () => {
    write("src/auth/login.ts", "changed\n");
    const sub = join(dir, "src");
    const state = readGitState(sub)!;
    expect([...state.dirty]).toEqual(["auth/login.ts"]);
    expect(gitRepoAccess(sub)!.files()).toContain("auth/login.ts");
  });

  it("is undefined before the first commit", () => {
    const empty = mkdtempSync(join(tmpdir(), "ix-bm25-empty-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: empty });
      expect(readGitState(empty)).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
