// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { IxClient } from "../api.js";
import { Limiter, mapLimit, QUERY_CLIENT_OPTIONS, RequestMemo } from "../request-memo.js";
import type { GraphNode } from "../types.js";

const servers: Server[] = [];
type Seen = { method: string; path: string; body: string };

/** A backend that records every request and answers after `delayMs`. */
async function backend(
  reply: (request: Seen) => { status?: number; body: unknown },
  delayMs = 0,
) {
  const seen: Seen[] = [];
  let inFlight = 0;
  let peak = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    inFlight++;
    peak = Math.max(peak, inFlight);
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const record = { method: request.method ?? "", path: request.url ?? "", body };
      seen.push(record);
      setTimeout(() => {
        const { status = 200, body: out } = reply(record);
        inFlight--;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(typeof out === "string" ? out : JSON.stringify(out));
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    peak: () => peak,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

const expandReply = (request: Seen) => {
  const { nodeId } = JSON.parse(request.body) as { nodeId: string };
  return { body: { nodes: [{ id: `${nodeId}-n`, kind: "function" }, { id: `${nodeId}-m`, kind: "function" }], edges: [] } };
};

describe("IxClient shareReads", () => {
  it("sends an identical read once, however many callers ask", async () => {
    const b = await backend(expandReply, 20);
    const client = new IxClient(b.endpoint, undefined, { shareReads: true });

    const [one, two, three] = await Promise.all([
      client.expand("a", { direction: "in", predicates: ["CALLS"] }),
      client.expand("a", { direction: "in", predicates: ["CALLS"] }),
      client.expand("a", { direction: "in", predicates: ["CALLS"] }),
    ]);
    // After the first has finished, too.
    const four = await client.expand("a", { direction: "in", predicates: ["CALLS"] });

    expect(b.seen).toHaveLength(1);
    expect(client.sharedReadHits).toBe(3);
    for (const r of [two, three, four]) expect(r).toEqual(one);
  });

  it("keys on the whole request: a different body or path is its own read", async () => {
    const b = await backend((request) => request.path.startsWith("/v1/entity/")
      ? { body: { node: { id: request.path, kind: "function" }, claims: [], edges: [] } }
      : expandReply(request));
    const client = new IxClient(b.endpoint, undefined, { shareReads: true });

    await client.expand("a", { direction: "in", predicates: ["CALLS"] });
    await client.expand("a", { direction: "out", predicates: ["CALLS"] });
    await client.expand("a", { direction: "in", predicates: ["CALLS"], hops: 2 });
    await client.expand("b", { direction: "in", predicates: ["CALLS"] });
    await client.entity("a");
    await client.entity("a");

    expect(b.seen.map((s) => s.path)).toEqual([
      "/v1/expand", "/v1/expand", "/v1/expand", "/v1/expand", "/v1/entity/a",
    ]);
  });

  it("hands every caller its own copy, so one caller's edits never reach another", async () => {
    const b = await backend(expandReply);
    const client = new IxClient(b.endpoint, undefined, { shareReads: true });

    const first = await client.expand("a");
    first.nodes.sort((x: { id: string }, y: { id: string }) => (x.id < y.id ? 1 : -1)).push({ id: "added", kind: "function" } as GraphNode);
    const second = await client.expand("a");

    expect(second.nodes).toEqual([{ id: "a-n", kind: "function" }, { id: "a-m", kind: "function" }]);
    expect(b.seen).toHaveLength(1);
  });

  it("never shares a write", async () => {
    const b = await backend(() => ({ body: [{ status: "Ok", rev: 1 }] }));
    const client = new IxClient(b.endpoint, undefined, { shareReads: true });

    await client.commitPatchBatch([]);
    await client.commitPatchBatch([]);

    expect(b.seen).toHaveLength(2);
  });

  it("does not keep a failure: the next identical read asks again", async () => {
    let fail = true;
    const b = await backend((request) => {
      if (fail) { fail = false; return { status: 503, body: "busy" }; }
      return expandReply(request);
    });
    const client = new IxClient(b.endpoint, undefined, { shareReads: true });

    await expect(client.expand("a")).rejects.toThrow("503: busy");
    await expect(client.expand("a")).resolves.toEqual({ nodes: [{ id: "a-n", kind: "function" }, { id: "a-m", kind: "function" }], edges: [] });
    expect(b.seen).toHaveLength(2);
  });

  it("is off by default: a plain client sends every request it is asked to", async () => {
    const b = await backend(expandReply);
    const client = new IxClient(b.endpoint);

    await Promise.all([client.expand("a"), client.expand("a")]);
    await client.expand("a");

    expect(b.seen).toHaveLength(3);
  });

  it("keeps the status in a non-JSON 2xx error, as the unshared path always did", async () => {
    const b = await backend(() => ({ body: "<html>proxy</html>" }));
    for (const options of [{}, QUERY_CLIENT_OPTIONS]) {
      const client = new IxClient(b.endpoint, undefined, options);
      await expect(client.expand("a")).rejects.toThrow("200: response body is not JSON: <html>proxy</html>");
    }
  });
});

describe("IxClient maxInFlight", () => {
  it("holds concurrent requests to the cap", async () => {
    const b = await backend(expandReply, 15);
    const client = new IxClient(b.endpoint, undefined, { maxInFlight: 3 });

    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const results = await Promise.all(ids.map((id) => client.expand(id)));

    expect(b.seen).toHaveLength(12);
    expect(b.peak()).toBeLessThanOrEqual(3);
    expect(results.map((r) => r.nodes[0].id)).toEqual(ids.map((id) => `${id}-n`));
  });
});

describe("RequestMemo", () => {
  it("shares a pending load and counts the hits", async () => {
    const memo = new RequestMemo<number>();
    let loads = 0;
    const load = async () => { loads++; return 7; };

    const values = await Promise.all([memo.run("k", load), memo.run("k", load), memo.run("j", load)]);

    expect(values).toEqual([7, 7, 7]);
    expect(loads).toBe(2);
    expect(memo.hits).toBe(1);
  });

  it("evicts a rejected load", async () => {
    const memo = new RequestMemo<number>();
    await expect(memo.run("k", async () => { throw new Error("no"); })).rejects.toThrow("no");
    await expect(memo.run("k", async () => 1)).resolves.toBe(1);
    expect(memo.hits).toBe(0);
  });
});

describe("Limiter", () => {
  it("runs at most `max` at once and starts waiters in arrival order", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (i: number) => limiter.run(async () => {
      started.push(i);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return i;
    });

    const out = await Promise.all([0, 1, 2, 3, 4, 5].map(task));

    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("frees the slot when a task throws", async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("refuses a cap that is not a positive integer", () => {
    expect(() => new Limiter(0)).toThrow();
    expect(() => new Limiter(1.5)).toThrow();
  });
});

describe("mapLimit", () => {
  it("returns results in input order whatever order they finish in", async () => {
    const delays = [30, 5, 20, 0, 10];
    let active = 0;
    let peak = 0;
    const out = await mapLimit(delays, 2, async (ms, index) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active--;
      return `${index}:${ms}`;
    });

    expect(out).toEqual(["0:30", "1:5", "2:20", "3:0", "4:10"]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
  });
});
