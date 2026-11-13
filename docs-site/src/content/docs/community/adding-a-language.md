---
title: Adding a language
description: The files to change, the queries and tests to write, and the checks to run when Ix learns a new language.
---

Ix parses source in [`core-ingestion/`](https://github.com/ix-infrastructure/Ix/tree/main/core-ingestion). Most
languages use a [tree-sitter](https://tree-sitter.github.io/) grammar and a query that names what to extract. Formats
with no useful grammar (YAML, SQL, Markdown and the rest) have a small hand-written parser instead. This page covers
both. Set up the repository first as described in [Contributing](/community/contributing/).

## The files to change

For a language parsed with a tree-sitter grammar:

1. **`core-ingestion/package.json`**: add the grammar package. Put it under `dependencies` only if it installs on
   every platform Ix supports. Otherwise put it under `optionalDependencies` (see
   [Optional grammars](#optional-grammars)).
2. **`core-ingestion/src/languages.ts`**: add a member to the `SupportedLanguages` enum, and map each file extension
   to it in `EXT_MAP`. A file recognized by its whole name rather than its extension (like `Makefile`) goes in
   `FILE_NAME_MAP`.
3. **`ix-cli/src/cli/supported-extensions.ts`**: add the same extensions to `SUPPORTED_EXTENSIONS` (and whole file
   names to `SUPPORTED_FILE_NAMES`). This is the list `ix map` and `ix watch` walk, so a file type missing here is
   never parsed. `extension-parity.test.ts` fails if the two lists differ.
4. **`core-ingestion/src/index.ts`**: load the grammar and add it to `GRAMMAR_MAP`. If the language has built-in
   functions that should not become call edges, add them to `builtinsForLanguage`.
5. **`core-ingestion/src/queries.ts`**: write the query (see [Writing the query](#writing-the-query)) and add it to
   `LANGUAGE_QUERIES`.
6. **Tests**: see [Testing](#testing).
7. **Docs**: give the new enum value a display label in `LABELS` in `ix-cli/scripts/check-language-docs.mjs`, then
   run `node scripts/check-language-docs.mjs --write` from `ix-cli/`. That regenerates the language lists in
   `README.md` and on the [Supported languages](/reference/languages/) page and updates every language count.

For a format with a hand-written parser, skip steps 1, 4 and 5. Write a `parse<Format>File(filePath, source)`
function in `core-ingestion/src/index.ts` that returns a `FileParseResult`, add it to `HAND_PARSERS`, and map the
format to `''` in `LANGUAGE_QUERIES`. The format then appears under "Config and data formats" in the generated lists.
Add a row for it to the format table on the [Supported languages](/reference/languages/) page saying what it
extracts. The check fails until that row exists.

`SupportedLanguages` keys several `Record` types, including `LANGUAGE_QUERIES` and the smoke test's samples. Run
`npm run typecheck` in `core-ingestion/` and `ix-cli/` after adding the member; it lists the maps that still need an
entry.

## Writing the query

A query is a set of tree-sitter S-expression patterns. The capture names say what each match is:

| Capture | Meaning |
|---|---|
| `@definition.<kind>` with `@name` | A symbol. `<kind>` is `class`, `interface`, `function`, `method`, `struct`, `enum`, `trait`, `module`, `const`, `type`, `macro` and others; `DEFINITION_KIND_MAP` in `index.ts` maps each one to a graph node kind. |
| `@call` with `@call.name` | A call. The name is matched against the definitions to make a CALLS edge. |
| `@import` with `@import.source` | An import. The source is the module or path being imported. |
| `@heritage` with `@heritage.class` and `@heritage.extends` or `@heritage.implements` | Inheritance. |

`LUA_QUERIES` in `queries.ts` is a short, complete example to start from. To find the node types and field names a
grammar produces, parse a sample file and print the tree, for example with the tree-sitter CLI's `tree-sitter parse`
or with `parser.parse(source).rootNode.toString()` in a Node script. A query that names a node type or field the grammar doesn't have fails to compile, and then every
file in the language goes unparsed. `queries.compile.test.ts` catches that.

## Optional grammars

Grammars are native modules. Some have no prebuilt binary for every OS and CPU, so a required dependency would break
`npm install` on those machines. Those grammars are `optionalDependencies` and load through one of two helpers in
`index.ts`:

- `tryLoadGrammar(language, pkg)` for CommonJS packages, and
- `tryImportGrammar(language, pkg)` for packages that ship ES module bindings.

Both return `null` instead of throwing when the grammar can't load, and record why. Add the grammar to `GRAMMAR_MAP`
only when it loaded, as the existing entries do: `...(Lua ? { [SupportedLanguages.Lua]: Lua } : {})`. On a machine
without it, files in that language are counted as unparsed, and `ix map` and `ix doctor` name the grammar and the
reason. Read the comment at the top of `index.ts` before choosing between the bare package name and a path to its
binding: it explains which package shapes make Node print a deprecation warning.

Add an optional grammar to `OPTIONAL_GRAMMAR_PACKAGES` in `core-ingestion/src/__tests__/helpers/grammars.ts`, or a
required one to `REQUIRED_GRAMMARS` in the same file. The tests use that list to decide whether the grammar has to
load on the machine they run on.

## Testing

Run the core-ingestion tests with `cd core-ingestion && npm test`, and the CLI tests with `cd ix-cli && npm test`.
For a new language, add:

- **`core-ingestion/src/__tests__/queries.<language>.test.ts`**: parse small snippets with `parseFile` and check the
  entities and relationships you expect, by name and kind. The existing `queries.*.test.ts` files show the pattern.
- **A sample in `languages.smoke.test.ts`**: a few lines of real source that must yield at least one entity. It
  catches a grammar upgrade that renames a node type.
- **A probe path in `queries.compile.test.ts`**, for a language with a query.

## When the extractor version changes

Each ingest patch is stamped with the extractor version (`extractorName()` in `core-ingestion/src/patch-builder.ts`).
`ix map` re-parses only files that changed since the last run, so a file that did not change keeps what the old parser
extracted until the extractor version changes. When it changes, the next `ix map` re-ingests every file once.

- Adding a new language or extension normally needs no change: those files were never in the graph, so the next
  `ix map` ingests them as new files.
- Changing what an existing parser or query extracts from files already in the graph (new kinds, renamed nodes, new
  edges) needs one, or existing graphs keep the old output for unchanged files.

The extractor version is the maintainers' decision. Don't change it in your pull request. Say in the description
that the change alters existing output and needs a new extractor version.
