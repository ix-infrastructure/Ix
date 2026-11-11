// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { isGrammarSupported, parseFile } from '../index.js';
import { SupportedLanguages, languageFromPath } from '../languages.js';
import { LANGUAGE_QUERIES } from '../queries.js';
import {
  OPTIONAL_GRAMMAR_PACKAGES,
  REQUIRED_GRAMMARS,
  optionalGrammarExpected,
} from './helpers/grammars.js';

// Parse a few lines of real source for every language Ix supports and expect
// at least one entity besides the file itself. A grammar upgrade that renames
// a node type, or a query edit that stops matching, then fails here instead of
// quietly leaving a whole language unparsed (#958).
//
// Optional grammars load through a silent try/catch, so this test also decides
// which of them must have loaded on this machine (see optionalGrammarExpected)
// and prints which ones it exercised, so each CI leg's log says what it covered.

interface Sample { path: string; source: string }

const SAMPLES: Record<SupportedLanguages, Sample> = {
  [SupportedLanguages.TypeScript]: {
    path: 'probe.ts',
    source: 'import { readFile } from "node:fs";\n\nexport class Store {\n  load(path: string) { return readFile(path); }\n}\n',
  },
  [SupportedLanguages.JavaScript]: {
    path: 'probe.js',
    source: 'import { join } from "node:path";\n\nexport function resolvePath(dir, name) {\n  return join(dir, name);\n}\n',
  },
  [SupportedLanguages.Python]: {
    path: 'probe.py',
    source: 'import os\n\nclass Store:\n    def load(self, path):\n        return os.path.join(path)\n',
  },
  [SupportedLanguages.Java]: {
    path: 'Probe.java',
    source: 'package com.example;\n\npublic class Probe {\n    public int run() { return helper(); }\n}\n',
  },
  [SupportedLanguages.C]: {
    path: 'probe.c',
    source: '#include <stdio.h>\n\nint add(int a, int b) {\n    return a + b;\n}\n',
  },
  [SupportedLanguages.CPlusPlus]: {
    path: 'probe.cpp',
    source: '#include <string>\n\nclass Store {\n public:\n  int load() { return 0; }\n};\n',
  },
  [SupportedLanguages.CSharp]: {
    path: 'Probe.cs',
    source: 'using System;\n\nnamespace Acme {\n    public class Probe { public void Run() { Console.WriteLine(); } }\n}\n',
  },
  [SupportedLanguages.Go]: {
    path: 'probe.go',
    source: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n',
  },
  [SupportedLanguages.Ruby]: {
    path: 'probe.rb',
    source: "require 'json'\n\nclass Store\n  def load(path) = JSON.parse(path)\nend\n",
  },
  [SupportedLanguages.Rust]: {
    path: 'probe.rs',
    source: 'use std::fs;\n\npub struct Store;\n\nfn load() -> String { fs::read_to_string("x").unwrap() }\n',
  },
  [SupportedLanguages.PHP]: {
    path: 'probe.php',
    source: '<?php\nnamespace App;\n\nclass Store {\n    public function load() { return helper(); }\n}\n',
  },
  [SupportedLanguages.Kotlin]: {
    path: 'Probe.kt',
    source: 'package com.example\n\nimport kotlin.io.println\n\nclass Probe { fun run() = println("hi") }\n',
  },
  [SupportedLanguages.Swift]: {
    path: 'Probe.swift',
    source: 'import Foundation\n\nstruct Probe {\n    func run() -> Int { return 1 }\n}\n',
  },
  [SupportedLanguages.Scala]: {
    path: 'Probe.scala',
    source: 'package com.example\n\nimport scala.util.Try\n\nobject Probe { def run(): Int = 1 }\n',
  },
  [SupportedLanguages.YAML]: {
    path: 'probe.yaml',
    source: 'name: probe\nservices:\n  web:\n    image: nginx\n    ports: ["80:80"]\n',
  },
  [SupportedLanguages.Dockerfile]: {
    path: 'Dockerfile',
    source: 'FROM node:22 AS build\nWORKDIR /app\nCOPY . .\nFROM node:22-slim\nCOPY --from=build /app /app\n',
  },
  [SupportedLanguages.SQL]: {
    path: 'probe.sql',
    source: 'CREATE TABLE users (\n  id INT PRIMARY KEY\n);\n\nCREATE VIEW active AS SELECT * FROM users;\n',
  },
  [SupportedLanguages.JSON]: {
    path: 'probe.json',
    source: '{\n  "name": "probe",\n  "version": "1.0.0",\n  "scripts": { "test": "vitest" }\n}\n',
  },
  [SupportedLanguages.TOML]: {
    path: 'probe.toml',
    source: '[package]\nname = "probe"\nversion = "0.1.0"\n\n[dependencies]\n',
  },
  [SupportedLanguages.Markdown]: {
    path: 'probe.md',
    source: '# Probe\n\nIntro text.\n\n## Usage\n\nRun it.\n',
  },
  [SupportedLanguages.R]: {
    path: 'probe.r',
    source: 'library(dplyr)\n\nload_data <- function(path) {\n  read.csv(path)\n}\n',
  },
  [SupportedLanguages.SAS]: {
    path: 'probe.sas',
    source: 'data work.out;\n  set work.in;\nrun;\n\nproc print data=work.out;\nrun;\n',
  },
  [SupportedLanguages.Elixir]: {
    path: 'probe.ex',
    source: 'defmodule Probe do\n  alias Probe.Helper\n\n  def run(x), do: Helper.call(x)\nend\n',
  },
  [SupportedLanguages.Makefile]: {
    path: 'Makefile',
    source: 'CC = gcc\n\nall: build\n\nbuild:\n\t$(CC) -o probe main.c\n',
  },
  [SupportedLanguages.Lua]: {
    path: 'probe.lua',
    source: 'local json = require("json")\n\nlocal function load(path)\n  return json.decode(path)\nend\n',
  },
  [SupportedLanguages.Bash]: {
    path: 'probe.sh',
    source: '#!/bin/bash\nsource ./lib.sh\n\nbuild() {\n  make all\n}\n',
  },
  [SupportedLanguages.PowerShell]: {
    path: 'probe.ps1',
    source: 'Import-Module ./Lib.psm1\n\nfunction Get-Probe {\n    Write-Output "hi"\n}\n',
  },
  [SupportedLanguages.Haskell]: {
    path: 'Probe.hs',
    source: 'module Probe where\n\nimport Data.List (sort)\n\nrun :: [Int] -> [Int]\nrun = sort\n',
  },
  [SupportedLanguages.Zig]: {
    path: 'probe.zig',
    source: 'const std = @import("std");\n\npub fn add(a: i32, b: i32) i32 {\n    return a + b;\n}\n',
  },
  [SupportedLanguages.HTML]: {
    path: 'probe.html',
    source: '<!DOCTYPE html>\n<html>\n<head><script src="app.js"></script></head>\n<body><div id="root"></div></body>\n</html>\n',
  },
  [SupportedLanguages.XML]: {
    path: 'probe.xml',
    source: '<?xml version="1.0"?>\n<Project>\n  <ItemGroup>\n    <ProjectReference Include="../Core/Core.csproj"/>\n  </ItemGroup>\n</Project>\n',
  },
  [SupportedLanguages.HCL]: {
    path: 'probe.tf',
    source: 'resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n\nvariable "region" {}\n',
  },
  [SupportedLanguages.CSS]: {
    path: 'probe.css',
    source: '.header {\n  color: red;\n}\n\n#main { margin: 0; }\n',
  },
  [SupportedLanguages.LaTeX]: {
    path: 'probe.tex',
    source: '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nText.\n\\end{document}\n',
  },
  [SupportedLanguages.Proto]: {
    path: 'probe.proto',
    source: 'syntax = "proto3";\n\npackage probe;\n\nmessage User { string name = 1; }\n',
  },
};

