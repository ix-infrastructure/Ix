// Copyright 2026 Ix Infrastructure Inc.

/**
 * Structural checks on the backend responses the resolver is built on:
 * `/v1/search`, `/v1/expand` (and `/v1/expand-by-name`), `/v1/entity/{id}` and
 * `/v1/context`.
 *
 * The backend ships separately from the CLI and people run mixed versions. A
 * body of the wrong shape used to travel untouched to a renderer and fail there
 * as a `TypeError`, far from the request and with nothing to say the backend
 * was the cause. These checks fail at the edge instead, with a
 * `BackendContractError` that names the route and the field.
 *
 * They check only what the CLI relies on: that arrays are arrays, and that the
 * ids, kinds and edge ends the resolver reads are strings. Every field they do
 * not name is left alone, so an unknown field from a newer backend, or a field
 * an older one leaves out, never fails a check. Each check returns the body it
 * was given, unchanged, under its client type.
 *
 * Hand-written rather than zod: these run on every lookup, and zod's import
 * cost would land on every CLI start.
 */

import type { ExpandResponse, EntityResponse, GraphNode, StructuredContext } from "./types.js";

/** The `code` a `BackendContractError` carries, and the error record's code. */
export const BACKEND_CONTRACT_ERROR = "backend_contract_error";

/**
 * A 2xx response whose body does not have the shape this CLI reads. `route` is
 * the method and route template (`POST /v1/search`), `field` the path to the
 * offending value in the body (`nodes[3].kind`, or `body` for the body itself).
 */
export class BackendContractError extends Error {
  readonly code = BACKEND_CONTRACT_ERROR;
  constructor(
    readonly route: string,
    readonly field: string,
    readonly problem: string,
  ) {
    super(`${BACKEND_CONTRACT_ERROR}: ${route}: ${field} ${problem}`);
    this.name = "BackendContractError";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "undefined") return "missing";
  return type === "object" ? "an object" : `a ${type}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One route's checks, each naming the field it found wrong. */
class Check {
  constructor(private readonly route: string) {}

  fail(field: string, problem: string): never {
    throw new BackendContractError(this.route, field, problem);
  }

  object(value: unknown, field: string): Record<string, unknown> {
    if (!isObject(value)) this.fail(field, `is ${describe(value)} where an object was expected`);
    return value;
  }

  array(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) this.fail(field, `is ${describe(value)} where an array was expected`);
    return value;
  }

  string(value: unknown, field: string): void {
    if (typeof value !== "string") this.fail(field, `is ${describe(value)} where a string was expected`);
  }

  /** A node or node summary: an object whose `id` and `kind` are strings. */
  node(value: unknown, field: string): void {
    const node = this.object(value, field);
    this.string(node.id, `${field}.id`);
    this.string(node.kind, `${field}.kind`);
  }

  /** An edge or edge summary: an object whose `src`, `dst` and `predicate` are strings. */
  edge(value: unknown, field: string): void {
    const edge = this.object(value, field);
    this.string(edge.src, `${field}.src`);
    this.string(edge.dst, `${field}.dst`);
    this.string(edge.predicate, `${field}.predicate`);
  }

  nodes(value: unknown, field: string): void {
    this.array(value, field).forEach((n, i) => this.node(n, `${field}[${i}]`));
  }

  edges(value: unknown, field: string): void {
    this.array(value, field).forEach((e, i) => this.edge(e, `${field}[${i}]`));
  }

  /**
   * An array field the backend may leave out: checked only when present. An
   * explicit `null` counts as absent, since the backend may encode an empty
   * `Option` that way and the consumers default these fields (`?? []`).
   */
  optionalArray(body: Record<string, unknown>, key: string, each?: (item: unknown, field: string) => void): void {
    if (body[key] === undefined || body[key] === null) return;
    const items = this.array(body[key], key);
    if (each) items.forEach((item, i) => each(item, `${key}[${i}]`));
  }
}

/** `POST /v1/search`: an array of nodes. `/v1/search/semantic` is not checked. */
export function searchResponse(body: unknown, route = "POST /v1/search"): GraphNode[] {
  const check = new Check(route);
  check.array(body, "body").forEach((n, i) => check.node(n, `[${i}]`));
  return body as GraphNode[];
}

/** `POST /v1/expand` and `POST /v1/expand-by-name`: `nodes` and `edges` arrays. */
export function expandResponse(body: unknown, route = "POST /v1/expand"): ExpandResponse {
  const check = new Check(route);
  const obj = check.object(body, "body");
  check.nodes(obj.nodes, "nodes");
  check.edges(obj.edges, "edges");
  return body as ExpandResponse;
}

/**
 * `GET /v1/entity/{id}`: a `node`, and its `edges` and `claims` when the
 * backend sends them (consumers default both with `?? []`). The claims and
 * edges are not looked inside: the CLI reads them as `unknown`. A body with no
 * node at all is passed through.
 */
export function entityResponse(body: unknown, route = "GET /v1/entity/{id}"): EntityResponse {
  // A 200 that names no entity -- `null`, `{}` or `{ node: null }` -- is not a
  // contract break: the resolver reads it as a miss (exit 3), so it is handed
  // back as it came.
  if (body === null || (isObject(body) && (body.node === undefined || body.node === null))) {
    return body as unknown as EntityResponse;
  }
  const check = new Check(route);
  const obj = check.object(body, "body");
  check.node(obj.node, "node");
  check.optionalArray(obj, "claims");
  check.optionalArray(obj, "edges");
  return body as EntityResponse;
}

/**
 * `POST /v1/context`. `nodes` and `edges` are part of every response and the
 * context commands read them without a guard (`context.edges.length`), so
 * they must be arrays. Which of the rest are filled depends on `depth`, so
 * each is checked only when present.
 */
export function contextResponse(body: unknown, route = "POST /v1/context"): StructuredContext {
  const check = new Check(route);
  const obj = check.object(body, "body");
  const node = (n: unknown, field: string) => check.node(n, field);
  const edge = (e: unknown, field: string) => check.edge(e, field);
  check.nodes(obj.nodes, "nodes");
  check.edges(obj.edges, "edges");
  check.optionalArray(obj, "nodeSummaries", node);
  check.optionalArray(obj, "edgeSummaries", edge);
  for (const key of ["claims", "compactClaims", "conflicts", "decisions", "intents"]) {
    check.optionalArray(obj, key);
  }
  if (obj.metadata !== undefined && obj.metadata !== null) check.object(obj.metadata, "metadata");
  return body as StructuredContext;
}
