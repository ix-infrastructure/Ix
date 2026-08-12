import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createIxMcpServer,
  IX_MCP_OSS_TOOL_NAMES,
  IX_MCP_PRO_TOOL_NAMES,
  IX_MCP_TOOL_NAMES,
  type IxRunner,
} from "../../mcp/server.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(runIx: IxRunner, proAvailable = false): Promise<Client> {
  const server = createIxMcpServer({ version: "test", runIx, proAvailable });
  const client = new Client({ name: "ix-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

describe("ix mcp", () => {
  it("exposes only the OSS catalog when Pro is not installed", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }));

    const result = await client.listTools();

    // Advertising a Pro tool on an OSS install hands the agent something whose
    // every call answers "requires Ix Pro" — indistinguishable from a failure.
    expect(result.tools.map((tool) => tool.name)).toEqual(IX_MCP_OSS_TOOL_NAMES);
    for (const pro of IX_MCP_PRO_TOOL_NAMES) {
      expect(result.tools.map((tool) => tool.name)).not.toContain(pro);
    }
  });

  it("adds the Pro catalog when Pro is installed", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }), true);

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual(IX_MCP_TOOL_NAMES);
  });

  it("covers every plugin tool that is not a composite or deprecated", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "ok", stderr: "" }), true);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    // The union exposed by ix-codex/cursor/gemini/openclaw/opencode-plugin,
    // less ix_query (deprecated), ix_neighbors and ix_docs_tool (composites of
    // callers/callees/depends and of overview), and ix_status (gemini's name
    // for ix_health).
    for (const tool of ["ix_decide", "ix_ingest", "ix_health", "ix_locate", "ix_impact"]) {
      expect(names).toContain(tool);
    }
  });

  it("maps tool input to the matching Ix command with compact output", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "match name=Widget", stderr: "" };
    });

    const result = await client.callTool({
      name: "ix_locate",
      arguments: { symbol: "Widget" },
    });

    expect(calls).toEqual([["locate", "Widget", "--format", "llm"]]);
    expect(result.content).toEqual([{ type: "text", text: "match name=Widget" }]);
  });

  it("marks Ix command failures as MCP errors", async () => {
    const client = await connect(async () => ({
      ok: false,
      stdout: "",
      stderr: "Session expired",
    }));

    const result = await client.callTool({ name: "ix_stats", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ error: "Session expired", tool: "ix_stats" }),
      },
    ]);
  });

  it("preserves structured CLI errors written to stdout", async () => {
    const client = await connect(async () => ({
      ok: false,
      stdout: "error code=backend_unreachable message=offline",
      stderr: "",
    }));

    const result = await client.callTool({ name: "ix_health", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: "error code=backend_unreachable message=offline",
          tool: "ix_health",
        }),
      },
    ]);
  });

  it("keeps the existing ix_map file argument contract", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    await client.callTool({ name: "ix_map", arguments: { file: "src/service.ts" } });

    expect(calls).toEqual([["map", "src/service.ts", "--format", "json"]]);
  });

  it("applies ix_smells path and limit compatibility without unsupported CLI flags", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: JSON.stringify({
          count: 3,
          candidates: [
            { file: "src/a.ts", smell: "orphan" },
            { file: "src/nested/b.ts", smell: "orphan" },
            { file: "test/c.ts", smell: "orphan" },
          ],
        }),
        stderr: "",
      };
    });

    const result = await client.callTool({
      name: "ix_smells",
      arguments: { path: "src", limit: 1 },
    });

    expect(calls).toEqual([["smells", "--format", "json"]]);
    const content = (result as CallToolResult).content[0];
    expect(content?.type).toBe("text");
    const parsed = JSON.parse(content?.type === "text" ? content.text : "{}");
    expect(parsed.count).toBe(1);
    expect(parsed.candidates).toEqual([{ file: "src/a.ts", smell: "orphan" }]);
  });

  it("maps ix_ingest onto the github form the plugins used", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    await client.callTool({ name: "ix_ingest", arguments: { github: "owner/repo", limit: 25 } });

    expect(calls).toEqual([["ingest", "--github", "owner/repo", "--limit", "25", "--format", "json"]]);
  });

  it("does not pass --limit when ingesting a local path", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    await client.callTool({ name: "ix_ingest", arguments: { path: "src" } });

    // --limit is a GitHub paging cap; on a path ingest it is meaningless.
    expect(calls).toEqual([["ingest", "src", "--format", "json"]]);
  });

  it("maps ix_decide onto the decide command", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    }, true);

    await client.callTool({
      name: "ix_decide",
      arguments: { title: "Use CONTAINS", rationale: "Normalize edges", affects: "Ingestion" },
    });

    expect(calls).toEqual([
      ["decide", "Use CONTAINS", "--rationale", "Normalize edges", "--affects", "Ingestion", "--format", "json"],
    ]);
  });
});
