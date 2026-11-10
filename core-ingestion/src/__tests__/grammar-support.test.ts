// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { isGrammarSupported, parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

// Keep a sample for every language, including optional grammars. The record
// makes adding a language require extending this consistency check as well.
const samples: Record<SupportedLanguages, [string, string]> = {
  [SupportedLanguages.TypeScript]: ['a.ts', 'export function a() {}'],
  [SupportedLanguages.JavaScript]: ['a.js', 'function a() {}'],
  [SupportedLanguages.Python]: ['a.py', 'def a():\n    pass\n'],
  [SupportedLanguages.Java]: ['A.java', 'class A {}'],
  [SupportedLanguages.C]: ['a.c', 'int a(void) { return 1; }'],
  [SupportedLanguages.CPlusPlus]: ['a.cpp', 'class A {};'],
  [SupportedLanguages.CSharp]: ['A.cs', 'class A {}'],
  [SupportedLanguages.Go]: ['a.go', 'package a\nfunc A() {}\n'],
  [SupportedLanguages.Ruby]: ['a.rb', 'def a\nend\n'],
  [SupportedLanguages.Rust]: ['a.rs', 'fn a() {}'],
  [SupportedLanguages.PHP]: ['a.php', '<?php function a() {}'],
  [SupportedLanguages.Kotlin]: ['a.kt', 'fun a() {}'],
  [SupportedLanguages.Swift]: ['a.swift', 'func a() {}'],
  [SupportedLanguages.Scala]: ['A.scala', 'object A {}'],
  [SupportedLanguages.YAML]: ['a.yaml', 'name: a\n'],
  [SupportedLanguages.Dockerfile]: ['Dockerfile', 'FROM alpine\n'],
  [SupportedLanguages.SQL]: ['a.sql', 'CREATE TABLE a (id INT);'],
  [SupportedLanguages.JSON]: ['a.json', '{"name":"a"}'],
  [SupportedLanguages.TOML]: ['a.toml', '[a]\nname = "a"\n'],
  [SupportedLanguages.Markdown]: ['a.md', '# A\n'],
  [SupportedLanguages.R]: ['a.r', 'a <- function() {}'],
  [SupportedLanguages.SAS]: ['a.sas', 'data a; run;'],
  [SupportedLanguages.Elixir]: ['a.ex', 'defmodule A do\nend\n'],
  [SupportedLanguages.Makefile]: ['Makefile', 'a:\n\techo a\n'],
  [SupportedLanguages.Lua]: ['a.lua', 'function a() end'],
  [SupportedLanguages.Bash]: ['a.sh', 'a() { echo a; }'],
  [SupportedLanguages.PowerShell]: ['a.ps1', 'function A {}'],
  [SupportedLanguages.Haskell]: ['a.hs', 'a = 1\n'],
  [SupportedLanguages.Zig]: ['a.zig', 'fn a() void {}'],
  [SupportedLanguages.HTML]: ['a.html', '<div id="a"></div>'],
  [SupportedLanguages.XML]: ['a.xml', '<a/>'],
  [SupportedLanguages.HCL]: ['a.hcl', 'variable "a" {}'],
  [SupportedLanguages.CSS]: ['a.css', '.a { color: red; }'],
  [SupportedLanguages.LaTeX]: ['a.tex', '\\section{A}\n'],
  [SupportedLanguages.Proto]: ['a.proto', 'message A { int32 x = 1; }\n'],
};

describe('grammar support matches parser availability', () => {
  it('covers every language', () => {
    expect(Object.keys(samples).sort()).toEqual(Object.values(SupportedLanguages).sort());
  });

  it.each(Object.entries(samples))('%s reports support whenever parsing succeeds', (language, [path, source]) => {
    const result = parseFile(path, source);
    if (result !== null) {
      expect(result.language).toBe(language);
      expect(isGrammarSupported(path)).toBe(true);
    }
  });

  it('supports Protocol Buffers without a tree-sitter grammar', () => {
    const [path, source] = samples[SupportedLanguages.Proto];
    expect(parseFile(path, source)).not.toBeNull();
    expect(isGrammarSupported(path)).toBe(true);
  });

  it('supports TSX and rejects unknown extensions', () => {
    expect(parseFile('a.tsx', 'const a = <div />;')).not.toBeNull();
    expect(isGrammarSupported('a.tsx')).toBe(true);
    expect(parseFile('a.txt', 'text')).toBeNull();
    expect(isGrammarSupported('a.txt')).toBe(false);
  });
});
