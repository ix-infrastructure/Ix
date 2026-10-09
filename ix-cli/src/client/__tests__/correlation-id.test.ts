// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { IxClient } from "../api.js";
import {
  ACCEPTED_CORRELATION_ID,
  CORRELATION_ID_HEADER,
  debugRequest,
  invocationCorrelationId,
  nextCorrelationId,
} from "../correlation.js";

/**
 * Every request carries an X-Correlation-Id the backend will keep (it
 * replaces anything outside 1-64 of `[A-Za-z0-9._-]` with its own UUID), so
 * its slow-query and request logs can be matched to one `ix` run.
 */

let server: Server;
let endpoint: string;
const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", results: [], nodes: [], edges: [], rev: 1 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  seen.length = 0;
  vi.restoreAllMocks();
});

const header = (h: IncomingHttpHeaders) => h[CORRELATION_ID_HEADER.toLowerCase()] as string | undefined;

describe("correlation ids", () => {
  it("are <invocation>.<n>, always within what the backend accepts", () => {
    const a = nextCorrelationId();
    const b = nextCorrelationId();
    expect(a).not.toBe(b);
    for (const id of [a, b]) {
      expect(id).toMatch(ACCEPTED_CORRELATION_ID);
      expect(id.startsWith(`${invocationCorrelationId()}.`)).toBe(true);
    }
    expect(Number(b.split(".")[1])).toBe(Number(a.split(".")[1]) + 1);
    // Room to spare: a 36-character UUID, a dot, and a sequence number.
    expect(`${invocationCorrelationId()}.${Number.MAX_SAFE_INTEGER}`.length).toBeLessThanOrEqual(64);
  });

  it("go out on every request, GET and POST, one per request", async () => {
    const client = new IxClient(endpoint);
    await client.health();
    await client.search("x");
    await client.commitPatchBulk([]);
    expect(seen).toHaveLength(3);
    const ids = seen.map((r) => header(r.headers));
    for (const id of ids) {
      expect(id).toMatch(ACCEPTED_CORRELATION_ID);
      expect(id?.startsWith(`${invocationCorrelationId()}.`)).toBe(true);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("go out alongside the token, not instead of it", async () => {
    const client = new IxClient(endpoint, undefined, { token: "t" });
    await client.health();
    expect(seen[0].headers.authorization).toBe("Bearer t");
    expect(header(seen[0].headers)).toMatch(ACCEPTED_CORRELATION_ID);
  });

  it("are written to stderr under IX_DEBUG=1, without the query string", () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { lines.push(String(s)); return true; });
    debugRequest("POST", "/v1/search?q=secret", "abc.1", { IX_DEBUG: "1" });
    debugRequest("GET", "/v1/health", "abc.2", {});
    expect(lines).toEqual(["[debug] POST /v1/search X-Correlation-Id: abc.1\n"]);
  });

  it("the client logs each request's id under IX_DEBUG=1", async () => {
    const saved = process.env.IX_DEBUG;
    process.env.IX_DEBUG = "1";
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { lines.push(String(s)); return true; });
    try {
      await new IxClient(endpoint).health();
    } finally {
      if (saved === undefined) delete process.env.IX_DEBUG;
      else process.env.IX_DEBUG = saved;
    }
    expect(lines).toEqual([`[debug] GET /v1/health X-Correlation-Id: ${header(seen[0].headers)}\n`]);
  });
});
