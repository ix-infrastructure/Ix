---
title: What is Ix?
description: Ix turns a repository into a persistent graph that people and coding agents can query.
---

Ix parses your repository into a persistent **system graph** of symbols, calls, imports and the relationships
between them. You and your coding agents query that graph instead of grepping and reading files.

Ask what a symbol is and what it touches, how a request flows through the code, or what breaks if you change a
function. Ix answers from real edges in the graph, and each answer covers one symbol or flow instead of whole files.

## Why a graph

| | Without Ix | With Ix |
|---|---|---|
| **Finding things** | Search, read, search again | Query a structured graph |
| **Architecture** | Re-derived every session | Mapped once, kept |
| **Agent context** | Whole files pasted into the prompt | Bounded structural slices |
| **Between sessions** | Context is lost | The graph persists |
| **Relationships** | Inferred from fragments | Read from real edges |

## The model: map, structure, retrieve, remember

| Step | What happens |
|---|---|
| **Map** | `ix map .` parses the repo with tree-sitter and extracts symbols, calls and imports. |
| **Structure** | Those become nodes and edges in a graph of what calls, contains and imports what. |
| **Retrieve** | Commands return bounded answers about one symbol or flow, not whole files. |
| **Remember** | The graph is stored locally and survives between sessions and agent runs. |

## Results

Across our own development work, querying the graph instead of feeding files into the prompt cut token use by
**30–99.7%**. The saving varies widely with the task and the size of the repo. These are internal measurements, not
a published benchmark.

The saving comes from answer size. `ix explain AuthService` returns that symbol and its immediate relationships.
Answering the same question by reading the file and every file it imports costs far more, and costs it again next
session. `ix savings` reports what the graph has saved you so far.

## What Ix is not

Ix answers **structural** questions about code. It does not answer prose questions ("why did we choose this
design?"). It isn't a replacement for reading code when you need the details of an implementation. Use
[`ix read`](/reference/commands/#finding-and-understanding-code) for that once the graph has shown you where to look.

## Next steps

- [Install Ix](/getting-started/installation/)
- [Map your first repository](/getting-started/quickstart/)
- [Connect your AI agent](/integrations/overview/)
