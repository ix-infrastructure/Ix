// Copyright 2026 Ix Infrastructure Inc.

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

// A tripwire for the developer's real Ix state (vitest `globalSetup`).
//
// `vitest.setup.ts` gives every test file a throwaway home, and the CLI
// resolves its state directory on every call, so no test should be able to
// touch the real `~/.ix`. This proves it rather than trusting it: before the
// run it records the real `~/.ix` -- and an exported `$IX_HOME`, if the
// developer has one -- and after the run it fails if anything under either was
// created, changed or removed.
//
// globalSetup runs once in vitest's main process, which `vitest.setup.ts`
// never touches, so `os.homedir()` and `process.env.IX_HOME` here are still the
// developer's own. The guard only reads metadata (lstat, readdir): it never
// writes there, never follows a symlink out of it, and never reads a file's
// contents -- config.yaml holds a credential. A directory that does not exist
// is recorded as absent, so creating it is caught too.
//
// What it cannot tell apart: a real `ix` the developer (or an editor hook)
// ran against the same home while the suite was running changes it just the
// same. If the listed paths are yours, re-run; `IX_TEST_HOME_GUARD=off` skips
// the check for a run where that cannot be avoided.

/** Per-path signature; any write, create, delete, rename or chmod changes it. */
type Snapshot = Map<string, string>;

function signature(path: string): string | null {
  try {
    const st = lstatSync(path);
    const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : st.isFile() ? "f" : "o";
    return `${kind} ${st.size} ${st.mtimeMs} ${st.ctimeMs} ${st.mode} ${st.ino}`;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
}

function snapshot(root: string): Snapshot {
  const snap: Snapshot = new Map();
  // `~/.ix` may itself be a symlink to where the state really lives; record
  // the link, then walk what it points at. Nothing below it is followed.
  let base = root;
  try { base = realpathSync(root); } catch { /* absent: recorded as such below */ }
  if (base !== root) {
    const link = signature(root);
    if (link !== null) snap.set("->", link);
  }
  const walk = (dir: string): void => {
    const sig = signature(dir);
    if (sig === null) return;
    snap.set(relative(base, dir) || ".", sig);
    if (!sig.startsWith("d ")) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      const s = signature(path);
      if (s === null) continue; // removed between readdir and lstat
      if (s.startsWith("d ")) walk(path);
      else snap.set(relative(base, path), s);
    }
  };
  walk(base);
  return snap;
}

function diff(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const [path, sig] of after) {
    const was = before.get(path);
    if (was === undefined) changes.push(`created  ${path}`);
    else if (was !== sig) changes.push(`modified ${path}`);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push(`removed  ${path}`);
  }
  return changes.sort();
}

/** The real state directories: `~/.ix`, and `$IX_HOME` when one is exported. */
export function realStateDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs = [resolve(home, ".ix")];
  if (env.IX_HOME) dirs.push(resolve(env.IX_HOME));
  return [...new Set(dirs)];
}

export default function setup(): (() => void) | void {
  if (process.env.IX_TEST_HOME_GUARD === "off") return;
  const roots = realStateDirs();
  const before = roots.map((root) => snapshot(root));

  return () => {
    const report: string[] = [];
    roots.forEach((root, i) => {
      const changes = diff(before[i]!, snapshot(root));
      if (changes.length === 0) return;
      report.push(`  ${root}:`);
      for (const line of changes.slice(0, 20)) report.push(`    ${line}`);
      if (changes.length > 20) report.push(`    ... and ${changes.length - 20} more`);
    });
    if (report.length === 0) return;
    // Vitest runs globalSetup teardown after the results are reported and only
    // logs what it throws ("error during close"), leaving the exit status at 0.
    // Set it here, or the guard would be a message nobody's CI ever sees.
    process.exitCode = 1;
    throw new Error(
      [
        "The test run changed the developer's real Ix state directory:",
        ...report,
        "A test reached the real home instead of the temp one vitest.setup.ts gives it.",
        "If you ran `ix` yourself during the run, those changes are yours: re-run, or",
        "set IX_TEST_HOME_GUARD=off for that run.",
      ].join("\n"),
    );
  };
}
