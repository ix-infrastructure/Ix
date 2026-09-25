---
title: Supported languages
description: The languages Ix extracts symbols, calls and imports from.
---

Ix extracts symbols, calls and imports from these languages:

| | | | |
|---|---|---|---|
| JavaScript | TypeScript | Python | Java |
| C | C++ | C# | Go |
| Ruby | Rust | PHP | Kotlin |
| Swift | Scala | R | SAS |
| Elixir | Haskell | Zig | Lua |
| Bash | PowerShell | HTML | XML |
| CSS | HCL / Terraform | Makefile | |

## Special cases

- **CUDA** (`.cu`, `.cuh`) is parsed with the C++ grammar, including kernel-launch syntax
  (`kernel<<<grid, block>>>(args)`), so host-to-kernel calls appear in the graph.
- **Python stubs** (`.pyi`) are parsed as Python.

## Config and data formats

These are recognized as files in the graph, but no symbols are extracted from them:

YAML · JSON · TOML · SQL · Protocol Buffers · Dockerfile · Markdown · LaTeX

## Adding a language

Parsing lives in
[`core-ingestion/`](https://github.com/ix-infrastructure/Ix/tree/main/core-ingestion), built on tree-sitter. See
[Contributing](/community/contributing/) to get started.
