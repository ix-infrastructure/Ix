// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bm25IndexPath,
  cachedBm25Ranker,
  readGitState,
  saveBm25Index,
  TOKENIZER_FINGERPRINT,
} from "../explain/bm25-cache.js";
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

/** The stored index's header and lists: an 8-byte magic, the header's length, its JSON, then the sections. */
function readStored(path = bm25IndexPath(dir)) {
  const buf = readFileSync(path);
  const length = buf.readUInt32LE(8);
  const header = JSON.parse(buf.subarray(12, 12 + length).toString("utf8"));
  const base = 12 + length;
  const list = (name: string): string[] => {
    const [offset, size] = header.at[name];
    const text = buf.subarray(base + offset, base + offset + size).toString("utf8");
    return text ? text.split("\0") : [];
  };
  return { header, paths: list("paths"), skipped: list("skipped"), buf, base };
}

/** Rewrites the stored header, as another build or another root would have left it. */
function rewriteHeader(change: (header: Record<string, unknown>) => Record<string, unknown>, path = bm25IndexPath(dir)) {
  const { header, buf, base } = readStored(path);
  const json = Buffer.from(JSON.stringify(change(header)), "utf8");
  const prefix = Buffer.alloc(12);
  buf.copy(prefix, 0, 0, 8);
  prefix.writeUInt32LE(json.length, 8);
  writeFileSync(path, Buffer.concat([prefix, json, buf.subarray(base)]));
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
    const index = readStored();
    expect(index.paths).not.toContain("src/list.ts");
    expect(index.paths).not.toContain("src/auth/login.ts");
  });

  it("rebuilds when HEAD moves", async () => {
    const repo = gitRepoAccess(dir)!;
    cachedBm25Ranker(dir)(repo, sourceFiles(repo), QUERIES[2]);
    const before = readStored().header.head;

    write("src/auth/refresh.ts", "export function refreshSessionToken() { /* races logout */ }\n");
    git("add", ".");
    git("commit", "-q", "-m", "more");
    const moved = gitRepoAccess(dir)!;
    const files = sourceFiles(moved);

    expect(cachedBm25Ranker(dir)(moved, files, QUERIES[2])).toEqual(bm25Rank(moved, files, QUERIES[2]));
    expect(readStored().header.head).not.toBe(before);
  });

  it("rebuilds an index a different tokenizer built", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    cachedBm25Ranker(dir)(repo, files, QUERIES[0]);
    expect(readStored().header.tok).toBe(TOKENIZER_FINGERPRINT);
    // As an older build would have left it: same HEAD, other tokens.
    rewriteHeader((h) => ({ ...h, tok: "an-older-tokenizer" }));

    const watched = counting(repo);
    expect(cachedBm25Ranker(dir)(watched, files, QUERIES[0])).toEqual(bm25Rank(repo, files, QUERIES[0]));
    expect(watched.reads.length).toBeGreaterThan(0);
    expect(readStored().header.tok).toBe(TOKENIZER_FINGERPRINT);
  });

  it("keeps skipping a file too large to score without reading it again", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    const rank = cachedBm25Ranker(dir);
    rank(repo, files, QUERIES[1]);

    const watched = counting(repo);
    rank(watched, files, QUERIES[1]);

    expect(readStored().skipped).toEqual(["src/big.ts"]);
    expect(watched.reads).toEqual([]);
  });

  it("ignores an index from another version or root, a malformed one and a corrupt one", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    const rank = cachedBm25Ranker(dir);
    rank(repo, files, QUERIES[0]);
    const path = bm25IndexPath(dir);
    const good = readFileSync(path);
    const { header, base } = readStored();
    const [postingsAt, postingsSize] = header.at.postings;
    expect(postingsSize).toBeGreaterThan(0);

    const corrupt: Array<[string, () => void]> = [
      ["another version", () => rewriteHeader((h) => ({ ...h, v: 0 }))],
      ["another root", () => rewriteHeader((h) => ({ ...h, root: "/elsewhere" }))],
      ["sections that do not tile the file", () => rewriteHeader((h) => ({ ...h, docs: (h.docs as number) + 1 }))],
      ["a commit git no longer has", () => rewriteHeader((h) => ({ ...h, head: "0123456789abcdef0123456789abcdef01234567" }))],
      ["cut short", () => writeFileSync(path, good.subarray(0, Math.floor(good.length / 2)))],
      ["cut inside the prefix", () => writeFileSync(path, good.subarray(0, 5))],
      ["empty", () => writeFileSync(path, "")],
      ["garbage", () => writeFileSync(path, Buffer.from(Array.from({ length: good.length }, (_, i) => (i * 131 + 7) & 0xff)))],
      ["a header that is not JSON", () => writeFileSync(path, Buffer.concat([good.subarray(0, 12), Buffer.from("{not json"), good.subarray(21)]))],
      ["postings that do not decode", () => {
        const bad = Buffer.from(good);
        bad.fill(0xff, base + postingsAt, base + postingsAt + postingsSize);
        writeFileSync(path, bad);
      }],
    ];
    for (const [name, damage] of corrupt) {
      writeFileSync(path, good);
      damage();
      const watched = counting(repo);
      expect(rank(watched, files, QUERIES[0]), name).toEqual(bm25Rank(repo, files, QUERIES[0]));
      expect(watched.reads.length, name).toBeGreaterThan(0);
      // Rebuilt in place: the next call is a hit again.
      const again = counting(repo);
      expect(rank(again, files, QUERIES[0]), name).toEqual(bm25Rank(repo, files, QUERIES[0]));
      expect(again.reads, name).toEqual([]);
    }
  });

  it("never reads the old JSON index, and removes it when it writes the new one", async () => {
    const legacy = join(home, "cache", basename(bm25IndexPath(dir)).replace(/\.idx$/, ".json"));
    expect(legacy).not.toBe(bm25IndexPath(dir));
    mkdirSync(dirname(legacy), { recursive: true });
    // What the old format would have said for this HEAD: no file has any word.
    writeFileSync(legacy, JSON.stringify({
      v: 2, tok: TOKENIZER_FINGERPRINT, root: dir, head: git("rev-parse", "HEAD").trim(), maxBytes: MAX_BM25_BYTES,
      paths: [], lengths: [], blobs: [], skipped: [], skippedBlobs: [], postings: {},
    }));
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);

    expect(cachedBm25Ranker(dir)(repo, files, QUERIES[0])).toEqual(bm25Rank(repo, files, QUERIES[0]));
    expect(existsSync(bm25IndexPath(dir))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it("after a HEAD move that changes, adds and deletes files, with others dirty, scores exactly as bm25Rank", async () => {
    write("src/auth/token.ts", "export function refreshToken() { /* refresh the session token */ }\n");
    git("add", ".");
    git("commit", "-q", "-m", "more");
    const repo = gitRepoAccess(dir)!;
    for (const q of QUERIES) cachedBm25Ranker(dir)(repo, sourceFiles(repo), q);

    write("src/auth/session.ts", "export function logout() { validatePassword(''); password token }\n"); // changed
    write("src/auth/reset.ts", "export function resetPassword(kind: string) { listByKind(kind) }\n"); // added
    git("rm", "-q", "src/util/strings.ts"); // deleted
    git("add", ".");
    git("commit", "-q", "-m", "change, add, delete");
    write("src/list.ts", "export function listByKind() { return 'password session'; }\n"); // dirty, not committed
    write("src/auth/token.ts", "export const nothing = 0;\n"); // dirty, unchanged at HEAD
    write("src/auth/reset.ts", "export function resetPassword() { /* edited again */ }\n"); // added at HEAD, and dirty
    const moved = gitRepoAccess(dir)!;
    const files = sourceFiles(moved);

    const watched = counting(moved);
    expect(cachedBm25Ranker(dir)(watched, files, QUERIES[0])).toEqual(bm25Rank(moved, files, QUERIES[0]));
    expect(watched.reads.sort()).toEqual(["src/auth/reset.ts", "src/auth/session.ts", "src/auth/token.ts", "src/list.ts"]);

    // The patched index serves every query at the new HEAD, reading only the dirty files.
    for (const q of QUERIES) {
      const warm = counting(moved);
      expect(cachedBm25Ranker(dir)(warm, files, q)).toEqual(bm25Rank(moved, files, q));
      expect(warm.reads.sort()).toEqual(["src/auth/reset.ts", "src/auth/token.ts", "src/list.ts"]);
    }
    const index = readStored();
    expect(index.header.head).toBe(git("rev-parse", "HEAD").trim());
    // HEAD's text of a file unchanged since the last index stays stored while
    // the worktree differs; one that changed at HEAD and is dirty is not stored.
    expect(index.paths.sort()).toEqual(["src/auth/login.ts", "src/auth/session.ts", "src/auth/token.ts", "src/list.ts"]);
    expect(index.skipped).toEqual(["src/big.ts"]);

    // Once the worktree is clean again, only the file that was dirty when the index was patched is read.
    git("checkout", "--", ".");
    const clean = counting(moved);
    for (const q of QUERIES) expect(cachedBm25Ranker(dir)(clean, files, q)).toEqual(bm25Rank(moved, files, q));
    expect(new Set(clean.reads)).toEqual(new Set(["src/auth/reset.ts"]));
  });

  it("patches to the same words and files as a build from scratch", async () => {
    const repo = gitRepoAccess(dir)!;
    cachedBm25Ranker(dir)(repo, sourceFiles(repo), QUERIES[0]);

    write("src/auth/session.ts", "export function logout() { validatePassword(''); brandNewWord }\n");
    write("src/auth/reset.ts", "export function resetPassword(kind: string) { anotherNewWord(kind) }\n");
    git("rm", "-q", "src/util/strings.ts"); // the only file with hasOwnProperty
    git("add", ".");
    git("commit", "-q", "-m", "change, add, delete");
    const moved = gitRepoAccess(dir)!;
    const files = sourceFiles(moved);
    cachedBm25Ranker(dir)(moved, files, QUERIES[1]);
    const patched = readStored();

    rmSync(bm25IndexPath(dir));
    cachedBm25Ranker(dir)(moved, files, QUERIES[1]);
    const fresh = readStored();
    expect(new Set(patched.paths)).toEqual(new Set(fresh.paths));
    expect(patched.skipped).toEqual(fresh.skipped);
    expect(patched.header.terms).toBe(fresh.header.terms);
    expect(patched.header.at.termText).toEqual(fresh.header.at.termText);
    // Same words, in the same order, whatever the document numbering.
    const words = (stored: ReturnType<typeof readStored>) =>
      stored.buf.subarray(stored.base + stored.header.at.termText[0], stored.base + stored.header.at.termText[0] + stored.header.at.termText[1]);
    expect(words(patched).equals(words(fresh))).toBe(true);
    expect(words(patched).includes("brandnewword")).toBe(true);
    expect(words(patched).includes("hasownproperty")).toBe(false);
  });

  it("after a HEAD move, stores a file it skipped as dirty before", async () => {
    write("src/auth/login.ts", "export const changed = 'nothing about passwords';\n");
    const repo = gitRepoAccess(dir)!;
    cachedBm25Ranker(dir)(repo, sourceFiles(repo), QUERIES[0]); // built while login.ts is dirty
    expect(readStored().paths).not.toContain("src/auth/login.ts");

    git("checkout", "--", "src/auth/login.ts");
    write("src/auth/refresh.ts", "export function refreshSessionToken() {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "move HEAD");
    const moved = gitRepoAccess(dir)!;
    const files = sourceFiles(moved);
    const watched = counting(moved);

    expect(cachedBm25Ranker(dir)(watched, files, QUERIES[0])).toEqual(bm25Rank(moved, files, QUERIES[0]));
    expect(watched.reads.sort()).toEqual(["src/auth/login.ts", "src/auth/refresh.ts"]);
    expect(readStored().paths).toContain("src/auth/login.ts");
    const warm = counting(moved);
    expect(cachedBm25Ranker(dir)(warm, files, QUERIES[0])).toEqual(bm25Rank(moved, files, QUERIES[0]));
    expect(warm.reads).toEqual([]);
  });

  it("after a HEAD move, diffs only below a subdirectory root, with paths relative to it", async () => {
    const sub = join(dir, "src");
    const repo = gitRepoAccess(sub)!;
    cachedBm25Ranker(sub)(repo, sourceFiles(repo), QUERIES[0]);

    write("src/auth/session.ts", "export function logout() { validatePassword(''); password }\n");
    write("docs/guide.ts", "export const outside = 'password';\n"); // outside the root
    git("add", ".");
    git("commit", "-q", "-m", "inside and outside");
    const moved = gitRepoAccess(sub)!;
    const files = sourceFiles(moved);
    const watched = counting(moved);

    expect(cachedBm25Ranker(sub)(watched, files, QUERIES[0])).toEqual(bm25Rank(moved, files, QUERIES[0]));
    expect(watched.reads).toEqual(["auth/session.ts"]);
    expect(readStored(bm25IndexPath(sub)).paths).toContain("auth/session.ts");
  });

  it("with deferSave, writes the index only when saveBm25Index runs, and not if the tree moved meanwhile", async () => {
    const repo = gitRepoAccess(dir)!;
    const files = sourceFiles(repo);
    const rank = cachedBm25Ranker(dir, { deferSave: true });

    expect(rank(repo, files, QUERIES[0])).toEqual(bm25Rank(repo, files, QUERIES[0]));
    expect(existsSync(bm25IndexPath(dir))).toBe(false);
    write("src/auth/login.ts", "export const edited = 1;\n"); // dirty since the files were read
    saveBm25Index();
    expect(existsSync(bm25IndexPath(dir))).toBe(false);

    git("checkout", "--", "src/auth/login.ts");
    rank(repo, files, QUERIES[1]);
    saveBm25Index();
    expect(existsSync(bm25IndexPath(dir))).toBe(true);
    saveBm25Index(); // nothing left to do
    const watched = counting(repo);
    for (const q of QUERIES) expect(rank(watched, files, q)).toEqual(bm25Rank(repo, files, q));
    expect(watched.reads).toEqual([]);
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
