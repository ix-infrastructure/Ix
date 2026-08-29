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

/**
 * A complete `ix-context-bundle/1`.
 *
 * `ix_context` declares an outputSchema, and the MCP SDK validates
 * structuredContent against it, so any stub short of a whole bundle comes back
 * as an output-validation error rather than a result. Tests that only meant to
 * assert on argv still need a valid one.
 */
function contextBundle() {
  return {
    schema: "ix-context-bundle/1",
    generatedAt: "2026-01-01T00:00:00Z",
    target: { id: "e1", name: "Widget", kind: "class", resolutionMode: "exact" },
    entities: [{ id: "e1", name: "Widget", kind: "class", stale: false }],
    relationships: [],
    claims: [],
    decisions: [],
    conflicts: [],
    intents: [],
    // buildBundle always emits these two (context.ts: `historyLength:
    // facts.historyLength` and `stale`), so an empty provenance is a bundle the
    // CLI cannot actually produce. The fixture has to be a bundle that could
    // come off the wire, or it proves nothing about the real contract.
    provenance: { historyLength: 0, stale: false },
    freshness: { stale: false, classification: "current" },
    evidence: [],
    budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
    truncation: { entitiesTruncated: 0, relationshipsTruncated: 0, evidenceTruncated: 0, charactersTruncated: 0 },
    metadata: { rankingRule: "deterministic-tier" },
  };
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

    expect(calls).toEqual([["locate", "--format=llm", "--", "Widget"]]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "match name=Widget" }]);
  });

  it("marks a structured LLM error as an MCP error when the CLI exits successfully", async () => {
    const error = 'error code=unresolved_target message="No graph entity found for \\"Missing\\"."';
    const client = await connect(async () => ({
      ok: true,
      stdout: error,
      stderr: 'No entity found matching "Missing".',
    }));

    const result = await client.callTool({
      name: "ix_locate",
      arguments: { symbol: "Missing" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: error }]);
  });

  it("keeps error-like source lines after a successful LLM record as data", async () => {
    const output = [
      "content target=fixture.ts lines=1",
      'error code=source_text message="This is source, not a tool error."',
    ].join("\n");
    const client = await connect(async () => ({ ok: true, stdout: output, stderr: "" }));

    const result = await client.callTool({
      name: "ix_read",
      arguments: { symbol: "fixture.ts" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: output }]);
  });

  it("forwards ix_context target and bounded budgets as the CLI contract", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      // A whole bundle, not `{schema}` alone: ix_context declares an
      // outputSchema, and the SDK rejects structuredContent that does not match
      // it. Stubbing a partial bundle made this pass on a tool call that had
      // actually returned isError with an output-validation failure.
      return { ok: true, stdout: JSON.stringify(contextBundle()), stderr: "" };
    });

    const result = await client.callTool({
      name: "ix_context",
      arguments: { target: "Widget", max_entities: 20, max_evidence: 5 },
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      ["context", "--max-entities=20", "--max-evidence=5", "--format=json", "--", "Widget"],
    ]);
  });

  it("surfaces an output-schema violation instead of passing it off as a result", async () => {
    // The guard the test above used to lack: a bundle missing required fields
    // must not reach the caller looking like a successful call.
    const client = await connect(async () => ({
      ok: true,
      stdout: JSON.stringify({ schema: "ix-context-bundle/1" }),
      stderr: "",
    }));

    const result = await client.callTool({ name: "ix_context", arguments: { target: "Widget" } });

    expect(result.isError).toBe(true);
  });

  it("forwards ix_context max_chars to the CLI contract", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify(contextBundle()), stderr: "" };
    });

    const result = await client.callTool({ name: "ix_context", arguments: { target: "Widget", max_evidence: 3, max_chars: 5000 } });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([["context", "--max-evidence=3", "--max-chars=5000", "--format=json", "--", "Widget"]]);
  });

  it("returns ix_context structuredContent with the parsed bundle", async () => {
    const bundle = contextBundle();
    const client = await connect(async () => ({ ok: true, stdout: JSON.stringify(bundle), stderr: "" }));

    const result = await client.callTool({ name: "ix_context", arguments: { target: "Widget" } });

    expect(result.structuredContent).toEqual(bundle);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(bundle) }]);
  });

  it("marks an unparseable bundle output as an MCP error", async () => {
    const client = await connect(async () => ({ ok: true, stdout: "not json at all", stderr: "" }));

    const result = await client.callTool({ name: "ix_context", arguments: { target: "Widget" } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "not json at all" }]);
  });

  it("omits unset context budgets rather than sending empty flags", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify(contextBundle()), stderr: "" };
    });

    const result = await client.callTool({ name: "ix_context", arguments: { target: "src/main.ts" } });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([["context", "--format=json", "--", "src/main.ts"]]);
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

    expect(calls).toEqual([["map", "--format=json", "--", "src/service.ts"]]);
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
            { file: "ix-cli/src/a.ts", smell: "orphan" },
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

    expect(calls).toEqual([["smells", "--format=json"]]);
    const content = (result as CallToolResult).content[0];
    expect(content?.type).toBe("text");
    const parsed = JSON.parse(content?.type === "text" ? content.text : "{}");
    expect(parsed.count).toBe(1);
    // Substring, not prefix: `ix-cli/src/a.ts` is what `ix inventory --path src`
    // would have returned, and ix_smells must agree with it.
    expect(parsed.candidates).toEqual([{ file: "ix-cli/src/a.ts", smell: "orphan" }]);
  });

  it("maps ix_ingest onto the github form the plugins used", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    await client.callTool({
      name: "ix_ingest",
      arguments: { github: "owner/repo", since: "2026-01-01", limit: 25 },
    });

    expect(calls).toEqual([
      ["ingest", "--github=owner/repo", "--since=2026-01-01", "--limit=25", "--format=json"],
    ]);
  });

  it("rejects simultaneous ix_ingest path and github sources before running the CLI", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    const result = (await client.callTool({
      name: "ix_ingest",
      arguments: { path: "src", github: "owner/repo" },
    })) as CallToolResult;

    expect(calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: "path and github are mutually exclusive; provide only one",
          tool: "ix_ingest",
        }),
      },
    ]);
  });

  it("does not pass --limit when ingesting a local path", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    await client.callTool({ name: "ix_ingest", arguments: { path: "src" } });

    // --limit is a GitHub paging cap; on a path ingest it is meaningless.
    expect(calls).toEqual([["ingest", "--format=json", "--", "src"]]);
  });

  it("puts positional values behind -- so a leading dash is not read as a flag", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    await client.callTool({ name: "ix_text", arguments: { pattern: "--path", limit: 20 } });

    // Without the separator commander read `--path` as a flag and swallowed the
    // following `--limit` as its value, so the tool searched for the literal
    // text `20` under a directory named `--limit` and reported ok.
    expect(calls).toEqual([["text", "--limit=20", "--format=llm", "--", "--path"]]);
  });

  it("lists entities by kind without demanding a path, and forwards the limit", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "{}", stderr: "" };
    });

    // The form CLAUDE.md tells agents to use. A required `path` made it
    // impossible over MCP, and a dropped `--limit` silently capped every answer
    // at the CLI's default 50.
    await client.callTool({ name: "ix_inventory", arguments: { kind: "function", limit: 200 } });

    expect(calls).toEqual([["inventory", "--kind=function", "--limit=200", "--format=llm"]]);
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
      ["decide", "--rationale=Normalize edges", "--affects=Ingestion", "--format=json", "--", "Use CONTAINS"],
    ]);
  });
});
