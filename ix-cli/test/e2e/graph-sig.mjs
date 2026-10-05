// Copyright 2026 Ix Infrastructure Inc.

// Graph signature of one workspace's live graph, read straight from ArangoDB.
//
// Node and edge ids are content hashes that change with paths and extractor
// versions, so two graphs of the same tree are compared by NAME instead:
//   node  kind|name|source_uri|line_start|line_end
//   edge  predicate|<src kind:name@uri>|<dst kind:name@uri>|source_uri
// An edge whose endpoint is not a live node of the workspace prints as
// "?<first 8 of id>", so dangling edges show up in a diff instead of vanishing.
// Region nodes and IN_REGION edges are left out: they belong to the map, not
// to the code graph.
//
// Module use (the harness):   graphSignature(arangoUrl, workspaceId), diffSignatures(a, b)
// Command line:
//   node graph-sig.mjs sig  <workspace_id> [out.json]   # prints counts + hashes
//   node graph-sig.mjs diff <a.json> <b.json> [limit]   # prints what differs
// The ArangoDB URL comes from IX_E2E_ARANGO_URL (default http://127.0.0.1:8729).

/* global fetch, process, console */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DATABASE = "ix_memory";

const NODES_AQL = `FOR n IN nodes
  FILTER n.workspace_id == @w AND n.deleted_rev == null AND n.kind != "region"
  RETURN [n.id, n.kind, n.name, n.provenance.source_uri, n.attrs.line_start, n.attrs.line_end]`;

const EDGES_AQL = `FOR e IN edges
  FILTER e.workspace_id == @w AND e.deleted_rev == null AND e.predicate != "IN_REGION"
  RETURN [e.predicate, e.src, e.dst, e.provenance.source_uri]`;

async function post(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`ArangoDB ${res.status} at ${url}: ${json.errorMessage ?? res.statusText}`);
  }
  return json;
}

/** Run one AQL query to completion, following the cursor. */
export async function aql(arangoUrl, query, bindVars) {
  const base = `${arangoUrl.replace(/\/$/, "")}/_db/${DATABASE}/_api/cursor`;
  let page = await post(base, { query, bindVars, batchSize: 20000 });
  const out = [...page.result];
  while (page.hasMore) {
    page = await post(`${base}/${page.id}`);
    out.push(...page.result);
  }
  return out;
}

// String(null) is "null" and String(undefined) is "undefined" -- the Python
// tool printed "None" for both. Normalise so a missing attribute reads the
// same whichever way the backend omitted it.
const cell = (v) => (v === null || v === undefined ? "None" : String(v));

function sorted(list) {
  // Plain code-unit order, the same order Python's sorted() gives.
  return [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function hashOf(lines) {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}

/**
 * Signature of the live graph of `workspaceId`:
 * `{ nodes: string[], edges: string[] }`, each sorted.
 */
export async function graphSignature(arangoUrl, workspaceId) {
  const nodes = await aql(arangoUrl, NODES_AQL, { w: workspaceId });
  const edges = await aql(arangoUrl, EDGES_AQL, { w: workspaceId });
  const byId = new Map(nodes.map((n) => [n[0], n]));
  const name = (id) => {
    const n = byId.get(id);
    return n ? `${n[1]}:${n[2]}@${n[3]}` : `?${String(id).slice(0, 8)}`;
  };
  return {
    nodes: sorted(nodes.map((n) => n.slice(1).map(cell).join("|"))),
    edges: sorted(edges.map((e) => `${e[0]}|${name(e[1])}|${name(e[2])}|${cell(e[3])}`)),
  };
}

function multisetMinus(a, b) {
  const counts = new Map();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out = [];
  for (const x of a) {
    const c = counts.get(x) ?? 0;
    if (c > 0) counts.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Multiset difference of two signatures. `equal` is true only when both the
 * node and the edge multisets match exactly.
 */
export function diffSignatures(a, b) {
  const part = (k) => ({ onlyA: multisetMinus(a[k], b[k]), onlyB: multisetMinus(b[k], a[k]) });
  const nodes = part("nodes");
  const edges = part("edges");
  const equal = [nodes, edges].every((d) => d.onlyA.length === 0 && d.onlyB.length === 0);
  return { equal, nodes, edges };
}

/** Human-readable diff, `limit` lines per side and kind. */
export function formatDiff(a, b, limit = 8) {
  const d = diffSignatures(a, b);
  const lines = [];
  for (const k of ["nodes", "edges"]) {
    lines.push(
      `${k}: A=${a[k].length} B=${b[k].length} onlyA=${d[k].onlyA.length} onlyB=${d[k].onlyB.length}`,
    );
    for (const x of d[k].onlyA.slice(0, limit)) lines.push(`   -A ${x.slice(0, 170)}`);
    for (const x of d[k].onlyB.slice(0, limit)) lines.push(`   +B ${x.slice(0, 170)}`);
  }
  return lines.join("\n");
}

export function summary(sig) {
  return `nodes=${sig.nodes.length} edges=${sig.edges.length} nodeHash=${hashOf(sig.nodes)} edgeHash=${hashOf(sig.edges)}`;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "sig" && rest[0]) {
    const url = process.env.IX_E2E_ARANGO_URL ?? "http://127.0.0.1:8729";
    const sig = await graphSignature(url, rest[0]);
    if (rest[1]) writeFileSync(rest[1], JSON.stringify(sig));
    console.log(`${rest[0]}: ${summary(sig)}`);
    return 0;
  }
  if (cmd === "diff" && rest[1]) {
    const read = (p) => JSON.parse(readFileSync(p, "utf8"));
    const a = read(rest[0]);
    const b = read(rest[1]);
    console.log(formatDiff(a, b, rest[2] ? Number(rest[2]) : 4));
    return diffSignatures(a, b).equal ? 0 : 1;
  }
  console.error(
    "usage: graph-sig.mjs sig <workspace_id> [out.json] | diff <a.json> <b.json> [limit]",
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
}
