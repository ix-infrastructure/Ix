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

  it("forwards --offset on ix_neighbors", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_neighbors", arguments: { symbol: "config", relation: "imported_by", limit: 20, offset: 50 } });
    expect(calls).toEqual([
      ["imported-by", "--limit=20", "--offset=50", "--format=llm", "--", "config"],
    ]);
  });

  it("forwards --offset on the single-relation tools too", async () => {
    // Their truncation diagnostic carries next_offset=, so each one has to be
    // able to take it back; a hint the tool cannot act on is no hint.
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_callers", arguments: { symbol: "config", limit: 20, offset: 50 } });
    expect(calls).toEqual([
      ["callers", "--limit=20", "--offset=50", "--format=llm", "--", "config"],
    ]);
  });

  it("offers offset only on the edge tools", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }));
    const tools = (await client.listTools()).tools;
    const has = (name: string) =>
      "offset" in (((tools.find((t) => t.name === name)!.inputSchema) as { properties?: Record<string, unknown> }).properties ?? {});
    for (const name of ["ix_neighbors", "ix_callers", "ix_callees", "ix_imports", "ix_imported_by", "ix_text", "ix_inventory"]) {
      expect(has(name), name).toBe(true);
    }
    for (const name of ["ix_impact", "ix_read", "ix_explain"]) {
      expect(has(name), name).toBe(false);
    }
  });

  it("forwards --offset on ix_text and ix_inventory, which print next_offset= too", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_text", arguments: { pattern: "needle", offset: 20 } });
    await client.callTool({ name: "ix_inventory", arguments: { kind: "class", offset: 50 } });
    await client.callTool({ name: "ix_text", arguments: { pattern: "needle" } });
    await client.callTool({ name: "ix_inventory", arguments: { kind: "class" } });
    expect(calls[0]).toContain("--offset=20");
    expect(calls[1]).toContain("--offset=50");
    expect(calls[2].some((a) => a.startsWith("--offset"))).toBe(false);
    expect(calls[3].some((a) => a.startsWith("--offset"))).toBe(false);
  });

  it("rejects a negative offset on ix_text and ix_inventory", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    for (const [name, args] of [["ix_text", { pattern: "needle" }], ["ix_inventory", { kind: "class" }]] as const) {
      const result = await client.callTool({ name, arguments: { ...args, offset: -1 } })
        .then((r) => (r as CallToolResult).isError === true, () => true);
      expect(result, name).toBe(true);
    }
    expect(calls).toEqual([]);
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

describe("ix_impact limit", () => {
  it("forwards limit as --limit, so the CLI's 'Raise --limit' hint can be acted on", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_impact", arguments: { target: "verify", limit: 25 } });
    expect(calls).toEqual([["impact", "--limit=25", "--format=llm", "--", "verify"]]);
  });

  it("leaves argv unchanged when limit is omitted", async () => {
    const { calls, runIx } = recorder();
    const client = await connect(runIx);
    await client.callTool({ name: "ix_impact", arguments: { target: "verify" } });
    expect(calls).toEqual([["impact", "--format=llm", "--", "verify"]]);
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
