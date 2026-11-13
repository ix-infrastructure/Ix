// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { buildPatch } from '../patch-builder.js';
import { EDGE_PREDICATES, NODE_KINDS, type PatchOp } from '../schema.js';

/**
 * `schema.ts` claims to list every node kind and edge predicate a patch can
 * write, and every op shape. These samples cover each parser family (code,
 * config, docs, SQL, proto, LaTeX, Dockerfile, an outside-package call); a
 * kind or predicate the builder emits that the schema does not list fails
 * here, and so does a list entry nothing emits.
 */

const SAMPLES: Record<string, string> = {
  '/repo/src/shapes.ts': `
import { helper } from './helper';
export const LIMIT = 3;
export interface Shape { area(): number }
export class Square implements Shape {
  constructor(private side: number) {}
  area(): number { return helper(this.side); }
}
export class Cube extends Square {}
export function make(): Shape { return new Square(LIMIT); }
`,
  '/repo/src/macros.rs': `
macro_rules! twice { ($e:expr) => { $e * 2 }; }
trait Named { fn name(&self) -> String; }
mod inner { pub fn f() {} }
`,
  '/repo/R/use.R': `
run <- function(df) { dplyr::filter(df, x > 1) }
`,
  '/repo/config/app.yaml': 'server:\n  port: 8080\n',
  '/repo/config/app.toml': '[db]\nhost = "x"\n',
  '/repo/docs/guide.md': '---\ntitle: Guide\n---\n# Intro\n\nText.\n\n## Usage\n\nMore.\n',
  '/repo/db/schema.sql': 'CREATE TABLE users (id INT);\nCREATE VIEW v AS SELECT * FROM users;\nCREATE INDEX ix ON users (id);\nCREATE FUNCTION f() RETURNS INT AS $$ SELECT 1 $$ LANGUAGE sql;\n',
  '/repo/api/api.proto': 'syntax = "proto3";\npackage demo;\nmessage Req { string id = 1; }\nservice Api { rpc Get (Req) returns (Req); }\n',
  '/repo/paper/main.tex': '\\documentclass{article}\n\\newcommand{\\foo}{x}\n\\begin{document}\n\\section{One}\\label{sec:one}\n\\begin{theorem}x\\end{theorem}\n\\end{document}\n',
  '/repo/Dockerfile': 'FROM node:22 AS build\nRUN npm ci\nFROM alpine\nCOPY --from=build /app /app\n',
};

function opsOf(filePath: string, source: string): PatchOp[] {
  const result = parseFile(filePath, source);
  if (!result) throw new Error(`no parse result for ${filePath}`);
  return buildPatch(result, 'hash', 'ws').ops;
}

const allOps = Object.entries(SAMPLES).flatMap(([file, source]) => opsOf(file, source));

describe('graph patch schema', () => {
  it('lists each kind and predicate once', () => {
    expect(new Set(NODE_KINDS).size).toBe(NODE_KINDS.length);
    expect(new Set(EDGE_PREDICATES).size).toBe(EDGE_PREDICATES.length);
  });

  it('lists every node kind the builder writes', () => {
    const written = new Set<string>();
    for (const op of allOps) if (op.type === 'UpsertNode') written.add(op.kind);
    expect([...written].filter((kind) => !(NODE_KINDS as readonly string[]).includes(kind))).toEqual([]);
    // Everything but the GitHub kinds, which the CLI writes, is reached here,
    // so an entry nothing emits shows up too.
    const github = new Set(['intent', 'doc', 'decision']);
    expect(NODE_KINDS.filter((kind) => !github.has(kind) && !written.has(kind))).toEqual([]);
  });

  it('lists every edge predicate the builder writes', () => {
    const written = new Set<string>();
    for (const op of allOps) if (op.type === 'UpsertEdge') written.add(op.predicate);
    expect([...written].filter((p) => !(EDGE_PREDICATES as readonly string[]).includes(p))).toEqual([]);
    expect(EDGE_PREDICATES.filter((p) => !written.has(p))).toEqual([]);
  });

  it('writes each op with exactly the fields its shape names', () => {
    const fields: Record<string, string[]> = {
      UpsertNode: ['attrs', 'id', 'kind', 'name', 'type'],
      UpsertEdge: ['attrs', 'dst', 'id', 'predicate', 'src', 'type'],
      AssertClaim: ['confidence', 'entityId', 'field', 'type', 'value'],
    };
    const seen = new Set<string>();
    for (const op of allOps) {
      seen.add(op.type);
      expect(Object.keys(op).sort(), op.type).toEqual(fields[op.type]);
    }
    expect([...seen].sort()).toEqual(Object.keys(fields).sort());
  });

  it('gives symbol, file, chunk and external nodes their documented attrs', () => {
    const nodes = allOps.filter((op) => op.type === 'UpsertNode');
    const attrKeys = (kind: string, name?: string): string[] => {
      const node = nodes.find((n) => n.kind === kind && (name === undefined || n.name === name));
      if (!node) throw new Error(`no ${kind} node`);
      return Object.keys(node.attrs).sort();
    };
    expect(attrKeys('function', 'make')).toEqual(['language', 'line_end', 'line_start', 'role', 'role_source']);
    expect(attrKeys('config_entry', 'port')).toEqual(['language', 'line_end', 'line_start', 'role', 'role_source']);
    expect(attrKeys('file', 'shapes.ts')).toEqual(
      ['language', 'line_end', 'line_start', 'role', 'role_confidence', 'role_signals']);
    expect(attrKeys('chunk')).toEqual([
      'chunk_kind', 'content_hash', 'end_byte', 'end_line', 'file_uri', 'language', 'parser_version',
      'start_byte', 'start_line',
    ]);
    expect(attrKeys('function', 'filter')).toEqual(['external', 'language', 'package']);
  });
});
