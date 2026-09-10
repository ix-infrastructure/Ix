// Copyright 2026 Ix Infrastructure Inc.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { createIxMcpServer, type IxRunner } from "../../mcp/server.js";
import { createInProcessRunner } from "../../mcp/runner.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(runIx: IxRunner): Promise<Client> {
  const server = createIxMcpServer({ version: "test", runIx });
  const client = new Client({ name: "ix-mcp-structured-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

describe("ix mcp structured output", () => {
  it("exposes parsed JSON objects as structuredContent", async () => {
    const client = await connect(async () => ({
      ok: true,
      stdout: JSON.stringify({ file_count: 3, outcome: "complete" }),
      stderr: "",
    }));

    const result = (await client.callTool({ name: "ix_map", arguments: {} })) as CallToolResult;

    expect(result.structuredContent).toEqual({ file_count: 3, outcome: "complete" });
    // The human-readable text remains for clients that prefer it.
    expect(result.content[0]?.type).toBe("text");
  });

  it("falls back to an empty object without throwing when output is not JSON", async () => {
    const client = await connect(async () => ({
      ok: true,
      stdout: "not json at all",
      stderr: "",
    }));

    const result = (await client.callTool({ name: "ix_map", arguments: {} })) as CallToolResult;

    // A future backend emitting a non-object shape must not fail the tool call;
    // the raw text still carries the answer.
    expect(result.structuredContent).toEqual({});
    expect(result.content[0]).toEqual({ type: "text", text: "not json at all" });
  });

  it("returns an MCP error without structured content when in-process output is truncated", async () => {
    const runIx = createInProcessRunner({
      maxOutputBytes: 100,
      createProgram: () => {
        const program = new Command();
        program
          .command("map")
          .option("--format <format>")
          .action(() => console.log(JSON.stringify({ payload: "x".repeat(500) })));
        return program;
      },
    });
    const client = await connect(runIx);

    const result = (await client.callTool({ name: "ix_map", arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const content = result.content[0];
    expect(content?.type).toBe("text");
    const error = JSON.parse(content?.type === "text" ? content.text : "{}");
    expect(error).toEqual({
      error: "[ix mcp] output exceeded 100 bytes and was truncated",
      tool: "ix_map",
    });
  });

  it("caps thrown command errors before returning them through MCP", async () => {
    const runIx = createInProcessRunner({
      maxOutputBytes: 100,
      createProgram: () => {
        const program = new Command();
        program
          .command("map")
          .option("--format <format>")
          .action(() => {
            throw new Error("E".repeat(500));
          });
        return program;
      },
    });
    const client = await connect(runIx);

    const result = (await client.callTool({ name: "ix_map", arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const content = result.content[0];
    const error = JSON.parse(content?.type === "text" ? content.text : "{}");
    expect(error).toEqual({
      error: "[ix mcp] output exceeded 100 bytes and was truncated",
      tool: "ix_map",
    });
  });

  it("exposes the filtered smell candidates as structuredContent", async () => {
    const client = await connect(async () => ({
      ok: true,
      stdout: JSON.stringify({
        rev: 1,
        run_at: "now",
        count: 2,
        candidates: [
          { file: "ix-cli/src/a.ts", smell: "orphan", confidence: 0.9, signals: ["x"] },
          { file: "src/b.ts", smell: "god_module", confidence: 0.8, signals: ["y"] },
        ],
      }),
      stderr: "",
    }));

    const result = (await client.callTool({ name: "ix_smells", arguments: { limit: 1 } })) as CallToolResult;

    const structured = result.structuredContent as { count: number; candidates: unknown[] };
    expect(structured.count).toBe(1);
    expect(structured.candidates).toHaveLength(1);
  });

  it("advertises outputSchema only for the verified JSON tools", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "{}", stderr: "" }));
    const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));

    for (const name of ["ix_map", "ix_ingest", "ix_smells"]) {
      expect(byName.get(name)?.outputSchema, name).toBeDefined();
    }
    // Tools whose `--format llm` output is human-oriented text have no stable
    // object schema to promise.
    expect(byName.get("ix_locate")?.outputSchema).toBeUndefined();
    expect(byName.get("ix_stats")?.outputSchema).toBeUndefined();
  });

  it("attaches structuredContent only where an outputSchema was declared", async () => {
    // runJson serves the Pro tools too. They are left out of TOOL_OUTPUT_SCHEMA
    // because their shape cannot be checked from this package — so attaching the
    // parsed object to their results anyway would hand clients exactly the data
    // the omission was meant to withhold, minus the contract to validate it.
    const server = createIxMcpServer({
      version: "test",
      proAvailable: true,
      runIx: async () => ({ ok: true, stdout: JSON.stringify({ shape: "unverified" }), stderr: "" }),
    });
    const client = new Client({ name: "ix-mcp-structured-pro-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);

    const declared = (await client.callTool({ name: "ix_map", arguments: {} })) as CallToolResult;
    expect(declared.structuredContent).toEqual({ shape: "unverified" });

    for (const name of ["ix_briefing", "ix_decisions"]) {
      const result = (await client.callTool({ name, arguments: {} })) as CallToolResult;
      expect(result.structuredContent, name).toBeUndefined();
      // The answer is still there, as text.
      expect(result.content[0], name).toEqual({ type: "text", text: JSON.stringify({ shape: "unverified" }) });
    }
  });
});
