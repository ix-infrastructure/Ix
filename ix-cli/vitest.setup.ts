// Copyright 2026 Ix Infrastructure Inc.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Runs before every test file (vitest `setupFiles`).
//
// Give every file a throwaway home, so nothing a test does by default can
// reach the developer's real `~/.ix` -- or the IX_HOME they exported. The CLI
// finds its state through `ixHome()` (`$IX_HOME`, else `~/.ix`), and a test
// that forgot to isolate itself used to resolve that to the real one: it could
// overwrite `.backend-version`, register workspaces in the real config.yaml,
// or drop map baselines next to the developer's own. `vitest.home-guard.ts`
// fails the run if anything reaches it anyway.
//
// HOME and USERPROFILE (what `os.homedir()` reads on Windows) point at a fresh
// temp directory, which also covers what is not under IX_HOME: the host config
// files `ix mcp` writes, `~/.local/bin`, a child process's git config. An
// ambient IX_HOME is stripped, as it always was here: a developer, or a
// harness such as a benchmark, that has one exported would otherwise have every
// file that isolates itself by overriding HOME write to THEIR state directory
// instead of the temp home it set up -- a HOME override relocates `~/.ix`, not
// `$IX_HOME`. So by default the state directory is `<temp home>/.ix`.
//
// Under vitest's threads / vmThreads pools that is not enough on its own:
// `os.homedir()` answers from the environment libuv sees, which a worker
// thread's `process.env` write never reaches, so the HOME set here -- and every
// HOME override a test makes -- would be ignored and `~/.ix` would resolve to
// the real one. There, `os.homedir()` is made to read `process.env` the way
// libuv reads the real environment in a forked worker (USERPROFILE on Windows,
// HOME elsewhere, the original answer when unset), and the change is synced to
// every `import { homedir } from "node:os"`. A dozen files isolate by
// overriding HOME, some swapping it between two "machines" inside one test,
// so this keeps them isolated in every pool rather than only under forks
// (vmThreads, below, is the one exception).
//
// `realpathSync` because macOS hands out `/var/...` for a directory that is
// really `/private/var/...`, and some tests compare canonical paths.
//
// Tests that set their own HOME or IX_HOME still win: they do so in
// `beforeEach` or at module scope, both of which run after this. Per file, not
// once per worker -- vitest re-runs setupFiles for each file, so each file
// starts from an empty home and no file can leak state, or an environment
// override, to the next.
const home = realpathSync(mkdtempSync(join(os.tmpdir(), "ix-test-home-")));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.IX_HOME;
if (os.homedir() !== home) {
  const libuvHomedir = os.homedir;
  os.homedir = () =>
    (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || libuvHomedir();
  syncBuiltinESMExports();
}
// vmThreads links builtins into each file as a snapshot the patch does not
// reach. Where a fresh import still answers the real home, pin IX_HOME: a HOME
// override then no longer moves a file's state, but nothing reaches `~/.ix`.
if ((await import("node:os")).homedir() !== home) process.env.IX_HOME = join(home, ".ix");

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

// No test may start a real background map refresh (a detached `ix
// __map-refresh` process that outlives the test). Region views start one
// whenever a deferred map is stale; with this they only say so. The tests of
// that path turn it back on and inject the spawner.
process.env.IX_MAP_BACKGROUND_REFRESH = "0";

// A target that resolves to nothing runs one bounded `rg` over the workspace to
// say why (`cli/miss-reason.ts`). Under test the "workspace" is this checkout,
// whose sources and fixtures mention every name a test misses on, so the
// reason would depend on the repository's contents. Off by default here; the
// tests for the probe turn it back on.
process.env.IX_MISS_PROBE = "0";
