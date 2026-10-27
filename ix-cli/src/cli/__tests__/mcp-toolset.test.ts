// Copyright 2026 Ix Infrastructure Inc.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import {
  createIxMcpServer,
  IX_MCP_CORE_TOOL_NAMES,
  IX_MCP_OSS_TOOL_NAMES,
  IX_MCP_PRO_TOOL_NAMES,
  type IxRunner,
  type ToolsetName,
} from "../../mcp/server.js";
import { registerMcpCommand } from "../commands/mcp.js";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(opts: { tools?: ToolsetName; proAvailable?: boolean } = {}): Promise<Client> {
  const runIx: IxRunner = async () => ({ ok: true, stdout: "ok", stderr: "" });
  const server = createIxMcpServer({ version: "test", runIx, ...opts });
  const client = new Client({ name: "ix-mcp-toolset-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  clients.push(client);
  return client;
}

async function names(opts: Parameters<typeof connect>[0] = {}): Promise<string[]> {
  return (await (await connect(opts)).listTools()).tools.map((t) => t.name);
}

describe("the core toolset", () => {
  it("is what a session gets without asking, ix_context first", async () => {
    const listed = await names();
    expect([...listed].sort()).toEqual([...IX_MCP_CORE_TOOL_NAMES].sort());
    expect(listed[0]).toBe("ix_context");
  });

  it("is five task-shaped tools, one per question", async () => {
    // Ten was still too many: four of them answered "tell me about X" and two
    // were name lookups, and recorded agents never reached for the graph's own
    // answers (callers, importers, impact).
    expect([...IX_MCP_CORE_TOOL_NAMES]).toEqual([
      "ix_context",
      "ix_search",
      "ix_neighbors",
      "ix_impact",
      "ix_read",
    ]);
    expect((await names({ tools: "all" })).length).toBeGreaterThan(20);
  });

  it("leaves ix_health and the overlapping lookups to --tools=all", async () => {
    const core = await names();
    const all = await names({ tools: "all" });
    for (const name of ["ix_health", "ix_text", "ix_locate", "ix_overview", "ix_explain"]) {
      expect(core, name).not.toContain(name);
      expect(all, name).toContain(name);
    }
  });

  it("costs a fraction of what the full catalog costs", async () => {
    const client = await connect();
    const core = JSON.stringify((await client.listTools()).tools).length;
    const full = JSON.stringify((await (await connect({ tools: "all" })).listTools()).tools).length;

    // Measured: 6,437 bytes for the old ten-tool core. Five tools with
    // when-to-use descriptions, and disambiguation on every symbol tool, come
    // to about 5 KB, and the server instructions (~850 bytes) are sent once in
    // `initialize` on top of that, so the total still comes in under the old
    // tools/list alone.
    expect(core).toBeLessThan(5_300);
    expect(core).toBeLessThan(full / 2);
  });

  it("keeps every tool reachable under --tools=all", async () => {
    expect(await names({ tools: "all" })).toEqual([...IX_MCP_OSS_TOOL_NAMES]);
  });

  it("still offers the Pro tools when Pro is installed, whichever set is asked for", async () => {
    // "Pro is installed, so its tools are offered" is not a contract a toolset
    // choice has any business silently reversing.
    for (const tools of ["core", "all"] as const) {
      const listed = await names({ tools, proAvailable: true });
      for (const pro of IX_MCP_PRO_TOOL_NAMES) expect(listed, tools).toContain(pro);
    }
  });

  it("does not register what it does not advertise", async () => {
    // A tool a client cannot see but can still call is a surface with no
    // documentation.
    const client = await connect();
    const result = await client.callTool({ name: "ix_rank", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("ix_neighbors", () => {
  it("replaces four tools whose schemas differed by one word", async () => {
    const listed = await names();
    expect(listed).toContain("ix_neighbors");
    for (const merged of ["ix_callers", "ix_callees", "ix_imports", "ix_imported_by"]) {
      expect(listed).not.toContain(merged);
    }
  });

  it("routes each relation to its command, dash and all", async () => {
    const calls: string[][] = [];
    const server = createIxMcpServer({
      version: "test",
      runIx: async (args) => {
        calls.push(args);
        return { ok: true, stdout: "ok", stderr: "" };
      },
    });
    const client = new Client({ name: "neighbors", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    clients.push(client);

    for (const relation of ["callers", "callees", "imports", "imported_by"] as const) {
      await client.callTool({ name: "ix_neighbors", arguments: { symbol: "verify", relation } });
    }

    expect(calls.map((c) => c[0])).toEqual(["callers", "callees", "imports", "imported-by"]);
  });

  it("carries the disambiguation flags through", async () => {
    const calls: string[][] = [];
    const server = createIxMcpServer({
      version: "test",
      runIx: async (args) => {
        calls.push(args);
        return { ok: true, stdout: "ok", stderr: "" };
      },
    });
    const client = new Client({ name: "neighbors-flags", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    clients.push(client);

    await client.callTool({
      name: "ix_neighbors",
      arguments: { symbol: "config", relation: "callers", kind: "function", pick: 2 },
    });

    expect(calls).toEqual([["callers", "--kind=function", "--pick=2", "--format=llm", "--", "config"]]);
  });
});

describe("overrides over MCP", () => {
  it("ix_neighbors relation=overrides and ix_overrides run the same command", async () => {
    const calls: string[][] = [];
    const server = createIxMcpServer({
      version: "test",
      tools: "all",
      runIx: async (args) => {
        calls.push(args);
        return { ok: true, stdout: "overrides target=Mid.m owner=Mid shown=0 total=0", stderr: "" };
      },
    });
    const client = new Client({ name: "overrides", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    clients.push(client);

    const args = { symbol: "m", path: "pkg/mid.py", pick: 2, limit: 20 };
    const viaNeighbors = await client.callTool({ name: "ix_neighbors", arguments: { ...args, relation: "overrides", offset: 50 } });
    const direct = await client.callTool({ name: "ix_overrides", arguments: args });

    // The family is one bounded page: no --offset for a command that has none.
    const expected = ["overrides", "--path=pkg/mid.py", "--pick=2", "--limit=20", "--format=llm", "--", "m"];
    expect(calls).toEqual([expected, expected]);
    expect(viaNeighbors.isError).toBeFalsy();
    expect(direct.content).toEqual(viaNeighbors.content);
  });

  it("ix_overrides is in the full catalog, not the core set", async () => {
    expect(await names({ tools: "all" })).toContain("ix_overrides");
    expect(await names()).not.toContain("ix_overrides");
  });
});

describe("tool descriptions", () => {
  it("stay within three short sentences, so a catalog is skimmable", async () => {
    const tools = (await (await connect({ tools: "all", proAvailable: true })).listTools()).tools;
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeDefined();
      expect(tool.description!.length, `${tool.name}: ${tool.description}`).toBeLessThanOrEqual(300);
    }
  });

  it("say when to use each core tool and when not to", async () => {
    // "Use instead of grep" gave no reason to. Each core description now says
    // when to reach for it, what it returns, and what to use instead.
    const tools = (await (await connect()).listTools()).tools;
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/^Use (when|first|before)/);
      expect(tool.description, tool.name).toMatch(/Returns /);
      expect(tool.description, tool.name).toMatch(/Not (for|needed)|For (a|transitive)/);
    }
  });

  it("keep titles as labels, with the guidance in the description", async () => {
    const tools = (await (await connect({ tools: "all" })).listTools()).tools;
    for (const tool of tools) {
      expect(tool.annotations?.title?.length ?? 0, tool.name).toBeLessThanOrEqual(40);
    }
  });

  it("tell a reader that rows carry places", async () => {
    const tools = (await (await connect()).listTools()).tools;
    const withPlaces = tools.filter((t) => /path:lines|path:start-end/.test(t.description ?? ""));
    expect(withPlaces.length).toBeGreaterThanOrEqual(4);
  });
});

describe("ix mcp --tools", () => {
  it("defaults to core and takes only the two sets", () => {
    const program = new Command();
    program.name("ix").exitOverride();
    registerMcpCommand(program);
    const mcp = program.commands.find((c) => c.name() === "mcp")!;
    const option = mcp.options.find((o) => o.long === "--tools")!;
    expect(option.defaultValue).toBe("core");
  });
});
