// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createInProcessRunner } from "../../mcp/runner.js";
import { createIxMcpServer } from "../../mcp/server.js";
import { registerContextCommand } from "../commands/context.js";

const state = vi.hoisted(() => ({
  root: "",
  nodes: [] as Array<{
    id: string;
    name: string;
    kind: string;
    attrs: { lineStart: number; lineEnd: number };
    provenance: { sourceUri: string };
  }>,
}));

vi.mock("../bootstrap.js", async (original) => ({
  ...(await original<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "fixture-workspace",
}));
vi.mock("../config.js", async (original) => ({
  ...(await original<typeof import("../config.js")>()),
  resolveWorkspaceRoot: () => state.root,
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));
// No backend recording is available for this fixture. Model its file nodes;
// keep issue planning, fact collection, CLI rendering and MCP transport real.
vi.mock("../../client/factory.js", () => ({
  createClient: () => ({
    workspaceSystem: async () => ({ systemId: null }),
    search: async (term: string) => state.nodes.filter((n) => n.name === term),
    entity: async (id: string) => ({ node: state.nodes.find((n) => n.id === id), edges: [] }),
    expand: async () => ({ nodes: [], edges: [] }),
    provenance: async (id: string) => ({ entityId: id, chain: [] }),
    listByKind: async () => [],
    contextForNode: async () => ({
      nodes: [],
      edges: [],
      claims: [],
      conflicts: [],
      decisions: [],
      intents: [],
      metadata: { asOfRev: 1, hopsExpanded: 1 },
    }),
  }),
}));
vi.mock("../graph-health.js", async (original) => ({
  ...(await original<typeof import("../graph-health.js")>()),
  checkGraphHealth: async () => ({ status: "unknown" }),
}));

let client: Client;
const runIx = createInProcessRunner({
  createProgram: () => {
    const program = new Command().name("ix").exitOverride();
    registerContextCommand(program);
    return program;
  },
});
const issue = "The call fails in src/foo.ts.";

beforeAll(async () => {
  state.root = mkdtempSync(join(tmpdir(), "ix-mcp-context-issue-"));
  cpSync(
    fileURLToPath(new URL("../../../../core-ingestion/test-fixtures/mini-repo/", import.meta.url)),
    state.root,
    { recursive: true },
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: state.root, encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Add fixture",
  );
  state.nodes = git("ls-files")
    .trim()
    .split("\n")
    .map((path) => ({
      id: `file:${path}`,
      name: basename(path),
      kind: "file",
      attrs: {
        lineStart: 1,
        lineEnd: readFileSync(join(state.root, path), "utf8").trimEnd().split("\n").length,
      },
      provenance: { sourceUri: path },
    }));
  const server = createIxMcpServer({ version: "test", runIx });
  client = new Client({ name: "context-issue-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
});

afterAll(async () => {
  await client?.close();
  rmSync(state.root, { recursive: true, force: true });
});

function text(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

it("defaults issue text to lean; full:true preserves the CLI bundle and costs more bytes", async () => {
  const file = join(state.root, "issue.md");
  writeFileSync(file, issue);
  const baseline = await runIx(["context", `--from-issue=${file}`, "--format=llm"]);
  expect(baseline.ok, baseline.stderr).toBe(true);
  const full = text(
    (await client.callTool({
      name: "ix_context",
      arguments: { issue, full: true },
    })) as CallToolResult,
  );
  const lean = text(
    (await client.callTool({ name: "ix_context", arguments: { issue } })) as CallToolResult,
  );
  expect(full).toBe(baseline.stdout.trim());
  expect(full).toMatch(/^context /);
  expect(lean).toMatch(/^start /m);
  expect(lean).toContain("src/foo.ts");
  expect(
    text(
      (await client.callTool({
        name: "ix_context",
        arguments: { issue, full: false },
      })) as CallToolResult,
    ),
  ).toBe(lean);
  expect(Buffer.byteLength(lean)).toBeLessThan(Buffer.byteLength(full));
  console.info(
    `MCP issue fixture bytes: full=${Buffer.byteLength(full)} lean=${Buffer.byteLength(lean)}`,
  );
});

it("supports both issue JSON shapes with structured:true", async () => {
  const lean = (await client.callTool({
    name: "ix_context",
    arguments: { issue, structured: true },
  })) as CallToolResult;
  const full = (await client.callTool({
    name: "ix_context",
    arguments: { issue, structured: true, full: true },
  })) as CallToolResult;
  expect(JSON.parse(text(lean)).kind).toBe("issue_lean");
  expect(lean.structuredContent?.kind).toBe("issue_lean");
  expect(JSON.parse(text(full)).schema).toBe("ix-context-bundle/1");
  expect(full.structuredContent?.schema).toBe("ix-context-bundle/1");
  expect(full.structuredContent).not.toHaveProperty("generatedAt");
  expect(Buffer.byteLength(text(lean))).toBeLessThan(Buffer.byteLength(text(full)));
});

it("keeps target bundles unchanged when full is supplied", async () => {
  const call = async (full?: boolean) =>
    client.callTool({
      name: "ix_context",
      arguments: { target: "src/foo.ts", structured: true, full },
    }) as Promise<CallToolResult>;
  const baseline = text(await call());
  expect(JSON.parse(baseline).schema).toBe("ix-context-bundle/1");
  expect(text(await call(false))).toBe(baseline);
  expect(text(await call(true))).toBe(baseline);
});

it("advertises the optional full issue bundle switch", async () => {
  const tool = (await client.listTools()).tools.find((t) => t.name === "ix_context")!;
  expect(tool.inputSchema.properties?.full).toMatchObject({ type: "boolean" });
  expect(tool.inputSchema.properties?.full).toHaveProperty(
    "description",
    expect.stringContaining("default lean"),
  );
  expect(tool.inputSchema.required ?? []).not.toContain("full");
});
