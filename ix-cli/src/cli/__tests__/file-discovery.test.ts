// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverSourceFiles, emptyDiscoveryCounts, tryGitLsFiles, walkFiles } from '../file-discovery.js';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ix-files-')));
  scratch.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
const rel = (root: string, files: string[]) => files.map(f => relative(root, f).replace(/\\/g, '/')).sort();

describe('file discovery', () => {
  it('keeps non-ASCII file names in a git repository (they used to be quoted and dropped)', () => {
    const root = tree({ 'src/café.ts': 'export const a = 1;\n', 'src/日本語.ts': 'export const b = 2;\n', 'src/plain.ts': '' });
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    expect(rel(root, tryGitLsFiles(root, true)!)).toEqual(['src/café.ts', 'src/plain.ts', 'src/日本語.ts']);
  });

  it('git and the walk return the same files for the same tree', () => {
    const files = {
      '.gitignore': 'generated/\nlocal.ts\n',
      'src/app.ts': '',
      'src/local.ts': '',
      'src/generated/out.ts': '',
      'tests/test_app.py': '',
      'pkg/server/server.go': '',
      'examples/demo.ts': '',
      '.github/workflows/ci.yml': 'on: push\n',
      'node_modules/dep/index.js': '',
      'dist/bundle.js': '',
      'pkg/api/types.pb.go': '',
    };
    const gitRoot = tree(files);
    git(gitRoot, 'init', '-q');
    const walkRoot = tree(files); // no .git: the walk

    const viaGit = rel(gitRoot, discoverSourceFiles(gitRoot));
    const viaWalk = rel(walkRoot, discoverSourceFiles(walkRoot));

    expect(viaWalk).toEqual(viaGit);
    expect(viaWalk).toEqual(['.github/workflows/ci.yml', 'examples/demo.ts', 'pkg/server/server.go', 'src/app.ts', 'tests/test_app.py']);
  });

  it('honours a nested .gitignore on the walk', () => {
    const root = tree({ 'a/.gitignore': 'secret.ts\n', 'a/secret.ts': '', 'a/kept.ts': '', 'b/secret.ts': '' });
    expect(rel(root, [...walkFiles(root, true)])).toEqual(['a/kept.ts', 'b/secret.ts']);
  });

  it('counts what it skipped instead of dropping it silently', () => {
    const root = tree({ 'src/a.ts': '', 'src/gone.ts': '' });
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    rmSync(join(root, 'src', 'gone.ts')); // tracked, no longer on disk
    writeFileSync(join(root, 'src', 'b.js'), '', 'utf8');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'b.js'), '', 'utf8'); // untracked build output
    const counts = emptyDiscoveryCounts();
    expect(rel(root, discoverSourceFiles(root, { counts }))).toEqual(['src/a.ts', 'src/b.js']);
    expect(counts).toEqual({ skippedDirs: 1, unreadable: 1 });
  });

  it('keeps a tracked file whatever its directory is called; skips untracked ones under those names', () => {
    // A repository that commits `build/` or `out/` is saying it is source.
    // git's ignore rules decide what is generated in a work tree; the names
    // are only a fallback for what nothing told git to ignore.
    const files = {
      'build/gen.ts': '', 'out/main.ts': '', 'target/T.java': '', 'obj/x.cs': '', 'coverage/report.js': '',
      'src/app.ts': '',
    };
    const root = tree(files);
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    writeFileSync(join(root, 'build', 'fresh.ts'), '', 'utf8'); // untracked, not ignored
    const counts = emptyDiscoveryCounts();
    expect(rel(root, discoverSourceFiles(root, { counts }))).toEqual([
      'build/gen.ts', 'coverage/report.js', 'obj/x.cs', 'out/main.ts', 'src/app.ts', 'target/T.java',
    ]);
    expect(counts.skippedDirs).toBe(1);

    // Without git there is no record of what is tracked: the walk keeps
    // skipping those names.
    const plain = tree(files);
    expect(rel(plain, discoverSourceFiles(plain))).toEqual(['src/app.ts']);
  });

  it('stops a walk at walkLimit, and never caps a git listing', () => {
    const root = tree({ 'a.ts': '', 'b.ts': '', 'c.ts': '', 'd.ts': '' });
    expect(discoverSourceFiles(root, { walkLimit: 2 })).toHaveLength(2);
    git(root, 'init', '-q');
    expect(discoverSourceFiles(root, { walkLimit: 2 })).toHaveLength(4);
  });

  it('copies of one tree agree whether or not they are a git checkout', () => {
    // The same tree as a git repository with committed files and as a plain
    // copy: discovery must not depend on how it was obtained.
    const root = tree({ 'lib/x.ts': '', 'lib/tests/x.test.ts': '', 'scripts/tool.py': '' });
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    const copy = realpathSync.native(mkdtempSync(join(tmpdir(), 'ix-files-copy-')));
    scratch.push(copy);
    cpSync(root, copy, { recursive: true, filter: (src) => !src.includes(`${'/'}.git`) });
    expect(rel(copy, discoverSourceFiles(copy))).toEqual(rel(root, discoverSourceFiles(root)));
  });
});
