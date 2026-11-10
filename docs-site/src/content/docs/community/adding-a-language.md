---
title: Adding a language
description: Extend language detection, extraction queries, parser tests and the generated language reference.
---

Parsing lives in `core-ingestion/`. Start with [Contributing](/community/contributing/) for local setup.
The paths and commands below are relative to the repository root unless a command changes directory.
You can run parser tests without the backend.

## Register the language and file discovery

1. Add a string member to `SupportedLanguages` in `core-ingestion/src/languages.ts`.
   This value is the language identifier on parse results; keep existing values stable.
2. Add extensions to `EXT_MAP` in the same file. For special basenames such as `Dockerfile`,
   update `languageFromPath` too, and test both positive and negative examples.
3. Add extensions to `ix-cli/src/cli/supported-extensions.ts` so directory ingestion and watch
   discover the files. Check special basename handling in `ix-cli/src/cli/file-discovery.ts`
   when an extension alone cannot identify a file.
   `core-ingestion/src/__tests__/extension-parity.test.ts` checks that parser and discovery
   extension lists agree.

## Load a grammar or add a text parser

For tree-sitter languages, add the grammar package to `core-ingestion/package.json` and update
`core-ingestion/package-lock.json` with npm. In `core-ingestion/src/index.ts`, load it and add
the correct grammar object to `GRAMMAR_MAP`. Some packages export several grammars; inspect
their exports rather than assuming the package itself is the grammar.

Optional grammars belong in `optionalDependencies`. Load CommonJS bindings with `tryLoadGrammar`;
use `await tryImportGrammar` for ESM bindings, especially those with top-level await. Both helpers
return `null` when loading fails. Conditional entries in `GRAMMAR_MAP` leave unavailable optional
grammars out, and `parseFile` returns `null` for those languages. Keep that fallback quiet.
Use bare package specifiers unless a package's ESM directory entry point needs an explicit binding
filename; check its `main`, `type` and `exports` before copying another grammar's import path.

YAML, JSON, TOML, SQL, Protocol Buffers, Dockerfile, Markdown and LaTeX instead use built-in text
parsers. For a similar format, add a dedicated parser returning `FileParseResult` and dispatch to
it in `parseFile` before the grammar lookup. Preserve line ranges, content chunks and containment
relationships; an enum member alone does not add extraction support.

## Write and test a query

For a tree-sitter language, define a query constant in `core-ingestion/src/queries.ts` and register
it in `LANGUAGE_QUERIES`. Inspect the grammar's `src/node-types.json` and parse a small representative
source file to learn the node and field names. Queries match syntax-tree nodes, not source text.
For example, this pattern is used for JavaScript-style function declarations:

```scheme
(function_declaration
  name: (identifier) @name) @definition.function
```

`@name` supplies the name; `@definition.function` selects the entity kind. Follow existing queries
for other `@definition.*` kinds, `@import.source` with `@import`, `@call.name` with `@call`, and
`@reference.type`. Check the capture handling in `parseFile` before inventing a capture: a query
can compile yet emit nothing if the extractor does not handle its captures.

Add `core-ingestion/src/__tests__/queries.<language>.test.ts`, following an existing language test.
Call `parseFile` with a recognized path and representative source, assert a non-null result and
the expected language, then assert entity names, kinds, line ranges and relationships. Exercise
definitions, nesting, imports and calls where supported, plus comments, strings, malformed input
and constructs that must not match. Calling `parseFile` exercises grammar loading, query compilation
and capture interpretation together. Test relationship resolution when adding new edge semantics.
Run with the grammar installed; a skipped test does not prove the query works.

```bash
cd core-ingestion
npx vitest run src/__tests__/queries.<language>.test.ts --pool threads
npm test
cd ../ix-cli
npm run build
npm run typecheck
npm test
```

Replace `<language>` with the test file's language name. Keep tests under the existing test
directories so the standard Vitest suites and CI discover them.

## Decide whether to bump the extractor

In `core-ingestion/src/patch-builder.ts`, bump the version returned by `extractorName()` whenever
the same source would now yield different graph nodes or edges, including newly supported files
that may already have been ingested. Add the previous name to `PREVIOUS_EXTRACTORS` so old patches
are superseded. Patch IDs include the extractor name, and the backend skips an already applied ID;
the CLI's ingestion baseline also uses the name to trigger re-ingestion of unchanged files.
Test the patch replacement and baseline behavior if you change that contract. Documentation-only
changes do not need a version bump.

## Regenerate the language inventory

With the `ix-cli` development dependencies installed, run from the repository root:

```bash
node ix-cli/scripts/sync-language-docs.mjs --write
node ix-cli/scripts/sync-language-docs.mjs --check
```

The script reads `SupportedLanguages` directly from TypeScript source. It regenerates the tables
in `README.md` and the [language reference](/reference/languages/), and the count in `CLAUDE.md`.
No parser build or native grammar is needed. Add a display-name override in the script only when
an enum member needs a different public label. Describe the new format's extracted constructs in
the language reference as appropriate; the generated inventory does not describe extraction depth.

`ix-cli/test/language-docs.test.mjs` runs the parity check in the normal CLI test suite and rejects
missing or stale inventories, including when a language is added or removed from the enum.
