// Copyright 2026 Ix Infrastructure Inc.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { capRecordStream, createIxMcpServer, type IxRunner } from "../../mcp/server.js";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(runIx: IxRunner): Promise<Client> {
  // `all`: the four single-relation tools are what these cases are about, and
  // `--tools=core` advertises `ix_neighbors` in their place.
  const server = createIxMcpServer({ version: "test", runIx, tools: "all" });
  const client = new Client({ name: "ix-mcp-params-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

function recorder(stdout = "ok") {
  const calls: string[][] = [];
  const runIx: IxRunner = async (args) => {
    calls.push(args);
    return { ok: true, stdout, stderr: "" };
  };
  return { calls, runIx };
}

describe("resolving an ambiguous symbol over MCP", () => {
  it("forwards --kind, --path, --pick and --limit on an edge tool", async () => {
    // Without these there was no second call that could get past "Ambiguous
    // symbol": the CLI's own disambiguation flags were unreachable over MCP,
    // and the agent's only move was to shell out.
    const { calls, runIx } = recorder();
    const client = await connect(runIx);

    await client.callTool({
      name: "ix_callers",
      arguments: { symbol: "config", kind: "function", path: "src/cli", pick: 2, limit: 20 },
    });

    expect(calls).toEqual([
      ["callers", "--kind=function", "--path=src/cli", "--pick=2", "--limit=20", "--format=llm", "--", "config"],
    ]);
  });

  it("sends nothing for the flags the caller left out", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_imports", arguments: { symbol: "config.ts" } });
    expect(calls).toEqual([["imports", "--format=llm", "--", "config.ts"]]);
  });

  it("does not offer ix_explain a --limit it has no flag for", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }));
    const explain = (await client.listTools()).tools.find((t) => t.name === "ix_explain")!;
    const properties = (explain.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(["kind", "path", "pick", "symbol"]);
  });

  it("gives ix_read the same flags, and no size bound of its own", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_read", arguments: { symbol: "config", pick: 1 } });
    expect(calls).toEqual([["read", "--pick=1", "--format=llm", "--", "config"]]);
  });
});

describe("ix_search", () => {
  it("exists at all, which is the point", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("ix_search");
  });

  it("forwards its filters, and a bounded default limit", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_search", arguments: { term: "resolveWorkspace", kind: "function" } });
    expect(calls).toEqual([["search", "--limit=10", "--kind=function", "--format=llm", "--", "resolveWorkspace"]]);
  });
});

describe("bounds", () => {
  it("gives ix_trace a depth it defaults to", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_trace", arguments: { symbol: "verify" } });
    expect(calls).toEqual([["trace", "--depth=3", "--format=llm", "--", "verify"]]);
  });

  it("caps a record stream on a line boundary and says it did", async () => {
    const line = "node name=a kind=function path=src/a.ts\n";
    const big = line.repeat(2000);
    const capped = capRecordStream(big, "ix_text");

    expect(capped.length).toBeLessThan(big.length);
    const lines = capped.split("\n");
    // Every record before the marker is whole.
    for (const l of lines.slice(0, -1)) {
      if (l) expect(l).toBe(line.trimEnd());
    }
    expect(lines[lines.length - 1]).toMatch(
      /^truncated tool=ix_text shown_bytes=\d+ total_bytes=\d+ hint="/,
    );
  });

  it("leaves a result that fits exactly as it was", () => {
    expect(capRecordStream("node name=a\n", "ix_text")).toBe("node name=a\n");
  });

  it("caps through the tool, not only in the helper", async () => {
    const big = "node name=a kind=function path=src/a.ts\n".repeat(2000);
    const client = await connect(async () => ({ ok: true, stdout: big, stderr: "" }));
    const result = (await client.callTool({ name: "ix_text", arguments: { pattern: "a" } })) as CallToolResult;
    const first = result.content?.[0];
    expect(first?.type === "text" && first.text.includes("truncated tool=ix_text")).toBe(true);
    expect(first?.type === "text" && first.text.length).toBeLessThan(big.length);
  });
});
