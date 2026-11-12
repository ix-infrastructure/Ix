// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IxClient } from "../../client/api.js";
import * as factory from "../../client/factory.js";
import { QUERY_CLIENT_OPTIONS } from "../../client/request-memo.js";
import { registerExplainCommand } from "../commands/explain.js";
import { collectFacts } from "../explain/facts.js";
import * as resolver from "../resolve.js";

// Use the parser's actual node payloads from a checked-in source fixture.
// Docker/recorded HTTP fixtures are not needed to exercise the HTTP client.
const { parseFile } = await import(new URL("../../../../core-ingestion/dist/index.js", import.meta.url).href);
const { buildPatch } = await import(new URL("../../../../core-ingestion/dist/patch-builder.js", import.meta.url).href);
const source = readFileSync(new URL("../../../test/fixtures/api.ts", import.meta.url), "utf8");
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function graph(fanout: number, batchStatus = 200) {
  const nodes = new Map<string, any>();
  const callees: any[] = [];
  let target: any;
  let container: any;
  for (let i = 0; i <= fanout; i++) {
    const file = `src/api-${i}.ts`;
    const patch = buildPatch(parseFile(file, source), "fixture-source", "fixture-workspace");
    const parsed = patch.ops.filter((op: any) => op.type === "UpsertNode")
      .map((op: any) => ({ ...op, provenance: { sourceUri: file } }));
    if (i === 0) {
      target = parsed.find((n: any) => n.name === "getUser");
      container = parsed.find((n: any) => n.name === "ApiClient");
      nodes.set(target.id, target);
      nodes.set(container.id, container);
    } else {
      const callee = parsed.find((n: any) => n.name === "parseResponse");
      callees.push(callee);
      // Model dangling references from an older graph alongside live nodes.
      if (i % 2 === 0) nodes.set(callee.id, callee);
    }
  }
  const edges = [
    { src: container.id, dst: target.id, predicate: "CONTAINS" },
    ...callees.map((n) => ({ src: target.id, dst: n.id, predicate: "CALLS" })),
  ];
  let entityReads = 0;
  let batchReads = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url?.startsWith("/v1/entity/")) {
      entityReads++;
      const node = nodes.get(decodeURIComponent(request.url.slice("/v1/entity/".length)));
      return node ? send(200, { node, claims: [], edges: node.id === target.id ? edges : [] })
        : send(404, { error: "entity not found" });
    }
    if (request.url === "/v1/nodes") {
      batchReads++;
      if (batchStatus !== 200) return send(batchStatus, { error: "batch unavailable" });
      const { ids, fields } = JSON.parse(body);
      expect(fields).toBe("full");
      return send(200, { rev: 1, nodes: ids.filter((id: string) => nodes.has(id)).reverse().map((id: string) => nodes.get(id)),
        missing: ids.filter((id: string) => !nodes.has(id)) });
    }
    if (request.url === "/v1/expand") {
      const { nodeId, direction, predicates } = JSON.parse(body);
      const outgoing = nodeId === target.id && direction === "out" && predicates?.includes("CALLS");
      return send(200, { nodes: outgoing ? callees.filter((n) => nodes.has(n.id)) : [], edges: [] });
    }
    if (request.url?.startsWith("/v1/provenance/")) return send(200, { chain: [] });
    send(404, { error: "unsupported fixture route" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { endpoint, target, callees, counts: () => ({ entityReads, batchReads }) };
}

describe("explain entity request budget", () => {
  it.each([1, 20])("collects %i callees with at most two entity reads", async (fanout) => {
    const g = await graph(fanout);
    const client = new IxClient(g.endpoint, undefined, QUERY_CLIENT_OPTIONS);
    const facts = await collectFacts(client, g.target.id, g.target.name, g.target.kind);
    expect(facts.callList?.map((ref) => ref.resolved)).toEqual(g.callees.map((_, i) => i % 2 === 1));
    expect(facts.callList?.map((ref) => ref.name)).toEqual(g.callees.map((n, i) => i % 2 === 1 ? n.name : n.id));
    expect(facts.callList?.filter((ref) => ref.resolved).map((ref) => ref.path))
      .toEqual(g.callees.filter((_, i) => i % 2 === 1).map((n) => n.provenance.sourceUri));
    expect(g.counts()).toEqual({ entityReads: 2, batchReads: 1 });
    // Negative batch results are shared within this command too.
    await collectFacts(client, g.target.id, g.target.name, g.target.kind);
    expect(g.counts()).toEqual({ entityReads: 2, batchReads: 1 });
  });

  it("bounds ix explain --raw to two entity reads for twenty callees", async () => {
    const g = await graph(20);
    vi.spyOn(factory, "createClient").mockImplementation(() => new IxClient(g.endpoint, undefined, QUERY_CLIENT_OPTIONS));
    vi.spyOn(resolver, "resolveFileOrReport").mockResolvedValue({ ...g.target, resolutionMode: "exact" });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerExplainCommand(program);
    await program.parseAsync(["explain", "getUser", "--raw", "--format", "json"], { from: "user" });
    const result = JSON.parse(output.mock.calls.map((args) => args.join(" ")).join("\n")).result;
    const refs = result.callList.slice(0, g.callees.length);
    expect(refs.map((ref: any) => ref.resolved)).toEqual(g.callees.map((_, i) => i % 2 === 1));
    expect(refs.filter((ref: any) => !ref.resolved).every((ref: any) => ref.diagnostic === "unresolved_call_target")).toBe(true);
    expect(g.counts()).toEqual({ entityReads: 2, batchReads: 1 });
  });

  it("preserves callee results on older backends without individual probes", async () => {
    const g = await graph(20, 404);
    const client = new IxClient(g.endpoint, undefined, QUERY_CLIENT_OPTIONS);
    const facts = await collectFacts(client, g.target.id, g.target.name, g.target.kind);
    expect(facts.callList?.map((ref) => ref.resolved)).toEqual(g.callees.map((_, i) => i % 2 === 1));
    expect(facts.callList?.map((ref) => ref.name)).toEqual(g.callees.map((n, i) => i % 2 === 1 ? n.name : n.id));
    expect(g.counts()).toEqual({ entityReads: 2, batchReads: 1 });
  });

  it("keeps batch failures best-effort without retrying each callee", async () => {
    const g = await graph(20, 503);
    const client = new IxClient(g.endpoint, undefined, QUERY_CLIENT_OPTIONS);
    const facts = await collectFacts(client, g.target.id, g.target.name, g.target.kind);
    expect(facts.callList).toHaveLength(20);
    expect(facts.callList?.every((ref) => !ref.resolved && "diagnostic" in ref && ref.diagnostic === "unresolved_call_target")).toBe(true);
    expect(g.counts()).toEqual({ entityReads: 2, batchReads: 1 });
  });

  it("keeps the existing twenty-callee display cap", async () => {
    const g = await graph(21);
    const client = new IxClient(g.endpoint, undefined, QUERY_CLIENT_OPTIONS);
    const facts = await collectFacts(client, g.target.id, g.target.name, g.target.kind);
    expect(facts.callList).toBeUndefined();
    expect(g.counts()).toEqual({ entityReads: 2, batchReads: 0 });
  });
});
