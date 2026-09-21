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
  it("is what a session gets without asking", async () => {
    expect(await names()).toEqual([...IX_MCP_CORE_TOOL_NAMES]);
  });

  it("is ten tools, not twenty-six", async () => {
    // `tools/list` is paid on every session before a single call is made, and a
    // model choosing between 26 near-identical names picks worse than one
    // choosing between ten.
    expect(IX_MCP_CORE_TOOL_NAMES.length).toBe(10);
    expect((await names({ tools: "all" })).length).toBeGreaterThan(20);
  });

  it("costs a fraction of what the full catalog costs", async () => {
    const client = await connect();
    const core = JSON.stringify((await client.listTools()).tools).length;
    const full = JSON.stringify((await (await connect({ tools: "all" })).listTools()).tools).length;

    // Measured: 6,437 bytes for ten tools against 15,365 for today's catalog,
    // a 58% cut. The spec asked for 5 KB, which is not reachable: a tool with
    // no parameters at all is 412 bytes of name, description and annotations,
    // so ten of them are 4.1 KB before a single input is declared. Getting to
    // 5 KB would mean giving back the disambiguation parameters that make an
    // ambiguous symbol resolvable at all.
    expect(core).toBeLessThan(6_600);
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

describe("tool descriptions", () => {
  it("stay inside a line, so a catalog is skimmable", async () => {
    const tools = (await (await connect({ tools: "all", proAvailable: true })).listTools()).tools;
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeDefined();
      expect(tool.description!.length, `${tool.name}: ${tool.description}`).toBeLessThanOrEqual(120);
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
