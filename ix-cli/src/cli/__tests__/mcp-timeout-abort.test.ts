// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "../../client/factory.js";
import { combineSignals, currentRunSignal } from "../../client/run-signal.js";
import { createInProcessRunner } from "../../mcp/runner.js";
import { createIxMcpServer, type IxRunner } from "../../mcp/server.js";

/**
 * CL-14: an `ix mcp` tool call that hit its deadline returned, but the command
 * kept running: its backend request stayed open until the backend answered, and
 * its late exit code made the next failing call report ok=true. The runner now
 * aborts the run's signal at the deadline; clients and children take it.
 */

// A backend whose /v1/search never answers in time, recording when the
// connection closed and whether a response was ever sent.
let server: Server;
let endpoint: string;
const closes: Array<{ atMs: number; finished: boolean }> = [];
let started = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.startsWith("/v1/search")) {
        res.on("close", () => closes.push({ atMs: Date.now() - started, finished: res.writableFinished }));
        setTimeout(() => { if (!res.destroyed) res.end("[]"); }, 3_000);
        return;
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function program(): Command {
  const p = new Command();
  p.name("ix").exitOverride();
  p.command("hang-search").action(async () => {
    // Built through the factory, as every command's client is.
    await createClient({ endpoint }).search("x");
    console.log("answered");
  });
  p.command("abortable").action(async () => {
    await new Promise<void>((resolve, reject) => {
      const signal = currentRunSignal();
      const timer = setTimeout(resolve, 5_000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); });
    });
  });
  p.command("ignores-abort").option("--ms <ms>", "", "300").action(async (o: { ms: string }) => {
    await new Promise((resolve) => setTimeout(resolve, Number(o.ms)));
    process.exitCode = 1;
  });
  p.command("soft-fail").action(() => {
    console.log("error code=backend_error");
    process.exitCode = 1;
  });
  p.command("stderr-only-fail").action(() => {
    console.error("Error: 500: stats exploded");
    process.exitCode = 1;
  });
  return p;
}

describe("a timed-out tool call aborts its work", () => {
  it("closes the backend connection at the deadline instead of when the backend answers", async () => {
    const run = createInProcessRunner({ version: "t", createProgram: program });
    closes.length = 0;
    started = Date.now();
    const result = await run(["hang-search"], 200);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/timed out after 200ms/);
    expect(Date.now() - started).toBeLessThan(1_500);
    // Closed by the client, unanswered, long before the backend's 3 s reply.
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toHaveLength(1);
    expect(closes[0]!.finished).toBe(false);
    expect(closes[0]!.atMs).toBeLessThan(1_000);
  });

  it("leaves no orphan when the command honours the abort, so the next failure is reported", async () => {
    const run = createInProcessRunner({ version: "t", createProgram: program });
    const timedOut = await run(["abortable"], 50);
    expect(timedOut.ok).toBe(false);
    // With an orphan alive the exit code is distrusted and this came back ok.
    expect((await run(["soft-fail"], 5_000)).ok).toBe(false);
  });

  it("waits only a bounded time for a command that ignores the abort", async () => {
    const run = createInProcessRunner({ version: "t", createProgram: program, abortSettleMs: 100, orphanGraceMs: 2_000 });
    const t0 = Date.now();
    const result = await run(["ignores-abort", "--ms", "1500"], 50);
    expect(result.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(800);
  });

  it("reports stderr-only output as a failure while an orphan makes the exit code untrustworthy", async () => {
    const run = createInProcessRunner({ version: "t", createProgram: program, abortSettleMs: 0, orphanGraceMs: 2_000 });
    expect((await run(["ignores-abort", "--ms", "400"], 20)).ok).toBe(false);
    // An orphan is alive: the exit code cannot be read, but a command that
    // printed nothing on stdout and an error on stderr did not succeed.
    const result = await run(["stderr-only-fail"], 5_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/stats exploded/);
    await new Promise((r) => setTimeout(r, 450));
  });
});

describe("run signal plumbing", () => {
  it("there is no run signal outside a run, and combining keeps whichever exists", () => {
    expect(currentRunSignal()).toBeUndefined();
    const a = new AbortController();
    const b = new AbortController();
    expect(combineSignals(a.signal, undefined)).toBe(a.signal);
    expect(combineSignals(undefined, b.signal)).toBe(b.signal);
    expect(combineSignals()).toBeUndefined();
    const both = combineSignals(a.signal, b.signal)!;
    b.abort();
    expect(both.aborted).toBe(true);
  });
});

describe("the MCP server never reports a silent JSON failure as {}", () => {
  async function callMap(runIx: IxRunner): Promise<CallToolResult> {
    const mcp = createIxMcpServer({ version: "test", runIx, tools: "all" });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st);
    await client.connect(ct);
    try {
      return (await client.callTool({ name: "ix_map", arguments: {} })) as CallToolResult;
    } finally {
      await client.close();
    }
  }

  it("empty stdout with stderr is an error carrying the stderr", async () => {
    const result = await callMap(async () => ({ ok: true, stdout: "", stderr: "Error: 500: stats exploded" }));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/stats exploded/);
  });

  it("both empty keeps the old {} answer", async () => {
    const result = await callMap(async () => ({ ok: true, stdout: "", stderr: "" }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: "text", text: "{}" });
  });
});
