---
title: Supported languages
description: The languages Ix extracts symbols, calls and imports from, and what it extracts from config and data files.
---

Ix extracts symbols, calls and imports from these 27 languages:

<!-- languages:code:start (generated from SupportedLanguages by ix-cli/scripts/check-language-docs.mjs --write) -->
| | | | |
|---|---|---|---|
| JavaScript | TypeScript | Python | Java |
| C | C++ | C# | Go |
| Ruby | Rust | PHP | Kotlin |
| Swift | Scala | R | SAS |
| Elixir | Makefile | Lua | Bash |
| PowerShell | Haskell | Zig | HTML |
| XML | HCL / Terraform | CSS | |
<!-- languages:code:end -->

## Special cases

- **CUDA** (`.cu`, `.cuh`) is parsed with the C++ grammar, including kernel-launch syntax
  (`kernel<<<grid, block>>>(args)`), so host-to-kernel calls appear in the graph.
- **Python stubs** (`.pyi`) are parsed as Python.

## Config and data formats

These formats are read by small purpose-built parsers rather than a tree-sitter grammar. They have no calls, but
each one adds named nodes to the graph, so `ix search`, `ix locate` and `ix explain` find a config key, a heading, a
SQL table or a proto message like any other symbol. The node kind is given in brackets.

| Format | What Ix extracts |
|---|---|
| **YAML** | Every mapping key (`config_entry`), nested under its parent key. |
| **JSON** | Every object key at any depth (`config_entry`), nested under its parent key. Keys are not tied to a line. A file that is not strict JSON (comments, trailing commas) is kept as a file with no keys. |
| **TOML** | Every `[table]` and `[[array of tables]]` header and every `key = value` (`config_entry`), nested under its table. Dotted table names add each level. |
| **SQL** | `CREATE TABLE` (`table`), `CREATE VIEW` (`view`), `CREATE FUNCTION`, `PROCEDURE` and `TRIGGER` (`function`) and `CREATE INDEX` (`config_entry`). Views, functions, procedures and triggers reference the tables they read or write, and an index references the table it is on. |
| **Protocol Buffers** | `message` and `enum` definitions (`class`), `service` definitions (`interface`), their `rpc` methods (`method`) and the `package` (`module`). Imports link files, and a message field or rpc request and response type references the message it names. |
| **Dockerfile** | Each `FROM` build stage (`config`, named by its `AS` alias or `stage-N`), its base image as an import (`module`), and every other instruction inside the stage (`config_entry`, for example `run` or `copy:src/`). `COPY --from=<stage>` imports the stage it copies from. |
| **Markdown** | Every heading, written with `#`, as an underlined line or as `<h1>`–`<h6>` (`heading`), nested under the heading above it, plus the YAML front matter (`frontmatter`). Each heading's section is a searchable chunk. |
| **LaTeX** | Sectioning commands from `\part` to `\subparagraph` (`section`), environments used (`environment`), macros from `\newcommand`, `\def` and friends (`function`), `\newenvironment` and `\newtheorem` (`class`), `\label` and `\bibitem` keys (`label`), and packages, classes and included files as imports (`module`). `\ref` and `\cite` link the enclosing section to the key they name. |

## Adding a language

[Adding a language](/community/adding-a-language/) lists the files to change, how to write and test a tree-sitter
query, how optional grammars are loaded, and when the extractor version has to change. The parsers live in
[`core-ingestion/`](https://github.com/ix-infrastructure/Ix/tree/main/core-ingestion).
