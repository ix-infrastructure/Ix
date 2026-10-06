// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryGitLsFiles } from "../commands/ingest.js";
import { gitRootFor } from "../config.js";
import { readGitState } from "../explain/bm25-cache.js";
import { gitDiffHead, gitTopLevel } from "../hook/session.js";

/**
 * A checkout's own .git/config can name commands git runs on its behalf:
 * core.fsmonitor runs whenever the index is read (ls-files, grep, diff HEAD),
 * and a textconv driver whenever a diff renders a matching file. Every git
 * call the CLI and its hooks make inside a user's checkout must run neither.
 */
describe.skipIf(process.platform === "win32")("git calls do not run commands from the repository's config", () => {
  let dir: string;
  let repo: string;
  let marker: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ix-git-config-"));
    repo = join(dir, "repo");
    marker = join(dir, "ran.log");
    const hook = join(dir, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "a.txt"), "needle\n");
    writeFileSync(join(repo, ".gitattributes"), "*.txt diff=conv\n");
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git("config", "core.fsmonitor", hook);
    git("config", "diff.conv.textconv", hook);
    writeFileSync(join(repo, "a.txt"), "needle\nmore\n");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => rmSync(marker, { force: true }));

  it.each<[string, () => unknown]>([
    ["ix ingest's git ls-files", () => tryGitLsFiles(repo, true)],
    ["the workspace root lookup", () => gitRootFor(repo)],
    ["the bm25 cache's git state", () => readGitState(repo)],
    ["the session hook's top level", () => gitTopLevel(repo)],
    ["the session hook's diff", () => gitDiffHead(repo)],
  ])("%s", (_name, call) => {
    call();
    expect(existsSync(marker)).toBe(false);
  });
});
