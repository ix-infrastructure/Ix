// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { isGrammarSupported, parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

// `ix verify` picks the files it re-parses with isGrammarSupported, so a format
// parseFile handles but isGrammarSupported rejects is never verified (#959:
// every .proto file). Parse a small sample per language and require that
// isGrammarSupported agrees whenever parseFile produced a result.

// One sample per language. The guard test below fails when a language is added
// to SupportedLanguages without an entry here.
const SAMPLES: Partial<Record<SupportedLanguages, { path: string; source: string }>> = {
  [SupportedLanguages.JavaScript]: { path: 'a.js', source: 'function f() {}\n' },
  [SupportedLanguages.TypeScript]: { path: 'a.ts', source: 'function f(): void {}\n' },
  [SupportedLanguages.Python]: { path: 'a.py', source: 'def f():\n    pass\n' },
  [SupportedLanguages.Java]: { path: 'A.java', source: 'class A { void f() {} }\n' },
  [SupportedLanguages.C]: { path: 'a.c', source: 'int f(void) { return 0; }\n' },
  [SupportedLanguages.CPlusPlus]: { path: 'a.cpp', source: 'class A { public: void f(); };\n' },
  [SupportedLanguages.CSharp]: { path: 'A.cs', source: 'class A { void F() {} }\n' },
  [SupportedLanguages.Go]: { path: 'a.go', source: 'package a\n\nfunc F() {}\n' },
  [SupportedLanguages.Ruby]: { path: 'a.rb', source: 'def f\nend\n' },
  [SupportedLanguages.Rust]: { path: 'a.rs', source: 'fn f() {}\n' },
  [SupportedLanguages.PHP]: { path: 'a.php', source: '<?php function f() {}\n' },
  [SupportedLanguages.Kotlin]: { path: 'A.kt', source: 'fun f() {}\n' },
  [SupportedLanguages.Swift]: { path: 'A.swift', source: 'func f() {}\n' },
  [SupportedLanguages.Scala]: { path: 'A.scala', source: 'object A { def f(): Unit = () }\n' },
  [SupportedLanguages.YAML]: { path: 'a.yaml', source: 'key: value\n' },
  [SupportedLanguages.Dockerfile]: { path: 'Dockerfile', source: 'FROM node:22\n' },
  [SupportedLanguages.SQL]: { path: 'a.sql', source: 'CREATE TABLE t (id INT);\n' },
  [SupportedLanguages.JSON]: { path: 'a.json', source: '{"key": 1}\n' },
  [SupportedLanguages.TOML]: { path: 'a.toml', source: '[section]\nkey = 1\n' },
  [SupportedLanguages.Markdown]: { path: 'a.md', source: '# Title\n\ntext\n' },
  [SupportedLanguages.R]: { path: 'a.r', source: 'f <- function() {}\n' },
  [SupportedLanguages.SAS]: { path: 'a.sas', source: '%macro m; %mend;\n' },
  [SupportedLanguages.Elixir]: { path: 'a.ex', source: 'defmodule A do\n  def f, do: 1\nend\n' },
  [SupportedLanguages.Makefile]: { path: 'Makefile', source: 'all:\n\techo hi\n' },
  [SupportedLanguages.Lua]: { path: 'a.lua', source: 'function f() end\n' },
  [SupportedLanguages.Bash]: { path: 'a.sh', source: 'f() { echo hi; }\n' },
  [SupportedLanguages.PowerShell]: { path: 'a.ps1', source: 'function F { }\n' },
  [SupportedLanguages.Haskell]: { path: 'A.hs', source: 'f :: Int\nf = 1\n' },
  [SupportedLanguages.Zig]: { path: 'a.zig', source: 'fn f() void {}\n' },
  [SupportedLanguages.HTML]: { path: 'a.html', source: '<html><body></body></html>\n' },
  [SupportedLanguages.XML]: { path: 'a.xml', source: '<root><child/></root>\n' },
  [SupportedLanguages.HCL]: { path: 'a.tf', source: 'resource "a" "b" {}\n' },
  [SupportedLanguages.CSS]: { path: 'a.css', source: '.a { color: red; }\n' },
  [SupportedLanguages.LaTeX]: { path: 'a.tex', source: '\\documentclass{article}\n\\section{Intro}\n' },
  [SupportedLanguages.Proto]: { path: 'a.proto', source: 'message A { int32 x = 1; }\n' },
};

// Paths whose grammar is not the one languageFromPath names: TSX has its own
// grammar, and a .h that looks like C++ is parsed as C++.
const EXTRA_SAMPLES = [
  { path: 'a.tsx', source: 'const A = () => <div />;\n' },
  { path: 'a.h', source: 'class A { public: void f(); };\n' },
];

describe('isGrammarSupported agrees with parseFile', () => {
  it('has a sample for every language', () => {
    const missing = Object.values(SupportedLanguages).filter(language => !SAMPLES[language]);
    expect(missing).toEqual([]);
  });

  it('is true for every path parseFile returns a result for', () => {
    const samples = [...Object.values(SAMPLES), ...EXTRA_SAMPLES];
    const parsed = samples.filter(({ path, source }) => parseFile(path, source, { budgetMs: 0 }) !== null);
    // Guards against a sample set that silently parses nothing, which would make
    // the assertion below vacuously true.
    expect(parsed.length).toBeGreaterThan(30);
    expect(parsed.filter(({ path }) => !isGrammarSupported(path)).map(({ path }) => path)).toEqual([]);
  });

  it('accepts Protocol Buffers', () => {
    expect(isGrammarSupported('a.proto')).toBe(true);
    expect(isGrammarSupported('nested/dir/api.PROTO')).toBe(true);
  });

  it('rejects paths no parser handles', () => {
    expect(isGrammarSupported('a.txt')).toBe(false);
    expect(isGrammarSupported('README')).toBe(false);
    expect(parseFile('a.txt', 'text\n')).toBeNull();
  });
});