const ALL_LANGUAGES = Object.values(SupportedLanguages);

/** Why the sample did not produce a usable parse, or null when it did. */
function parseProblem(sample: Sample): string | null {
  const failures: string[] = [];
  const result = parseFile(sample.path, sample.source, {
    onFailure: failure => failures.push(failure.message),
  });
  if (failures.length > 0) return failures.join('; ');
  if (result === null) return 'parseFile returned null';
  if (!result.entities.some(entity => entity.kind !== 'file')) {
    return 'no entity besides the file';
  }
  return null;
}

describe('every supported language parses real source', () => {
  it('has a sample for every language, named so it maps back to that language', () => {
    for (const language of ALL_LANGUAGES) {
      expect(languageFromPath(SAMPLES[language].path), language).toBe(language);
    }
  });

  it('knows whether every tree-sitter grammar is required or optional', () => {
    const unclassified = ALL_LANGUAGES.filter(language =>
      LANGUAGE_QUERIES[language].trim() !== ''
      && !REQUIRED_GRAMMARS.includes(language)
      && !OPTIONAL_GRAMMAR_PACKAGES[language]);
    expect(unclassified).toEqual([]);
  });

  it('parses each sample into at least one entity besides the file', async ({ annotate }) => {
    const problems: string[] = [];
    const exercised: string[] = [];
    const skipped: string[] = [];

    for (const language of ALL_LANGUAGES) {
      const sample = SAMPLES[language];
      const optionalPkg = OPTIONAL_GRAMMAR_PACKAGES[language];
      if (!isGrammarSupported(sample.path)) {
        if (!optionalPkg) {
          problems.push(`${language}: required grammar did not load`);
        } else if (optionalGrammarExpected(optionalPkg)) {
          problems.push(`${language}: ${optionalPkg} is installed with a binary for `
            + `${process.platform}-${process.arch} but did not load`);
        } else {
          skipped.push(language);
        }
        continue;
      }
      if (optionalPkg) exercised.push(language);
      const problem = parseProblem(sample);
      if (problem) problems.push(`${language} (${sample.path}): ${problem}`);
    }

    // TSX goes through its own grammar with the TypeScript query.
    const tsxProblem = parseProblem({
      path: 'probe.tsx',
      source: 'import React from "react";\n\nexport function App() {\n  return <div>hi</div>;\n}\n',
    });
    if (tsxProblem) problems.push(`tsx (probe.tsx): ${tsxProblem}`);

    // Reported on every run, so each CI leg's log (and its GitHub Actions
    // annotations) says which optional grammars it actually covered.
    await annotate(`${process.platform}-${process.arch} node ${process.versions.node}: `
      + `optional grammars exercised: ${exercised.join(', ') || 'none'}; `
      + `not installed here: ${skipped.join(', ') || 'none'}`, 'notice');

    expect(problems).toEqual([]);
  });
});
