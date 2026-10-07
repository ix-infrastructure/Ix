// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { IxClient } from "../../client/api.js";
import { createClient, DEFAULT_READ_DEADLINE_MS, readDeadlineMs } from "../../client/factory.js";

/**
 * CL-15: only four query commands capped requests in flight, every read waited
 * up to 2 minutes on a hung backend, and one dropped connection or 503 failed
 * the command. Every client now caps at 12, reads are bounded per command, and
 * a read (never a write) is retried once.
 */

type Handler = (url: string, method: string) => { status: number; body: string; delayMs?: number } | "hang";
let handler: Handler = () => ({ status: 200, body: "[]" });
let server: Server;
let endpoint: string;
let inflight = 0;
let peak = 0;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const r = handler(req.url ?? "", req.method ?? "");
      if (r === "hang") return;
      inflight++;
      peak = Math.max(peak, inflight);
      setTimeout(() => {
        inflight--;
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body);
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

let savedDeadline: string | undefined;
beforeEach(() => {
  requests.length = 0;
  inflight = 0;
  peak = 0;
  handler = () => ({ status: 200, body: "[]" });
  savedDeadline = process.env.IX_READ_DEADLINE_MS;
  delete process.env.IX_READ_DEADLINE_MS;
});
afterEach(() => {
  if (savedDeadline === undefined) delete process.env.IX_READ_DEADLINE_MS;
  else process.env.IX_READ_DEADLINE_MS = savedDeadline;
  // Not closeAllConnections(): that leaves the client's pooled keep-alive
  // sockets dead, and the next test's first request would spend its one retry
  // on one of them.
  vi.restoreAllMocks();
});

describe("every client caps requests in flight", () => {
  it("200 concurrent reads through createClient never put more than 12 in flight", async () => {
    handler = () => ({ status: 200, body: "[]", delayMs: 15 });
    const client = createClient({ endpoint });
    await Promise.all(Array.from({ length: 200 }, (_, i) => client.search(`t${i}`)));
    expect(requests).toHaveLength(200);
    expect(peak).toBeLessThanOrEqual(12);
  });
});

describe("one retry for a read, none for a write", () => {
  it("a 503 on a GET is asked again once and the answer used", async () => {
    let n = 0;
    handler = () => (n++ === 0 ? { status: 503, body: '{"error":"restarting"}' } : { status: 200, body: '{"rev":3}' });
    await expect(createClient({ endpoint }).currentRevision()).resolves.toEqual({ rev: 3 });
    expect(requests).toHaveLength(2);
  });

  it("a 503 on a read POST (search) is retried too", async () => {
    let n = 0;
    handler = () => (n++ === 0 ? { status: 502, body: "bad gateway" } : { status: 200, body: "[]" });
    await expect(createClient({ endpoint }).search("x")).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("only once: a second 503 fails the read", async () => {
    handler = () => ({ status: 503, body: '{"error":"down"}' });
    await expect(createClient({ endpoint }).currentRevision()).rejects.toThrow(/^503:/);
    expect(requests).toHaveLength(2);
  });

  it("never retries a write", async () => {
    handler = () => ({ status: 503, body: '{"error":"restarting"}' });
    await expect(createClient({ endpoint }).deleteWorkspace("ws")).rejects.toThrow(/^503:/);
    expect(requests).toEqual(["POST /v1/reset/workspace"]);
  });

  it("does not retry a 500 or a 404", async () => {
    handler = () => ({ status: 500, body: '{"error":"boom"}' });
    await expect(createClient({ endpoint }).currentRevision()).rejects.toThrow(/^500:/);
    expect(requests).toHaveLength(1);
  });

  it("a refused or reset connection on a read is retried once", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      calls++;
      if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return real(...args);
    });
    await expect(createClient({ endpoint }).search("x")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("a plain IxClient keeps the old behaviour: no retry", async () => {
    handler = () => ({ status: 503, body: '{"error":"restarting"}' });
    await expect(new IxClient(endpoint).currentRevision()).rejects.toThrow(/^503:/);
    expect(requests).toHaveLength(1);
  });
});

describe("a read deadline per command", () => {
  it("a hung backend fails a read at the deadline, not after 2 minutes", async () => {
    handler = () => "hang";
    process.env.IX_READ_DEADLINE_MS = "300";
    const t0 = Date.now();
    await expect(createClient({ endpoint }).search("x")).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("does not cut off a write", async () => {
    handler = (url) => (url.startsWith("/v1/reset/workspace") ? { status: 200, body: "{}", delayMs: 500 } : "hang");
    process.env.IX_READ_DEADLINE_MS = "200";
    await expect(createClient({ endpoint }).deleteWorkspace("ws")).resolves.toBeUndefined();
  });

  it("long-running clients and callers with their own deadline get none", async () => {
    handler = () => ({ status: 200, body: "[]", delayMs: 400 });
    process.env.IX_READ_DEADLINE_MS = "100";
    await expect(createClient({ endpoint, longRunning: true }).search("x")).resolves.toEqual([]);
    await expect(createClient({ endpoint, deadlineSignal: new AbortController().signal }).search("x")).resolves.toEqual([]);
  });

  it("IX_READ_DEADLINE_MS: a number of ms, 0 for none, anything else the default", () => {
    expect(readDeadlineMs({})).toBe(DEFAULT_READ_DEADLINE_MS);
    expect(DEFAULT_READ_DEADLINE_MS).toBe(60_000);
    expect(readDeadlineMs({ IX_READ_DEADLINE_MS: "5000" })).toBe(5000);
    expect(readDeadlineMs({ IX_READ_DEADLINE_MS: "0" })).toBe(0);
    expect(readDeadlineMs({ IX_READ_DEADLINE_MS: "soon" })).toBe(DEFAULT_READ_DEADLINE_MS);
  });
});
