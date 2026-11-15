// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { isGrammarSupported, parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';
import { LANGUAGE_QUERIES } from '../queries.js';
import { REQUIRED_GRAMMARS } from './helpers/grammars.js';

// A query that names a node type or field its grammar does not have fails to
// compile. parseFile catches that, returns null, and the whole language goes
// unparsed with nothing but an "unparsed" count to show for it (#957: every
// Kotlin file). Parse a trivial file per language so the query is compiled
// against the grammar that is actually installed.

// One probe path per language that has a tree-sitter query. The guard test
// below fails when a language gains a query without an entry here.
const PROBE_PATHS: Partial<Record<SupportedLanguages, string>> = {
  [SupportedLanguages.TypeScript]: 'probe.ts',
  [SupportedLanguages.JavaScript]: 'probe.js',
  [SupportedLanguages.Python]: 'probe.py',
  [SupportedLanguages.Java]: 'Probe.java',
  [SupportedLanguages.C]: 'probe.c',
  [SupportedLanguages.Go]: 'probe.go',
  [SupportedLanguages.CPlusPlus]: 'probe.cpp',
  [SupportedLanguages.CSharp]: 'Probe.cs',
  [SupportedLanguages.Ruby]: 'probe.rb',
  [SupportedLanguages.Rust]: 'probe.rs',
  [SupportedLanguages.PHP]: 'probe.php',
  [SupportedLanguages.Kotlin]: 'Probe.kt',
  [SupportedLanguages.Swift]: 'Probe.swift',
  [SupportedLanguages.Scala]: 'Probe.scala',
  [SupportedLanguages.R]: 'probe.r',
  [SupportedLanguages.SAS]: 'probe.sas',
  [SupportedLanguages.Elixir]: 'probe.ex',
  [SupportedLanguages.Makefile]: 'Makefile',
  [SupportedLanguages.Lua]: 'probe.lua',
  [SupportedLanguages.Bash]: 'probe.sh',
  [SupportedLanguages.PowerShell]: 'probe.ps1',
  [SupportedLanguages.Haskell]: 'Probe.hs',
  [SupportedLanguages.Zig]: 'probe.zig',
  [SupportedLanguages.HTML]: 'probe.html',
  [SupportedLanguages.XML]: 'probe.xml',
  [SupportedLanguages.HCL]: 'probe.tf',
  [SupportedLanguages.CSS]: 'probe.css',
};

const queriedLanguages = (Object.keys(LANGUAGE_QUERIES) as SupportedLanguages[])
  .filter(language => LANGUAGE_QUERIES[language].trim() !== '');

function compileError(path: string): string | null {
  let message: string | null = null;
  const result = parseFile(path, '\n', {
    budgetMs: 0,
    onFailure: failure => { message = failure.message; },
  });
  if (result === null) return message ?? 'parseFile returned null';
  return null;
}

describe('every language query compiles against its installed grammar', () => {
  it('has a probe path for every language with a query', () => {
    expect(queriedLanguages.filter(language => !PROBE_PATHS[language])).toEqual([]);
  });

  it('compiles every installed grammar\'s query', () => {
    const failures: string[] = [];
    const checked: SupportedLanguages[] = [];
    for (const language of queriedLanguages) {
      const path = PROBE_PATHS[language]!;
      // An optional grammar with no build for this platform is simply absent.
      if (!isGrammarSupported(path)) continue;
      checked.push(language);
      const error = compileError(path);
      if (error) failures.push(`${language}: ${error}`);
    }
    // TSX goes through its own grammar with the TypeScript query.
    const tsxError = compileError('probe.tsx');
    if (tsxError) failures.push(`tsx: ${tsxError}`);

    expect(failures).toEqual([]);
    expect(checked).toEqual(expect.arrayContaining([...REQUIRED_GRAMMARS]));
  });
});
