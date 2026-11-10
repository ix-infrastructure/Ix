// Copyright 2026 Ix Infrastructure Inc.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createInProcessRunner } from "../../mcp/runner.js";
import { createIxMcpServer } from "../../mcp/server.js";
import { resetReadScope } from "../resolve.js";

const server = createServer((_req, res) => {
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "test_failure", message: "Request failed", next: "Try later" }));
});
let endpoint: string;
let home: string;

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ix-mcp-error-"));
  vi.stubEnv("IX_HOME", home);
  vi.stubEnv("IX_ENDPOINT", endpoint);
  vi.stubEnv("IX_FORMAT", "");
  vi.stubEnv("IX_DEBUG", "0");
  configure("text");
  resetReadScope();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetReadScope();
  rmSync(home, { recursive: true, force: true });
});

afterAll(async () => {
  await new Promise<void>((done, fail) => server.close((err) => err ? fail(err) : done()));
});

function configure(format: string) {
  writeFileSync(join(home, "config.yaml"), `format: ${format}\nworkspaces:\n` +
    `  - workspace_id: test-workspace\n    workspace_name: test\n    root_path: ${JSON.stringify(process.cwd())}\n    default: true\n`);
}

describe.each(["json", "llm"])("in-process error boundary in %s", (format) => {
  describe.each(["flag", "env", "config"])("from %s", (source) => {
    it.each([["stats"], ["smells", "--list"], ["smells"], ["subsystems", "--list"], ["subsystems"]])(
      "%s renders real backend failures", async (...args) => {
        if (source === "env") vi.stubEnv("IX_FORMAT", format);
        if (source === "config") configure(format);
        const exitCode = process.exitCode;
        const run = createInProcessRunner();
        const result = await run([...args, ...(source === "flag" ? ["--format", format] : [])]);

        expect(result.ok).toBe(false);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
        if (format === "json") {
          expect(JSON.parse(result.stdout)).toEqual({ error: "test_failure", message: "Request failed", next: "Try later" });
        } else {
          expect(result.stdout).toMatch(/^error code=test_failure message="Request failed" hint="Try later"\n$/);
        }
        expect(process.exitCode).toBe(exitCode);
      },
    );
  });

  it("renders usage failures and does not leak the format to the next call", async () => {
    const run = createInProcessRunner();
    const result = await run(["stats", "--bogus", "--format", format]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("");
    if (format === "json") expect(JSON.parse(result.stdout).error).toBe("usage_error");
    else expect(result.stdout).toMatch(/^error code=usage_error /);

    const next = await run(["stats"]);
    expect(next.ok).toBe(false);
    expect(next.stdout).toBe("");
    expect(next.stderr).toContain("Request failed");
  });
});

it("delivers a real stats failure to the MCP client as an error record", async () => {
  const mcp = createIxMcpServer({ version: "test", runIx: createInProcessRunner(), tools: "all" });
  const client = new Client({ name: "ix-mcp-error-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "ix_stats", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: 'error code=test_failure message="Request failed" hint="Try later"' }]);
  } finally {
    await client.close();
  }
});
