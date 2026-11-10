// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isSupportedSourceFile, tryGitLsFiles, walkFiles } from '../file-discovery.js';

const { languageFromPath, SupportedLanguages }: {
  languageFromPath: (filePath: string) => string | null;
  SupportedLanguages: Record<string, string>;
} = await import(new URL('../../../../core-ingestion/dist/languages.js', import.meta.url).href);

const shellDotfiles = [
  '.bashrc', '.bash_profile', '.bash_aliases', '.zshrc',
  '.zprofile', '.profile', '.zshenv', '.bash_logout',
];

describe('source support parity between parser and discovery', () => {
  it.each([
    ...shellDotfiles.map((name) => [name, SupportedLanguages.Bash]),
    ['Dockerfile', SupportedLanguages.Dockerfile],
    ['prod.dockerfile', SupportedLanguages.Dockerfile],
    ['Makefile', SupportedLanguages.Makefile],
    ['GNUmakefile', SupportedLanguages.Makefile],
    ['Makefile.mk', SupportedLanguages.Makefile],
    ['build.makefile', SupportedLanguages.Makefile],
  ])('accepts special name %s on both sides', (name, language) => {
    for (const filePath of [name, `config/${name}`, `C:\\repo\\${name}`, `config/${name.toUpperCase()}`]) {
      expect(languageFromPath(filePath)).toBe(language);
      expect(isSupportedSourceFile(filePath), filePath).toBe(true);
    }
  });

  it('discovers every extension the parser handles', () => {
    const source = readFileSync(new URL('../../../../core-ingestion/src/languages.ts', import.meta.url), 'utf8');
    const map = source.slice(source.indexOf('const EXT_MAP'));
    const extensions = [...map.matchAll(/'(\.[a-z0-9]+)'\s*:/gi)].map((match) => match[1]);
    expect(extensions.length).toBeGreaterThan(50);
    for (const ext of extensions) {
      expect(languageFromPath(`file${ext}`), ext).not.toBeNull();
      expect(isSupportedSourceFile(`file${ext}`), ext).toBe(true);
    }
  });

  it.each(['README.txt', '.unknown', '.bashrc.bak', 'config', 'config/.zshrc.backup'])(
    'rejects unsupported name %s on both sides', (filePath) => {
      expect(languageFromPath(filePath)).toBeNull();
      expect(isSupportedSourceFile(filePath)).toBe(false);
    },
  );

  it('discovers repository shell dotfiles through both walking and Git', () => {
    // Match Git discovery's native canonicalization: plain realpathSync can keep
    // Windows 8.3 temp paths (RUNNER~1) that native resolution expands.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ix-shell-discovery-')));
    try {
      for (const name of shellDotfiles) writeFileSync(join(root, name), 'hello() { echo hello; }\n');
      writeFileSync(join(root, '.bashrc.bak'), 'backup\n');
      const expected = shellDotfiles.map((name) => join(root, name)).sort();
      expect([...walkFiles(root, true)].sort()).toEqual(expected);
      execFileSync('git', ['init', '-q'], { cwd: root });
      expect(tryGitLsFiles(root, true)?.sort()).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
