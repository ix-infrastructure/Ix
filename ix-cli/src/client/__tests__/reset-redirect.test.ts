// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { IxClient } from "../api.js";
import { isBackendUnreachable } from "../../cli/errors.js";

const opId = "11111111-1111-4111-8111-111111111111";
const servers: Server[] = [];
type Seen = { method: string; path: string; body: string };

// 127.0.0.2 is loopback, but deliberately selects the remote async branch of
// IxClient. Real fetch and real servers are used; no network error is mocked.
async function fixture(reply: (request: Seen, response: ServerResponse) => void, host = "127.0.0.2") {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const record = { method: request.method ?? "", path: request.url ?? "", body };
      seen.push(record);
      reply(record, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => { server.off("error", reject); resolve(); });
  });
  return { server, seen, endpoint: `http://${host}:${(server.address() as AddressInfo).port}` };
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function close(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

afterEach(async () => { await Promise.all(servers.splice(0).map(close)); });

describe.each(["reset", "resetCode"] as const)("%s never follows a reset redirect", method => {
  const stem = method === "reset" ? "/v1/reset" : "/v1/reset/code";

  it("completes the direct asynchronous request and matching status", async () => {
    const remote = await fixture((request, response) => {
      if (request.path === `${stem}/async`) json(response, { opId }, 202);
      else json(response, { opId, state: "done" });
    });
    await expect(new IxClient(remote.endpoint)[method]()).resolves.toMatchObject({ ok: true });
    expect(remote.seen).toEqual([
      { method: "POST", path: `${stem}/async`, body: "{}" },
      { method: "GET", path: `/v1/reset/status/${opId}`, body: "" },
    ]);
  });

  it("preserves a direct local synchronous reset", async () => {
    const local = await fixture((_request, response) => json(response, { ok: true }), "127.0.0.1");
    await expect(new IxClient(local.endpoint)[method]()).resolves.toMatchObject({ ok: true });
    expect(local.seen).toEqual([{ method: "POST", path: stem, body: "{}" }]);
  });

  it("preserves synchronous fallback for a direct async 404", async () => {
    const remote = await fixture((request, response) => {
      if (request.path === `${stem}/async`) json(response, {}, 404);
      else json(response, { ok: true });
    });
    await expect(new IxClient(remote.endpoint)[method]()).resolves.toMatchObject({ ok: true });
    expect(remote.seen).toEqual([
      { method: "POST", path: `${stem}/async`, body: "{}" },
      { method: "POST", path: stem, body: "{}" },
    ]);
  });

  it("preserves unreachable classification when the initial connection is refused", async () => {
    const closed = await fixture((_request, response) => json(response, {}));
    await close(closed.server);
    const failure = await new IxClient(closed.endpoint)[method]().catch((error: unknown) => error);
    expect(closed.seen).toEqual([]);
    expect(failure).toMatchObject({ cause: { code: "ECONNREFUSED" } });
    expect(isBackendUnreachable(failure)).toBe(true);
  });

  it.each([307, 308])("does not replay the POST after a %s start response", async status => {
    const remote = await fixture((request, response) => {
      if (request.path === `${stem}/async`) {
        response.writeHead(status, { location: "/redirected-reset" }); response.end();
      } else if (request.path === "/redirected-reset") json(response, { opId }, 202);
      else json(response, { opId, state: "done" });
    });
    await expect(new IxClient(remote.endpoint)[method]()).rejects.toThrow("Do not repeat the reset");
    expect(remote.seen).toEqual([{ method: "POST", path: `${stem}/async`, body: "{}" }]);
  });

  it.each([302, 303])("does not interpret a redirected %s/404 as an absent async route", async status => {
    const remote = await fixture((request, response) => {
      if (request.path === `${stem}/async`) {
        response.writeHead(status, { location: "/missing" }); response.end();
      } else if (request.path === "/missing") json(response, {}, 404);
      else json(response, { ok: true, message: "synthetic reset" });
    });
    await expect(new IxClient(remote.endpoint)[method]()).rejects.toThrow("Do not repeat the reset");
    expect(remote.seen).toEqual([{ method: "POST", path: `${stem}/async`, body: "{}" }]);
  });

  it("does not classify a refused redirect target as an unsent reset", async () => {
    const closed = await fixture((_request, response) => json(response, {}));
    await close(closed.server);
    const remote = await fixture((_request, response) => {
      response.writeHead(307, { location: `${closed.endpoint}/redirected-reset` }); response.end();
    });
    const failure = await new IxClient(remote.endpoint)[method]().catch((error: unknown) => error);
    expect(remote.seen).toEqual([{ method: "POST", path: `${stem}/async`, body: "{}" }]);
    expect(failure).toMatchObject({ name: "ResetReconciliationError" });
    expect((failure as Error).message).toContain("Do not repeat the reset");
    expect(isBackendUnreachable(failure)).toBe(false);
  });

  it("does not accept completion from a redirected status route", async () => {
    const remote = await fixture((request, response) => {
      if (request.path === `${stem}/async`) json(response, { opId }, 202);
      else if (request.path === `/v1/reset/status/${opId}`) {
        response.writeHead(302, { location: "/unrelated-status" }); response.end();
      } else json(response, { opId, state: "done" });
    });
    const failure = new IxClient(remote.endpoint)[method]();
    await expect(failure).rejects.toThrow(opId);
    await expect(failure).rejects.toThrow("Do not repeat the reset");
    expect(remote.seen.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `${stem}/async` }, { method: "GET", path: `/v1/reset/status/${opId}` },
    ]);
  });

  it.each([307, 308])("does not replay a local synchronous POST after %s", async status => {
    const local = await fixture((request, response) => {
      if (request.path === stem) {
        response.writeHead(status, { location: "/redirected-reset" }); response.end();
      } else json(response, { ok: true, message: "synthetic reset" });
    }, "127.0.0.1");
    await expect(new IxClient(local.endpoint)[method]()).rejects.toThrow("Do not repeat the reset");
    expect(local.seen).toEqual([{ method: "POST", path: stem, body: "{}" }]);
  });

  it("does not replay a redirected synchronous fallback", async () => {
    const remote = await fixture((request, response) => {
      if (request.path === `${stem}/async`) json(response, {}, 404);
      else if (request.path === stem) {
        response.writeHead(307, { location: "/redirected-reset" }); response.end();
      } else json(response, { ok: true, message: "synthetic reset" });
    });
    await expect(new IxClient(remote.endpoint)[method]()).rejects.toThrow("Do not repeat the reset");
    expect(remote.seen.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `${stem}/async` }, { method: "POST", path: stem },
    ]);
  });
});
