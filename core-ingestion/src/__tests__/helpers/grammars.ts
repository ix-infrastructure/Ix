// Copyright 2026 Ix Infrastructure Inc.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { SupportedLanguages } from '../../languages.js';

/**
 * Grammars that are regular dependencies of core-ingestion. They are always
 * installed, so a test must fail when one of them does not load rather than
 * skip it.
 */
export const REQUIRED_GRAMMARS: readonly SupportedLanguages[] = [
  SupportedLanguages.TypeScript, SupportedLanguages.JavaScript, SupportedLanguages.Python,
  SupportedLanguages.Java, SupportedLanguages.C, SupportedLanguages.CPlusPlus,
  SupportedLanguages.CSharp, SupportedLanguages.Go, SupportedLanguages.Rust,
  SupportedLanguages.Ruby, SupportedLanguages.PHP, SupportedLanguages.Scala,
  SupportedLanguages.PowerShell,
];

/**
 * Optional grammars (package.json `optionalDependencies`) by the package that
 * provides them. index.ts loads each through a quiet try/catch, so a missing
 * one only shows up as files that never parse.
 */
export const OPTIONAL_GRAMMAR_PACKAGES: Readonly<Partial<Record<SupportedLanguages, string>>> = {
  [SupportedLanguages.Kotlin]: 'tree-sitter-kotlin',
  [SupportedLanguages.Swift]: 'tree-sitter-swift',
  [SupportedLanguages.R]: '@davisvaughan/tree-sitter-r',
  [SupportedLanguages.SAS]: 'tree-sitter-sas',
  [SupportedLanguages.Elixir]: 'tree-sitter-elixir',
  [SupportedLanguages.Makefile]: 'tree-sitter-make',
  [SupportedLanguages.Lua]: '@tree-sitter-grammars/tree-sitter-lua',
  [SupportedLanguages.Bash]: 'tree-sitter-bash',
  [SupportedLanguages.Haskell]: 'tree-sitter-haskell',
  [SupportedLanguages.Zig]: '@tree-sitter-grammars/tree-sitter-zig',
  [SupportedLanguages.HTML]: 'tree-sitter-html',
  [SupportedLanguages.XML]: '@tree-sitter-grammars/tree-sitter-xml',
  [SupportedLanguages.HCL]: '@tree-sitter-grammars/tree-sitter-hcl',
  [SupportedLanguages.CSS]: 'tree-sitter-css',
};

const _require = createRequire(import.meta.url);

function installedPackageDir(pkg: string): string | null {
  // Look for the package directory itself: several grammars declare
  // `"exports"` without `./package.json`, so resolving that subpath throws.
  for (const dir of _require.resolve.paths(pkg) ?? []) {
    const candidate = join(dir, pkg);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/**
 * Whether an optional grammar should load on this machine: npm installed it
 * and it carries a native binary for this platform, either a prebuild or one
 * compiled at install time. npm drops an optional dependency whose install
 * failed, and a package with no prebuild for this OS/arch (tree-sitter-sas on
 * Windows) has nothing to load. Anything else that fails to load is a bug.
 */
export function optionalGrammarExpected(pkg: string): boolean {
  const dir = installedPackageDir(pkg);
  if (!dir) return false;
  return existsSync(join(dir, 'prebuilds', `${process.platform}-${process.arch}`))
    || existsSync(join(dir, 'build', 'Release'));
}
