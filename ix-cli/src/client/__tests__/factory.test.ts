// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClient as createClientAsync } from "../../cli/config.js";
import { IxClient } from "../api.js";
import { createClient } from "../factory.js";

const servers: Server[] = [];
let savedEndpoint: string | undefined;

/** A backend that answers every request with an empty expand and counts them. */
async function backend() {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ nodes: [], edges: [] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests: () => requests,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

beforeEach(() => {
  savedEndpoint = process.env.IX_ENDPOINT;
});

afterEach(async () => {
  if (savedEndpoint === undefined) delete process.env.IX_ENDPOINT;
  else process.env.IX_ENDPOINT = savedEndpoint;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const read = (client: IxClient) => client.expand("a", { direction: "in", predicates: ["CALLS"] });

describe("createClient", () => {
  it("uses the configured endpoint unless one is passed", () => {
    process.env.IX_ENDPOINT = "http://127.0.0.1:1";
    expect(createClient().endpoint).toBe("http://127.0.0.1:1");
    expect(createClient({ endpoint: "http://127.0.0.1:2" }).endpoint).toBe("http://127.0.0.1:2");
  });

  it("shares repeated reads only for a query client", async () => {
    const b = await backend();
    process.env.IX_ENDPOINT = b.endpoint;

    const plain = createClient();
    await read(plain);
    await read(plain);
    expect(b.requests()).toBe(2);
    expect(plain.sharedReadHits).toBe(0);

    const query = createClient({ query: true });
    await read(query);
    await read(query);
    expect(b.requests()).toBe(3);
    expect(query.sharedReadHits).toBe(1);
  });

  it("aborts every request once the deadline signal fires", async () => {
    const b = await backend();
    const client = createClient({ endpoint: b.endpoint, deadlineSignal: AbortSignal.abort() });

    await expect(read(client)).rejects.toThrow();
    expect(b.requests()).toBe(0);
  });

  it("keeps the async createClient that @ix/pro imports from cli/config", async () => {
    process.env.IX_ENDPOINT = "http://127.0.0.1:3";
    const client = await createClientAsync();
    expect(client).toBeInstanceOf(IxClient);
    expect(client.endpoint).toBe("http://127.0.0.1:3");
  });
});
