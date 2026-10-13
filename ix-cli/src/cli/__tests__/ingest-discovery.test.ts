// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  dedupeDiscoveredFilePaths,
  isSupportedSourceFile,
  discoverIngestFilePaths,
  isWithinDiscoveryRoot,
  tryGitLsFiles,
} from '../commands/ingest.js';
import { discoverSourceFiles, emptyDiscoveryCounts, walkFiles } from '../file-discovery.js';

describe('dedupeDiscoveredFilePaths', () => {
  it('collapses alternate discovered paths that point at the same canonical file', () => {
    const deduped = dedupeDiscoveredFilePaths(
      [
        'C:/repo/staging/src/k8s.io/apiserver/pkg/server/config.go',
        'C:/repo/vendor/k8s.io/apiserver/pkg/server/config.go',
        'C:/repo/cmd/kube-apiserver/app/server.go',
      ],
      (filePath) => {
        if (filePath.includes('/vendor/')) {
          return 'C:/repo/staging/src/k8s.io/apiserver/pkg/server/config.go';
        }
        return filePath;
      },
    );

    expect(deduped).toEqual([
      'C:/repo/staging/src/k8s.io/apiserver/pkg/server/config.go',
      'C:/repo/cmd/kube-apiserver/app/server.go',
    ]);
  });

  it('treats Dockerfile variants as supported source inputs', () => {
    expect(isSupportedSourceFile('Dockerfile')).toBe(true);
    expect(isSupportedSourceFile('deploy/prod.dockerfile')).toBe(true);
  });

  it('treats Makefiles as supported source inputs', () => {
    expect(isSupportedSourceFile('Makefile')).toBe(true);
    expect(isSupportedSourceFile('GNUmakefile')).toBe(true);
    expect(isSupportedSourceFile('build/common.mk')).toBe(true);
    expect(isSupportedSourceFile('README.txt')).toBe(false);
  });

  it('discovers TeX/LaTeX source files', () => {
    expect(isSupportedSourceFile('paper/main.tex')).toBe(true);
    expect(isSupportedSourceFile('pkg/mystyle.sty')).toBe(true);
    expect(isSupportedSourceFile('cls/thesis.cls')).toBe(true);
    expect(isSupportedSourceFile('legacy/doc.ltx')).toBe(true);
    expect(isSupportedSourceFile('notes.latex')).toBe(true);
  });

  it('discovers the grammar-based parsers that ship in core-ingestion', () => {
    // These extensions are parsed by core-ingestion but were missing from the
    // discovery allowlist, so their files were never walked. Guard against regress.
    for (const f of [
      'init.lua', 'deploy.sh', 'run.bash', 'Main.hs', 'build.zig',
      'index.html', 'pom.xml', 'app.csproj', 'main.tf', 'theme.css', 'styles.scss',
    ]) {
      expect(isSupportedSourceFile(f)).toBe(true);
    }
  });

  it('confines a canonical path to the discovery root', () => {
    const root = join('/repo', 'project');
    expect(isWithinDiscoveryRoot(root, join(root, 'src', 'app.ts'))).toBe(true);
    expect(isWithinDiscoveryRoot(root, join('/repo', 'other', 'app.ts'))).toBe(false);
    expect(isWithinDiscoveryRoot(root, join('/repo', 'app.ts'))).toBe(false);
    // The root itself is not a file inside the root.
    expect(isWithinDiscoveryRoot(root, root)).toBe(false);
    // A sibling whose name merely starts with dots is outside, but a *child*
    // whose name does must stay in — the reason this compares segments.
    expect(isWithinDiscoveryRoot(root, join('/repo', '..shared', 'app.ts'))).toBe(false);
    expect(isWithinDiscoveryRoot(root, join(root, '..shared', 'app.ts'))).toBe(true);
  });
});

