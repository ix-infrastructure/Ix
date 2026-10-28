// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { IxClient } from "../api.js";

const servers: Server[] = [];

/** A backend that reads the request and never answers. */
async function silentBackend(seen: unknown[]): Promise<string> {
  const server = createServer((req: IncomingMessage) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => seen.push(JSON.parse(body)));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => {
    s.closeAllConnections();
    s.close(() => r());
  })));
});

// The ambiguous record's container lookup bounds its own request, so a slow
// answer for a common name cannot hold up exit 2 for the 2-minute default.
describe("IxClient.expandByName", () => {
  it("gives up after timeoutMs, and keeps it out of the request body", async () => {
    const seen: unknown[] = [];
    const client = new IxClient(await silentBackend(seen));
    const started = Date.now();
    await expect(client.expandByName("get", { direction: "in", predicates: ["CONTAINS"], timeoutMs: 100 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen[0]).toEqual({ name: "get", direction: "in", predicates: ["CONTAINS"] });
  });
});
