// Copyright 2026 Ix Infrastructure Inc.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createIxMcpServer,
  IX_MCP_TOOL_NAMES,
  type IxRunner,
} from "../../mcp/server.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(runIx: IxRunner, proAvailable = false): Promise<Client> {
  const server = createIxMcpServer({ version: "test", runIx, proAvailable });
  const client = new Client({ name: "ix-mcp-annotations-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

describe("ix mcp tool annotations", () => {
  it("classifies every catalogued tool", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }), true);
    const tools = await client.listTools();

    // The annotation table is keyed by the catalog, so a tool added without a
    // classification is a type error upstream of this test. This guard keeps
    // the runtime behavior honest regardless of how the table evolves.
    for (const name of IX_MCP_TOOL_NAMES) {
      const tool = tools.tools.find((entry) => entry.name === name);
      expect(tool, `tool ${name} not advertised`).toBeDefined();
      expect(tool?.annotations, `tool ${name} has no annotations`).toBeDefined();
    }
  });

  it("marks mutating tools destructive, non-idempotent, and non-read-only", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    }, true);
    const byName = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry]));

    // ix_decide is deliberately absent: it lives in @ix/pro, so its behavior
    // cannot be verified from here. See the Pro-tool case below.
    for (const name of ["ix_map", "ix_smells", "ix_ingest"]) {
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
      expect(byName.get(name)?.annotations?.idempotentHint, name).toBe(false);
    }

    await client.callTool({ name: "ix_smells", arguments: {} });
    expect(calls).toEqual([["smells", "--format=json"]]);
    expect(calls[0]).not.toContain("--list");
  });

  it("asserts no behavioral hint for tools implemented outside this repository", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }), true);
    const byName = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry]));

    // Clients use readOnlyHint to decide whether a call needs the user's
    // approval. Claiming it for @ix/pro's code — which this package cannot see —
    // would trade a confirmation prompt for an unverified claim. A title is the
    // most these can honestly carry.
    for (const name of ["ix_briefing", "ix_decisions", "ix_decide"]) {
      const annotations = byName.get(name)?.annotations;
      expect(annotations?.title, name).toBeTruthy();
      expect(annotations?.readOnlyHint, name).toBeUndefined();
      expect(annotations?.destructiveHint, name).toBeUndefined();
      expect(annotations?.idempotentHint, name).toBeUndefined();
      expect(annotations?.openWorldHint, name).toBeUndefined();
    }
  });

  it("does not call ix_read graph-bounded, because it is not", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }));
    const byName = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry]));

    // `ix read` resolves an exact file path before consulting the graph, so a
    // title promising a graph bound describes only part of the command.
    expect(byName.get("ix_read")?.annotations?.title).not.toMatch(/graph-bounded/i);
  });

  it("marks graph reads read-only and idempotent", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }), true);
    const byName = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry]));

    for (const name of ["ix_health", "ix_locate", "ix_text", "ix_read", "ix_history", "ix_stats"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.idempotentHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it("marks only GitHub ingestion as open-world", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }), true);
    const byName = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry]));

    // ix_ingest is the one tool that reaches outside the host (GitHub API).
    expect(byName.get("ix_ingest")?.annotations?.openWorldHint).toBe(true);
    // Local graph reads, smell detection, and the local map refresh do not.
    expect(byName.get("ix_map")?.annotations?.openWorldHint).toBe(false);
    expect(byName.get("ix_smells")?.annotations?.openWorldHint).toBe(false);
    expect(byName.get("ix_text")?.annotations?.openWorldHint).toBe(false);
  });

  it("advertises a truthful non-empty title for every tool", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }), true);
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((entry) => [entry.name, entry]));

    for (const name of IX_MCP_TOOL_NAMES) {
      const title = byName.get(name)?.annotations?.title;
      expect(typeof title, `tool ${name} has no title annotation`).toBe("string");
      expect((title ?? "").length, `tool ${name} title is empty`).toBeGreaterThan(0);
    }
  });
});