describe('discovery symlink containment', () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    // realpath because macOS hands back /var/... for a /private/var/... temp dir,
    // and this whole guarantee is about comparing resolved paths.
    return realpathSync(dir);
  }

  it.skipIf(process.platform === 'win32')(
    'drops a committed symlink that leaves the repository',
    (ctx) => {
      const repo = scratchDir('ix-repo-');
      const outside = scratchDir('ix-outside-');
      const secret = join(outside, 'secret.ts');
      writeFileSync(secret, 'export const token = "leaked";\n');

      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'real.ts'), 'export const ok = 1;\n');
      try {
        // A symlink with a source extension: git records it as an ordinary
        // entry, and the stat behind it describes the file it points at.
        symlinkSync(secret, join(repo, 'src', 'notes.ts'));
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['add', '-A'], { cwd: repo });
      } catch {
        return ctx.skip('no git, or no permission to symlink');
      }

      const listed = tryGitLsFiles(repo, true);
      expect(listed).not.toBeNull();

      // The escape is real: discovery resolves the link and hands back a path
      // outside the repository. Without this the assertions below could pass
      // simply because nothing was ever discovered.
      expect(dedupeDiscoveredFilePaths(listed!)).toContain(secret);

      // The function runIngest actually calls, so removing the confinement
      // from it fails here rather than passing a re-implementation.
      const discovery = discoverIngestFilePaths(listed!, repo);

      expect(discovery.files).not.toContain(secret);
      expect(discovery.files).toEqual([join(repo, 'src', 'real.ts')]);
      expect(discovery.outsideRoot).toBe(1);
    },
  );

  it('skips generated dependency lockfiles that expand into oversized graph patches', (ctx) => {
    // Ix#523: a 646 KB `package-lock.json` is under MAX_FILE_BYTES but its
    // patch is over the proxy's body limit, so the commit 413s and the map
    // exits non-zero with no completion baseline.
    //
    // Asserted through `tryGitLsFiles` — the listing `runIngest` actually
    // discovers from — rather than by handing `discoverIngestFilePaths` a
    // literal list. That function confines paths to the root; it is not where
    // generated files are dropped, so an assertion there would pass while the
    // real discovery path still yielded the lockfile.
    const repo = scratchDir('ix-lockfile-');
    writeFileSync(join(repo, 'package.json'), '{"name":"pkg"}\n');
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(join(repo, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}\n');
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(join(repo, 'packages.lock.json'), '{"version":1}\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const ok = 1;\n');
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
    } catch {
      return ctx.skip('no git');
    }

    const listed = tryGitLsFiles(repo, true);
    expect(listed).not.toBeNull();
    // Basenames, not full paths: `scratchDir` realpaths its temp directory and
    // `tryGitLsFiles` canonicalizes independently, and on a Windows runner
    // those disagree on how to spell the same directory (`RUNNER~1` vs
    // `runneradmin`). Which files survived is the claim; how the path spells
    // their parent is not.
    expect(listed!.map((filePath) => basename(filePath)).sort())
      .toEqual(['index.ts', 'package.json']);
  });

  it.skipIf(process.platform === 'win32')(
    'still discovers everything when the root is reached through a symlink',
    (ctx) => {
      // Resolving the file but not the root drops every file and reports the
      // repository as empty. No CI runner here has a symlinked root (the matrix
      // is ubuntu + windows), so this test is the only thing holding it down.
      const real = scratchDir('ix-realroot-');
      const parent = scratchDir('ix-linkroot-');
      const link = join(parent, 'root');
      mkdirSync(join(real, 'src'), { recursive: true });
      writeFileSync(join(real, 'src', 'app.ts'), 'export const ok = 1;\n');
      try {
        symlinkSync(real, link, 'dir');
      } catch {
        return ctx.skip('no permission to symlink');
      }

      const discovery = discoverIngestFilePaths([join(link, 'src', 'app.ts')], link);

      expect(discovery.files).toEqual([join(real, 'src', 'app.ts')]);
      expect(discovery.outsideRoot).toBe(0);
    },
  );

  it('leaves an explicitly named single file alone', () => {
    // No root: the user named the file, so there is nothing to escape from and
    // confinement must not reject it.
    const outside = '/elsewhere/app.ts';
    const discovery = discoverIngestFilePaths([outside], undefined, (p) => p);

    expect(discovery.files).toEqual([outside]);
    expect(discovery.outsideRoot).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a symlink that stays inside the repository',
    (ctx) => {
      // Monorepos link packages around inside the tree. Confinement must not
      // turn into "no symlinks at all".
      const repo = scratchDir('ix-repo-');
      mkdirSync(join(repo, 'shared'), { recursive: true });
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'shared', 'util.ts'), 'export const shared = 1;\n');
      try {
        symlinkSync(join(repo, 'shared', 'util.ts'), join(repo, 'src', 'util.ts'));
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['add', '-A'], { cwd: repo });
      } catch {
        return ctx.skip('no git, or no permission to symlink');
      }

      const canonical = dedupeDiscoveredFilePaths(tryGitLsFiles(repo, true) ?? []);
      const kept = canonical.filter((candidate) => isWithinDiscoveryRoot(repo, candidate));

      expect(kept).toContain(join(repo, 'shared', 'util.ts'));
    },
  );

  // QA-07. A directory symlink to its parent is a loop. Guards: the Dirent
  // checks in walkFiles (a link is neither isDirectory() nor isFile(), so the
  // walk never descends), and the statSync(...).isFile() in tryGitLsFiles.
  it.skipIf(process.platform === 'win32')(
    'walkFiles does not follow a directory symlink to its parent',
    () => {
      const repo = scratchDir('ix-loop-');
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
      try {
        symlinkSync('..', join(repo, 'src', 'up'), 'dir');
      } catch {
        return; // no permission to symlink — nothing to assert
      }

      const walked = [...walkFiles(repo, true)].map((p) => p.slice(repo.length + 1)).sort();

      expect(walked).toEqual(['src/a.ts', 'src/b.ts']);
      expect(walked.some((p) => p.includes('/up/'))).toBe(false);
    },
  );

  // QA-07. The walk's other Dirent check: only a real file (entry.isFile())
  // is yielded, so a file symlink with a source extension that points out of
  // the repository is never read on the no-git path.
  it.skipIf(process.platform === 'win32')(
    'walkFiles does not yield a file symlink that leaves the repository',
    () => {
      const repo = scratchDir('ix-walk-leak-');
      const outside = scratchDir('ix-walk-outside-');
      const secret = join(outside, 'secret.ts');
      writeFileSync(secret, 'export const token = "leaked";\n');
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      try {
        symlinkSync(secret, join(repo, 'src', 'notes.ts'));
      } catch {
        return; // no permission to symlink — nothing to assert
      }

      const walked = [...walkFiles(repo, true)].map((p) => p.slice(repo.length + 1)).sort();

      expect(walked).toEqual(['src/a.ts']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a git-tracked directory symlink is not discovered as a file',
    () => {
      const repo = scratchDir('ix-loop-git-');
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
      try {
        // Named like a source file, so only the stat check can drop it.
        symlinkSync('..', join(repo, 'src', 'up.ts'), 'dir');
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['add', '-A'], { cwd: repo });
      } catch {
        return; // no git, or no permission to symlink — nothing to assert
      }

      const counts = emptyDiscoveryCounts();
      const files = discoverSourceFiles(repo, { counts });

      expect(files.map((p) => p.slice(repo.length + 1)).sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(counts.unreadable).toBe(0);
    },
  );
});
