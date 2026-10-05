// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { IxClient, errorBodyForMessage } from "../../client/api.js";
import { loadFileFromDisk } from "../commands/diff.js";
import { isVisualizerOnPort } from "../commands/view.js";
import { parseGitHubRepo } from "../github/fetch.js";
import { isRawId } from "../resolve.js";
import { capErrorDetail } from "../../mcp/server.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

async function server(handler: (url: string) => { status: number; body: string }): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    seen.push(req.url ?? "");
    const { status, body } = handler(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as AddressInfo).port, seen };
}

describe("ix diff reads only readable roots", () => {
  it("returns nothing for an absolute source_uri outside every workspace", () => {
    expect(loadFileFromDisk("/etc/passwd")).toBeNull();
  });
});

describe("ids in URL paths", () => {
  it("anchors isRawId: a UUID followed by a path is a name, not an id", () => {
    expect(isRawId("0b6f0c3e-1d2a-4c55-9a6e-3f1b2c4d5e6f")).toBe(true);
    expect(isRawId("0b6f0c3e-1d2a-4c55-9a6e-3f1b2c4d5e6f/../health")).toBe(false);
  });

  it("path-encodes entity ids", async () => {
    const b = await server(() => ({ status: 200, body: JSON.stringify({ node: {}, claims: [], edges: [] }) }));
    await new IxClient(`http://127.0.0.1:${b.port}`).entity("../health");
    expect(b.seen).toEqual(["/v1/entity/..%2Fhealth"]);
  });
});

describe("GitHub repo slugs", () => {
  it("accepts owner/repo and rejects anything that would change the API path", () => {
    expect(parseGitHubRepo("ix-infrastructure/Ix")).toEqual({ owner: "ix-infrastructure", repo: "Ix" });
    for (const bad of ["../x", "a/..", "./b", "a b/c", "a/b?x=1", "a/b/c", "a/"]) {
      expect(() => parseGitHubRepo(bad)).toThrow(/Invalid repo format/);
    }
  });
});

describe("error bodies in messages", () => {
  it("keeps a JSON body whole and cuts anything else to 300 characters", () => {
    const json = JSON.stringify({ error: "workspace_not_mapped", message: "x".repeat(1000) });
    expect(errorBodyForMessage(json)).toBe(json);
    const html = `<html>${"y".repeat(5000)}</html>`;
    const cut = errorBodyForMessage(html);
    expect(cut.length).toBeLessThan(400);
    expect(cut).toContain("more characters");
  });

  it("caps an MCP error result's detail", () => {
    expect(capErrorDetail("short")).toBe("short");
    expect(capErrorDetail("z".repeat(10_000)).length).toBeLessThan(4100);
  });
});

describe("ix view stop only signals the visualizer", () => {
  it("does not take another server on the recorded port for the visualizer", async () => {
    const other = await server(() => ({ status: 200, body: "{}" }));
    expect(await isVisualizerOnPort(other.port)).toBe(false);
  });

  it("recognises the visualizer's own 404 for an unknown /__ix route", async () => {
    const viz = await server((url) => ({ status: 404, body: JSON.stringify({ ok: false, error: `not found: ${url}` }) }));
    expect(await isVisualizerOnPort(viz.port)).toBe(true);
  });
});
