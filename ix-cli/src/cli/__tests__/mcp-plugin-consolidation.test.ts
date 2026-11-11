// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createIxMcpServer } from "../../mcp/server.js";

/**
 * #998: the openclaw and opencode plugins' `ix-decide` is a read-only pre-edit
 * verdict (touched_paths in, ALLOW/REVIEW out). `ix mcp`'s `ix_decide` is the
 * Pro command that records a design decision. Same name, different tools.
 * These tests keep the server and docs/mcp-plugin-consolidation.md from
 * treating them as one.
 */

const repoRoot = path.resolve(__dirname, "../../../..");
const DOC = "docs/mcp-plugin-consolidation.md";
/** The plugin verdict tool's parameters. */
const VERDICT_PARAMS = ["touched_paths", "intent", "risk_tolerance"];

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function listTools() {
  const server = createIxMcpServer({
    version: "test",
    runIx: async () => ({ ok: true, stdout: "{}", stderr: "" }),
    proAvailable: true,
    tools: "all",
  });
  const client = new Client({ name: "ix-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return (await client.listTools()).tools;
}

function readDoc(): string {
  return fs.readFileSync(path.join(repoRoot, DOC), "utf8");
}

describe("ix_decide is not the plugins' pre-edit verdict", () => {
  it("ix_decide takes a decision title, not the verdict's parameters", async () => {
    const decide = (await listTools()).find((tool) => tool.name === "ix_decide");
    expect(decide).toBeDefined();
    const props = Object.keys(decide?.inputSchema.properties ?? {});
    expect(props).toContain("title");
    expect(decide?.inputSchema.required ?? []).toContain("title");
    for (const param of VERDICT_PARAMS) expect(props, param).not.toContain(param);
  });

  it("no ix mcp tool serves the verdict, so the doc must list it as not served", async () => {
    // If a read-only verdict tool is added, this fails on purpose: update
    // docs/mcp-plugin-consolidation.md (and this test) to say it is served.
    for (const tool of await listTools()) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      expect(props, tool.name).not.toContain("touched_paths");
    }
  });
});

describe(`${DOC} keeps the two tools apart`, () => {
  it("lists the pre-edit verdict as not served", () => {
    const text = readDoc();
    expect(text).toContain("Not served: **the pre-edit verdict.**");
    expect(text).toMatch(/openclaw and opencode lose [^.]*pre-edit\s+verdict/);
  });

  it("does not call the plugins' ix-decide served by ix_decide", () => {
    const text = readDoc();
    expect(text).not.toMatch(/`ix_decide` and `ix_ingest` were real gaps and are now served/);
    for (const plugin of ["ix-openclaw-plugin", "ix-opencode-plugin"]) {
      const row = text.split("\n").find((line) => line.startsWith(`| ${plugin} |`));
      expect(row, plugin).toBeDefined();
      expect(row, plugin).not.toContain("`ix_decide`");
      expect(row, plugin).toContain("pre-edit verdict");
    }
  });

  it("warns plugins to drop 'call ix-decide before editing' before migrating", () => {
    expect(readDoc()).toMatch(/Before migrating openclaw or opencode[^.]*`ix-decide` before editing/s);
  });
});
