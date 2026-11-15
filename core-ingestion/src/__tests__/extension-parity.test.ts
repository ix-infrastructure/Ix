// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FILE_NAME_MAP, languageFromPath } from '../languages.js';

// supported-extensions.ts documents that it "MUST stay in sync" with EXT_MAP,
// but nothing enforced it, so every new parser was one forgotten line away from
// ingesting nothing: a file type the walker never yields is silently absent from
// the graph rather than failing loudly.
//
// Both files are read as text so this stays independent of the ix-cli build.
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const parsedExtensions = (() => {
  const source = read('../languages.ts');
  const start = source.indexOf('const EXT_MAP');
  // Up to EXT_MAP's own closing brace: FILE_NAME_MAP follows it, and its
  // dotfile keys ('.bashrc') look like extensions to the regex below.
  const map = source.slice(start, source.indexOf('\n};', start));
  return new Set([...map.matchAll(/'(\.[a-z0-9]+)'\s*:/gi)].map((match) => match[1]));
})();

const supportedExtensionsSource = read('../../../ix-cli/src/cli/supported-extensions.ts');
const fileNamesAt = supportedExtensionsSource.indexOf('export const SUPPORTED_FILE_NAMES');

const walkedExtensions = new Set(
  [...supportedExtensionsSource.slice(0, fileNamesAt)
    .matchAll(/"(\.[a-z0-9]+)"/gi)].map((match) => match[1]),
);

// Whole file names discovery accepts (Dockerfile, Makefile, .bashrc, ...).
// `path.extname('.bashrc')` is '', so the extension sets above say nothing
// about them: the parser mapped eight shell dotfiles to Bash for a long time
// while `ix map` never handed it one (Ix#960).
const walkedFileNames = new Set(
  [...supportedExtensionsSource
    .slice(supportedExtensionsSource.indexOf('new Set', fileNamesAt), supportedExtensionsSource.indexOf(']);', fileNamesAt))
    .matchAll(/"([^"]+)"/g)].map((match) => match[1]),
);
const parsedFileNames = new Set(Object.keys(FILE_NAME_MAP));

describe('extension parity between EXT_MAP and SUPPORTED_EXTENSIONS', () => {
  it('reads a non-empty set from both files', () => {
    // Guards against a regex that silently matches nothing after a refactor,
    // which would make every assertion below vacuously true.
    expect(parsedExtensions.size).toBeGreaterThan(50);
    expect(walkedExtensions.size).toBeGreaterThan(50);
  });

  it('walks every extension a parser handles', () => {
    expect([...parsedExtensions].filter((ext) => !walkedExtensions.has(ext))).toEqual([]);
  });

  it('has a parser for every extension it walks', () => {
    expect([...walkedExtensions].filter((ext) => !parsedExtensions.has(ext))).toEqual([]);
  });

  it('resolves each walked extension to a language', () => {
    const unresolved = [...walkedExtensions].filter((ext) => !languageFromPath(`file${ext}`));
    expect(unresolved).toEqual([]);
  });
});

describe('file-name parity between FILE_NAME_MAP and SUPPORTED_FILE_NAMES', () => {
  it('reads a non-empty set from both files', () => {
    expect(fileNamesAt).toBeGreaterThan(0);
    expect(parsedFileNames.size).toBeGreaterThan(5);
    expect(walkedFileNames.size).toBeGreaterThan(5);
    // The name list did not leak into the extension set, nor the reverse.
    expect([...walkedExtensions].filter((ext) => walkedFileNames.has(ext))).toEqual([]);
  });

  it('walks every file name a parser handles', () => {
    expect([...parsedFileNames].filter((name) => !walkedFileNames.has(name))).toEqual([]);
  });

  it('has a parser for every file name it walks', () => {
    expect([...walkedFileNames].filter((name) => !parsedFileNames.has(name))).toEqual([]);
  });

  it('resolves each walked file name to a language, in any case and directory', () => {
    const unresolved = [...walkedFileNames].filter((name) =>
      !languageFromPath(`repo/dir/${name}`) || !languageFromPath(`C:\\repo\\${name.toUpperCase()}`));
    expect(unresolved).toEqual([]);
  });

  it('keeps the shell dotfiles mapped to Bash', () => {
    for (const name of ['.bashrc', '.bash_profile', '.bash_aliases', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.profile']) {
      expect(languageFromPath(`home/${name}`), name).toBe('bash');
    }
    expect(languageFromPath('Makefile.mk')).toBe('makefile');
    expect(languageFromPath('prod.Dockerfile')).toBe('dockerfile');
    expect(languageFromPath('.gitignore')).toBeNull();
    expect(languageFromPath('constructor')).toBeNull();
  });
});
