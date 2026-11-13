// Copyright 2026 Ix Infrastructure Inc.

// Read a repository snapshot straight from ix-bench's bare clones: no
// checkout, no backend. `git ls-tree` lists the tracked files at the base
// commit; `git cat-file --batch` reads the source ones in one process.
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { isSourcePath } from "./baseline-issue.mjs";

export const REPOS = join(homedir(), ".cache", "ix-bench", "external", "repos");
/** What `gitRepoAccess` reads at most (text-references MAX_SCAN_BYTES). */
const MAX_READ_BYTES = 256 * 1024;

export function bareRepo(repo, root = REPOS) {
  return join(root, `${repo.replace("/", "__")}.git`);
}

/** A RepoAccess over `commit`: every tracked file listed, source files readable. */
export function loadCorpus(repo, commit, root = REPOS) {
  const cwd = bareRepo(repo, root);
  const listing = execFileSync("git", ["ls-tree", "-r", "-z", "--long", commit], {
    cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  const files = [];
  const wanted = [];
  for (const row of listing) {
    const tab = row.indexOf("\t");
    const [, type, oid, size] = row.slice(0, tab).trim().split(/\s+/);
    const path = row.slice(tab + 1);
    if (type !== "blob") continue;
    files.push(path);
    if (isSourcePath(path) && Number(size) <= MAX_READ_BYTES) wanted.push({ path, oid });
  }
  const texts = new Map();
  if (wanted.length) {
    const out = spawnSync("git", ["cat-file", "--batch"], {
      cwd, input: wanted.map((w) => w.oid).join("\n") + "\n", maxBuffer: 2 * 1024 * 1024 * 1024,
    }).stdout;
    let pos = 0;
    for (const w of wanted) {
      const nl = out.indexOf(10, pos);
      const header = out.toString("utf8", pos, nl).split(" ");
      const len = Number(header[2]);
      texts.set(w.path, out.toString("utf8", nl + 1, nl + 1 + len));
      pos = nl + 1 + len + 1;
    }
  }
  return {
    files: () => files,
    read: (path) => texts.get(path),
    grep: (needle) => [...texts].flatMap(([path, text]) => text.split('\n')
      .filter(line => line.includes(needle)).map(line => ({ path, line }))),
    texts,
  };
}

export function goldFiles(patch) {
  return [...new Set([...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]))];
}
