// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, readFileSync } from 'node:fs';
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
 * compiled at install time. Most grammars ship prebuilds for every platform;
 * tree-sitter-kotlin ships none and tree-sitter-sas none for linux-arm64 or
 * Windows, so those are compiled at install. npm drops an optional dependency
 * whose compile failed, so it has nothing to load. Anything else that fails to
 * load is a bug.
 */
export function optionalGrammarExpected(pkg: string): boolean {
  const dir = installedPackageDir(pkg);
  if (!dir) return false;
  return existsSync(join(dir, 'prebuilds', `${process.platform}-${process.arch}`))
    || existsSync(join(dir, 'build', 'Release'));
}

const coreIngestionRoot = join(import.meta.dirname, '..', '..', '..');

/**
 * The version core-ingestion/package-lock.json pins for every package the
 * parser loads at run time (package.json `dependencies` and
 * `optionalDependencies`: tree-sitter and its grammars), by package name.
 * Read from the lockfile rather than node_modules, so the answer is the same
 * on every platform even where an optional grammar did not install.
 */
export function parserDependencyVersions(root: string = coreIngestionRoot): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string }>;
  };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})].sort();
  const versions: Record<string, string> = {};
  for (const name of names) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`package-lock.json pins no version for ${name}; run npm install in core-ingestion`);
    versions[name] = version;
  }
  return versions;
}
