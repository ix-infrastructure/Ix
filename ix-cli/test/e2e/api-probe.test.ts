// Copyright 2026 Ix Infrastructure Inc.

// Unit side of the API-reference check: which requests api-reference.e2e.ts
// sends and how it reads the answers, plus the docs that tell readers which
// endpoints to call first. Runs in `npm test`; no backend needed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { PROBE_ID, UNKNOWN_ROUTE, buildProbes, missingRoute, startedOpId, type Probe } from "./api-probe.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");
const doc = parse(read("docs", "api", "openapi.yaml"));

const unknownRoute = { status: 404, body: "The requested resource could not be found." };
const probe = (method: Probe["method"], path: string): Probe =>
  buildProbes({ paths: { [path]: { [method]: {} } } })[0];

describe("buildProbes", () => {
  it("sends one request per documented method and path", () => {
    const probes = buildProbes(doc);
    const documented = Object.values(doc.paths as Record<string, object>)
      .flatMap((item) => Object.keys(item).filter((k) => ["get", "post", "put", "patch", "delete"].includes(k)));
    expect(probes).toHaveLength(documented.length);
    expect(new Set(probes.map((p) => `${p.method} ${p.path}`)).size).toBe(probes.length);
  });

  it("fills path slots, sends {} only on methods with a body, and adds required query params", () => {
    const probes = buildProbes({
      paths: {
        "/v1/session/{nameOrId}": { get: {}, delete: {} },
        "/v1/note/{id}/retract": { post: {} },
        "/v1/conflicts": {
          get: {
            parameters: [
              { name: "rev", in: "query", required: true, schema: { type: "integer" } },
              { name: "workspace_id", in: "query", schema: { type: "string" } },
            ],
          },
        },
      },
    });
    expect(probes).toEqual([
      { method: "get", path: "/v1/session/{nameOrId}", url: `/v1/session/${PROBE_ID}` },
      { method: "delete", path: "/v1/session/{nameOrId}", url: `/v1/session/${PROBE_ID}` },
      { method: "post", path: "/v1/note/{id}/retract", url: `/v1/note/${PROBE_ID}/retract`, body: "{}" },
      { method: "get", path: "/v1/conflicts", url: "/v1/conflicts?rev=1" },
    ]);
  });
});

describe("PROBE_ID", () => {
  // The client only polls lowercase-UUID op ids (api.ts), and a backend that
  // matches an id segment as a UUID would 404 any other string before the
  // handler, which missingRoute would read as "not routed".
  it("is a lowercase UUID, so UUID-matched routes reach their handler", () => {
    expect(PROBE_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const [p] = buildProbes({ paths: { "/v1/reset/status/{opId}": { get: {} } } });
    expect(p.url).toBe(`/v1/reset/status/${PROBE_ID}`);
  });
});

describe("startedOpId", () => {
  const opId = "3f2b8c1e-0000-4000-8000-000000000001";
  it("reads the op id from a 202 and from a 200 (the reference documents 200 for reset/code/async)", () => {
    expect(startedOpId({ status: 202, body: JSON.stringify({ opId }) })).toBe(opId);
    expect(startedOpId({ status: 200, body: JSON.stringify({ opId, state: "running" }) })).toBe(opId);
  });
  it("is null for other statuses, bodies without an op id, and non-JSON", () => {
    expect(startedOpId({ status: 400, body: JSON.stringify({ opId }) })).toBeNull();
    expect(startedOpId({ status: 200, body: '{"ok":true}' })).toBeNull();
    expect(startedOpId({ status: 200, body: "null" })).toBeNull();
    expect(startedOpId({ status: 202, body: "accepted" })).toBeNull();
  });
});

describe("missingRoute", () => {
  it("fails a 405", () => {
    expect(missingRoute(probe("post", "/v1/stats"), { status: 405, body: "HTTP method not allowed" }, unknownRoute))
      .toMatch(/^POST \/v1\/stats: method not allowed/);
  });

  it("fails a 404 that answers like an unknown path", () => {
    expect(missingRoute(probe("post", "/v1/ingest"), unknownRoute, unknownRoute))
      .toMatch(/^POST \/v1\/ingest: not routed/);
    // A parameterised route gets no pass for being parameterised.
    expect(missingRoute(probe("get", "/v1/entity/{id}"), unknownRoute, unknownRoute)).not.toBeNull();
  });

  it("blanks the request path out of both bodies before comparing", () => {
    const base = { status: 404, body: `no route for ${UNKNOWN_ROUTE}` };
    const p = probe("get", "/v1/stitch/system/{workspaceId}");
    expect(missingRoute(p, { status: 404, body: `no route for ${p.url}` }, base)).not.toBeNull();
  });

  it("accepts a handler's own 404 and every other status", () => {
    const p = probe("get", "/v1/entity/{id}");
    expect(missingRoute(p, { status: 404, body: '{"error":"entity not found"}' }, unknownRoute)).toBeNull();
    for (const status of [200, 202, 400, 422, 500, 503]) {
      expect(missingRoute(p, { status, body: unknownRoute.body }, unknownRoute)).toBeNull();
    }
  });

  it("cannot read a 404 when the unknown path did not answer 404", () => {
    const p = probe("get", "/v1/stats");
    expect(missingRoute(p, unknownRoute, { status: 405, body: unknownRoute.body })).toBeNull();
  });
});

describe("the docs readers start from", () => {
  const documented = new Set(buildProbes(doc).map((p) => `${p.method.toUpperCase()} ${p.path}`));

  // Every curl in a Quick Start targets a documented method + path, so the
  // e2e probe covers it. Only literal paths: no {id} slots in quick starts.
  for (const file of [["docs", "api", "README.md"], ["docs-site", "src", "content", "docs", "api", "overview.md"]]) {
    it(`${file.join("/")} quick start calls only documented endpoints`, () => {
      const text = read(...file);
      const calls = [...text.matchAll(/curl\s+-s(?:\s+-X\s+(\w+))?\s+\S*?(\/v1\/[\w/-]+)/g)]
        .map((m) => `${(m[1] ?? "GET").toUpperCase()} ${m[2]}`);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(documented, call).toContain(call);
      expect(calls).not.toContain("POST /v1/ingest");
    });
  }

  // A Dependabot bump changes only compose.e2e.yml, so a pinned version
  // written in prose goes stale silently. Where these docs talk about the pin
  // (the paragraph or table row naming it), any version they give must be it.
  // Other versions (example payloads, "1.0.33+" minimums) are not the pin.
  it("names no backend version for the pin other than compose.e2e.yml's", () => {
    const pin = /ix-memory-layer:(\d+\.\d+\.\d+)/.exec(read("ix-cli", "test", "e2e", "compose.e2e.yml"))?.[1];
    expect(pin).toBeDefined();
    for (const file of [["docs", "api", "README.md"], ["ix-cli", "test", "e2e", "README.md"]]) {
      const blocks = read(...file).split(/\n\s*\n|\n(?=\|)/).filter((b) => /\bpin(?:ned)?\b/i.test(b));
      expect(blocks.length, file.join("/")).toBeGreaterThan(0);
      for (const block of blocks) {
        for (const m of block.matchAll(/\b\d+\.\d+\.\d+\b/g)) expect(m[0], `${file.join("/")}: ${block}`).toBe(pin);
      }
    }
  });

  it("docs/api/README.md does not claim the reference is generated", () => {
    expect(read("docs", "api", "README.md")).not.toMatch(/generated from the client/i);
  });
});
