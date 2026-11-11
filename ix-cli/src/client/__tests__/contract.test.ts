// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IxClient } from "../api.js";
import {
  BackendContractError,
  contextResponse,
  entityResponse,
  expandResponse,
  searchResponse,
} from "../contract.js";
import { renderCliError, setErrorFormat } from "../../cli/errors.js";

const node = (id: string, kind = "function") => ({ id, kind, name: id });
const edge = (src: string, dst: string, predicate = "CALLS") => ({ id: `${src}-${dst}`, src, dst, predicate });

/** What a guard threw, so a test can read its fields. */
function thrown(run: () => unknown): BackendContractError {
  try {
    run();
  } catch (err) {
    if (err instanceof BackendContractError) return err;
    throw err;
  }
  throw new Error("expected a BackendContractError");
}

describe("the response guards", () => {
  it.each([
    ["a search body that is not an array", () => searchResponse({ nodes: [] }), "POST /v1/search", "body"],
    ["a search node whose kind is not a string", () => searchResponse([node("a"), { id: "b", kind: 7 }]), "POST /v1/search", "[1].kind"],
    ["a search node that is null", () => searchResponse([null]), "POST /v1/search", "[0]"],
    ["an expand body without nodes", () => expandResponse({ edges: [] }), "POST /v1/expand", "nodes"],
    ["an expand node whose id is a number", () => expandResponse({ nodes: [{ id: 3, kind: "file" }], edges: [] }), "POST /v1/expand", "nodes[0].id"],
    ["an expand edges field that is an object", () => expandResponse({ nodes: [], edges: {} }), "POST /v1/expand", "edges"],
    ["an expand edge without a predicate", () => expandResponse({ nodes: [], edges: [{ src: "a", dst: "b" }] }), "POST /v1/expand", "edges[0].predicate"],
    ["an expand-by-name body that is an array", () => expandResponse([], "POST /v1/expand-by-name"), "POST /v1/expand-by-name", "body"],
    ["an entity body that is an array", () => entityResponse([]), "GET /v1/entity/{id}", "body"],
    ["an entity node that is a string", () => entityResponse({ node: "a", edges: [] }), "GET /v1/entity/{id}", "node"],
    ["entity edges that are an object", () => entityResponse({ node: node("a"), edges: {} }), "GET /v1/entity/{id}", "edges"],
    ["an entity node without a kind", () => entityResponse({ node: { id: "a" }, edges: [] }), "GET /v1/entity/{id}", "node.kind"],
    ["entity claims that are not an array", () => entityResponse({ node: node("a"), claims: "none", edges: [] }), "GET /v1/entity/{id}", "claims"],
    ["a context whose nodes is not an array", () => contextResponse({ nodes: "x", edges: [] }), "POST /v1/context", "nodes"],
    ["a context node summary without an id", () => contextResponse({ nodes: [], edges: [], nodeSummaries: [{ kind: "file" }] }), "POST /v1/context", "nodeSummaries[0].id"],
    ["a context edge summary whose dst is null", () => contextResponse({ nodes: [], edges: [], edgeSummaries: [{ src: "a", dst: null, predicate: "CALLS" }] }), "POST /v1/context", "edgeSummaries[0].dst"],
    ["context claims that are an object", () => contextResponse({ nodes: [], edges: [], claims: {} }), "POST /v1/context", "claims"],
  ])("rejects %s, naming the route and the field", (_label, run, route, field) => {
    const err = thrown(run);
    expect(err.code).toBe("backend_contract_error");
    expect(err.name).toBe("BackendContractError");
    expect(err.route).toBe(route);
    expect(err.field).toBe(field);
    expect(err.message).toMatch(/^backend_contract_error: /);
    expect(err.message).toContain(route);
    expect(err.message).toContain(field);
  });

  it("says what it found and what it expected", () => {
    expect(thrown(() => searchResponse({})).message)
      .toBe("backend_contract_error: POST /v1/search: body is an object where an array was expected");
    expect(thrown(() => expandResponse({ nodes: [{ id: "a" }], edges: [] })).message)
      .toBe("backend_contract_error: POST /v1/expand: nodes[0].kind is missing where a string was expected");
  });

  it("accepts unknown extra fields everywhere, and returns the body unchanged", () => {
    const extra = { addedLater: { deep: [1, 2] } };
    const search = [{ ...node("a"), ...extra, attrs: { anything: true } }];
    expect(searchResponse(search)).toBe(search);

    const expand = { nodes: [{ ...node("a"), ...extra }], edges: [{ ...edge("a", "b"), ...extra }], cursor: "next", ...extra };
    expect(expandResponse(expand)).toBe(expand);

    const entity = { node: { ...node("a"), ...extra }, claims: [{ any: "shape" }], edges: [{ predicate: "CALLS" }], rev: 9, ...extra };
    expect(entityResponse(entity)).toBe(entity);

    const context = {
      nodes: [{ ...node("a"), ...extra }],
      edges: [{ ...edge("a", "b"), ...extra }],
      nodeSummaries: [{ ...node("a"), rev: 1, ...extra }],
      edgeSummaries: [{ ...edge("a", "b"), rev: 1, ...extra }],
      claims: [], conflicts: [], decisions: [], intents: [],
      metadata: { query: "q", seedEntities: [], hopsExpanded: 1, asOfRev: 1, ...extra },
      somethingNew: [{ not: "checked" }],
    };
    expect(contextResponse(context)).toBe(context);
  });

  it("accepts the fields an older backend may leave out where the CLI does not need them", () => {
    // Entity claims, and every context field but nodes and edges.
    expect(() => entityResponse({ node: node("a"), edges: [] })).not.toThrow();
    expect(() => contextResponse({ nodes: [], edges: [] })).not.toThrow();
    // Entity edges and claims, which every consumer reads with `?? []`.
    expect(() => entityResponse({ node: node("a") })).not.toThrow();
    expect(() => entityResponse({ node: node("a"), edges: null, claims: null })).not.toThrow();
    // An explicit null for an optional context field reads as absent, as the consumers' `?? []` did.
    const nulls = { nodes: [], edges: [], nodeSummaries: null, edgeSummaries: null, claims: null, compactClaims: null, metadata: null };
    expect(contextResponse(nulls)).toBe(nulls);
    // An entity answer that names nothing is the resolver's miss (exit 3), not a contract break.
    for (const nothing of [null, {}, { node: null }]) expect(entityResponse(nothing)).toBe(nothing);
    // A node needs only an id and a kind; its name can live in attrs.
    expect(() => searchResponse([{ id: "a", kind: "file", attrs: { name: "a.ts" } }])).not.toThrow();
  });
});

