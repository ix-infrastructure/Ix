import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { languageFromPath } from '../languages.js';

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
  const map = source.slice(source.indexOf('const EXT_MAP'));
  return new Set([...map.matchAll(/'(\.[a-z0-9]+)'\s*:/gi)].map((match) => match[1]));
})();

const walkedExtensions = new Set(
  [...read('../../../ix-cli/src/cli/supported-extensions.ts')
    .matchAll(/"(\.[a-z0-9]+)"/gi)].map((match) => match[1]),
);

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