// ── Through the client, against a real HTTP server ──────────────────────────

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => {
    s.closeAllConnections();
    s.close(() => r());
  })));
});

/** A backend that answers each path with the body `reply` gives for it. */
async function backend(reply: (path: string) => unknown): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(req.url ?? "")));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("IxClient on the four core routes", () => {
  it("rejects a wrong shape with backend_contract_error naming the route", async () => {
    const client = new IxClient(await backend((path) => {
      if (path.startsWith("/v1/search")) return { nodes: [node("a")] };
      if (path.startsWith("/v1/expand-by-name")) return { nodes: [node("a")], edges: null };
      if (path.startsWith("/v1/expand")) return { nodes: [{ id: "a", kind: 1 }], edges: [] };
      if (path.startsWith("/v1/entity/")) return { node: { id: "a" }, edges: [] };
      if (path.startsWith("/v1/context")) return { nodes: {}, edges: [] };
      return {};
    }));
    const cases: Array<[() => Promise<unknown>, string, string]> = [
      [() => client.search("a"), "POST /v1/search", "body"],
      [() => client.expand("a"), "POST /v1/expand", "nodes[0].kind"],
      [() => client.expandByName("a"), "POST /v1/expand-by-name", "edges"],
      [() => client.entity("a"), "GET /v1/entity/{id}", "node.kind"],
      [() => client.query("a"), "POST /v1/context", "nodes"],
      [() => client.contextForNode("a"), "POST /v1/context", "nodes"],
      [() => client.contextForNodes(["a"]), "POST /v1/context", "nodes"],
    ];
    for (const [request, route, field] of cases) {
      const err = await request().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(BackendContractError);
      expect(err).toMatchObject({ code: "backend_contract_error", route, field });
    }
  });

  it("hands back a newer backend's extra fields untouched", async () => {
    const newer = { addedLater: "kept" };
    const client = new IxClient(await backend((path) => {
      if (path.startsWith("/v1/search")) return [{ ...node("a"), ...newer }];
      if (path.startsWith("/v1/expand")) return { nodes: [{ ...node("a"), ...newer }], edges: [edge("a", "b")], ...newer };
      if (path.startsWith("/v1/entity/")) return { node: { ...node("a"), ...newer }, claims: [], edges: [], ...newer };
      if (path.startsWith("/v1/context")) return { nodes: [], edges: [], nodeSummaries: [{ ...node("a"), ...newer }], ...newer };
      return {};
    }));
    expect(await client.search("a")).toEqual([{ ...node("a"), ...newer }]);
    expect(await client.expand("a")).toEqual({ nodes: [{ ...node("a"), ...newer }], edges: [edge("a", "b")], ...newer });
    expect(await client.entity("a")).toEqual({ node: { ...node("a"), ...newer }, claims: [], edges: [], ...newer });
    expect(await client.query("a")).toEqual({ nodes: [], edges: [], nodeSummaries: [{ ...node("a"), ...newer }], ...newer });
  });
});

// ── How the CLI reports it ──────────────────────────────────────────────────

class ExitCalled extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

describe("renderCliError on a BackendContractError", () => {
  it("emits a backend_contract_error record naming the route and field, and exits 1", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new ExitCalled(code); }) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const err = thrown(() => searchResponse([{ id: "a", kind: 7 }]));
    const render = () => { try { renderCliError(err, false, "http://127.0.0.1:8090"); } catch (e) { if (!(e instanceof ExitCalled)) throw e; } };
    try {
      setErrorFormat("json");
      render();
      expect(exit).toHaveBeenLastCalledWith(1);
      const record = JSON.parse(String(log.mock.calls[0][0]));
      expect(record.error).toBe("backend_contract_error");
      expect(record.message).toContain("POST /v1/search");
      expect(record.message).toContain("[0].kind");
      expect(record.message).toContain("http://127.0.0.1:8090");
      expect(record.next).toContain("ix doctor");

      setErrorFormat("llm");
      render();
      expect(exit).toHaveBeenLastCalledWith(1);
      expect(String(log.mock.calls[1][0])).toMatch(/^error code=backend_contract_error /);

      // Text: a readable message on stderr, never a stack.
      setErrorFormat("text");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        render();
        expect(exit).toHaveBeenLastCalledWith(1);
        const text = error.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
        expect(text).toContain("POST /v1/search");
        expect(text).toContain("ix doctor");
        expect(text).not.toMatch(/\n\s+at /);
      } finally {
        error.mockRestore();
      }
    } finally {
      setErrorFormat(undefined);
      exit.mockRestore();
      log.mockRestore();
      write.mockRestore();
    }
  });
});
