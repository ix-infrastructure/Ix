// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInProcessRunner } from "../../mcp/runner.js";
import {
  createIxMcpServer,
  IX_MCP_CORE_TOOL_NAMES,
  IX_MCP_INSTRUCTIONS,
  IX_MCP_TOOL_NAMES,
  type IxRunner,
} from "../../mcp/server.js";
import { NEXT_READ_MAX_LINES, nextReads, nextToolCalls, truncationAdvice } from "../commands/context.js";
import { inferRiskSemantics, type ImpactFacts } from "../impact/risk-semantics.js";
import { disambiguationHint, forMcp, IX_CALLER_ENV, toolCall } from "../next-step.js";
import { roleHint } from "../role-filter.js";
import { reportAmbiguousTarget } from "../ui.js";

const CORE = new Set<string>(IX_MCP_CORE_TOOL_NAMES);

/**
 * What an MCP hint must never contain: a CLI flag, a CLI command, or a tool a
 * core session does not have.
 */
function expectRunnableOverMcp(text: string): void {
  expect(text, text).not.toMatch(/(^|\s)--[a-z]/);
  expect(text, text).not.toMatch(/`?\bix (read|callers|callees|imports|imported-by|impact|context|contains|depends|conflicts|explain|map|text|search)\b/);
  for (const tool of text.match(/\bix_[a-z_]+/g) ?? []) {
    expect(CORE.has(tool), `${tool} is not a core tool, in: ${text}`).toBe(true);
  }
}

function withCaller(value: string | undefined): void {
  if (value === undefined) delete process.env[IX_CALLER_ENV];
  else process.env[IX_CALLER_ENV] = value;
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(runIx: IxRunner = async () => ({ ok: true, stdout: "ok", stderr: "" })): Promise<Client> {
  const server = createIxMcpServer({ version: "test", runIx });
  const client = new Client({ name: "ix-mcp-hints-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  clients.push(client);
  return client;
}

describe("server instructions", () => {
  it("reach the client in the initialize result", async () => {
    // The one channel a host that defers tool schemas still puts in front of
    // the model.
    const client = await connect();
    expect(client.getInstructions()).toBe(IX_MCP_INSTRUCTIONS);
  });

  it("are a few lines, name the tools to reach for first, and say when not to", () => {
    const lines = IX_MCP_INSTRUCTIONS.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(8);
    for (const tool of ["ix_context", "ix_neighbors", "ix_impact"]) expect(IX_MCP_INSTRUCTIONS).toContain(tool);
    expect(IX_MCP_INSTRUCTIONS).toMatch(/Not for a literal string/);
    expect(IX_MCP_INSTRUCTIONS).toMatch(/Grep/);
  });

  it("name only tools every session has", () => {
    const named = IX_MCP_INSTRUCTIONS.match(/\bix_[a-z_]+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(CORE.has(tool), tool).toBe(true);
    // And every core tool is a real one.
    for (const tool of CORE) expect(IX_MCP_TOOL_NAMES as readonly string[]).toContain(tool);
  });
});

describe("hints produced for an MCP caller", () => {
  beforeEach(() => withCaller("mcp"));
  afterEach(() => withCaller(undefined));

  function bundle(
    target: { name: string; kind: string; path?: string },
    cut: Array<{ what: string; count: number }> = [],
    evidence: Array<Record<string, unknown>> = [],
  ): never {
    return {
      target: { id: "t", resolutionMode: "exact", ...target },
      evidence,
      truncation: {
        entitiesTruncated: 0,
        relationshipsTruncated: 0,
        evidenceTruncated: cut.reduce((n, c) => n + c.count, 0),
        charactersTruncated: 0,
        cut,
      },
    } as never;
  }

  it("send every truncated category to a core tool or to max_tokens", () => {
    const cuts = ["member", "caller", "dependent", "import", "call", "relationship", "claim", "conflict", "decision"];
    for (const kind of ["function", "file", "class"]) {
      for (const what of cuts) {
        const advice = truncationAdvice(bundle({ name: "verify", kind, path: "src/auth.ts" }, [{ what, count: 3 }]))!;
        expectRunnableOverMcp(advice);
        expect(advice, advice).toContain("max_tokens");
      }
    }
  });

  it("name the core tool that answers the same question", () => {
    const advice = truncationAdvice(bundle({ name: "verify", kind: "function", path: "src/auth.ts" }, [{ what: "caller", count: 4 }]));
    expect(advice).toContain("ix_neighbors symbol=verify relation=callers path=src/auth.ts");
  });

  it("close a symbol's bundle with callers and impact before any read", () => {
    const steps = nextToolCalls(bundle(
      { name: "verify", kind: "function", path: "src/auth.ts" },
      [],
      [{ location: { path: "src/auth.ts", lineStart: 10, lineEnd: 40 } }],
    ));
    expect(steps.map((s) => s.cmd)).toEqual([
      "ix_neighbors symbol=verify relation=callers path=src/auth.ts",
      "ix_impact target=verify path=src/auth.ts",
      "ix_read symbol=src/auth.ts:10-40",
    ]);
    for (const step of steps) {
      expectRunnableOverMcp(step.cmd);
      expect(step.why.length, step.cmd).toBeGreaterThan(0);
    }
  });

  // Maintainer decision: additive stale info for MCP. The range call stays;
  // a stale read step adds `stale` and, when the name re-anchors, `reanchor`.
  it("flag a stale read step and offer the re-anchored symbol read beside the range", () => {
    const stale = {
      ...(bundle(
        { name: "verify", kind: "function", path: "src/auth.ts" },
        [],
        [{ location: { path: "src/auth.ts", lineStart: 10, lineEnd: 40 }, refs: ["t"] }],
      ) as object),
      freshness: { stale: true },
    } as never;
    const read = nextToolCalls(stale).find((s) => s.cmd.startsWith("ix_read"))!;
    expect(read).toEqual({
      cmd: "ix_read symbol=src/auth.ts:10-40",
      why: "the top-ranked evidence",
      stale: true,
      reanchor: "ix_read symbol=verify path=src/auth.ts",
    });
    expectRunnableOverMcp(read.reanchor!);
    // The on-disk check says no: still flagged stale, no symbol form.
    expect(nextToolCalls(stale, () => false).find((s) => s.cmd.startsWith("ix_read"))).toEqual({
      cmd: "ix_read symbol=src/auth.ts:10-40",
      why: "the top-ranked evidence",
      stale: true,
    });
    // A fresh file carries neither key.
    const fresh = nextToolCalls(bundle(
      { name: "verify", kind: "function", path: "src/auth.ts" },
      [],
      [{ location: { path: "src/auth.ts", lineStart: 10, lineEnd: 40 }, refs: ["t"] }],
    ));
    for (const step of fresh) expect(Object.keys(step).sort()).toEqual(["cmd", "why"]);
  });

  it("close a file's bundle with its importers, by path", () => {
    const steps = nextToolCalls(bundle({ name: "auth.ts", kind: "file", path: "src/auth.ts" }));
    expect(steps[0].cmd).toBe("ix_neighbors symbol=src/auth.ts relation=imported_by");
    expect(steps[1].cmd).toBe("ix_impact target=src/auth.ts");
  });

  it("cap a suggested read, rather than hand over a 558-line range", () => {
    const steps = nextToolCalls(bundle(
      { name: "Big", kind: "class", path: "src/big.ts" },
      [],
      [{ location: { path: "src/big.ts", lineStart: 21, lineEnd: 578 } }],
    ));
    const read = steps.find((s) => s.cmd.startsWith("ix_read"))!;
    expect(read.cmd).toBe(`ix_read symbol=src/big.ts:21-${21 + NEXT_READ_MAX_LINES - 1}`);
    expect(read.why).toContain("of 558 lines");
  });

  it("offer include_tests, which ix_search takes, not --include-tests", () => {
    const hint = roleHint(3)!;
    expectRunnableOverMcp(hint);
    expect(hint).toContain("include_tests=true");
  });

  it("disambiguate with tool arguments", () => {
    const hint = disambiguationHint("Use --pick <n> or --path to disambiguate.");
    expectRunnableOverMcp(hint);
    expect(hint).toContain("pick=");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      reportAmbiguousTarget(
        "verify",
        {
          resolutionMode: "ambiguous",
          candidates: [
            { id: "a", name: "verify", kind: "function", path: "src/a.ts" },
            { id: "b", name: "verify", kind: "function", path: "src/b.ts" },
          ],
        },
        "llm",
      );
      const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
      const hintLine = printed.split("\n").find((line) => line.startsWith("hint "))!;
      expectRunnableOverMcp(hintLine);
      expect(hintLine).toContain("pick=<n>");
    } finally {
      log.mockRestore();
    }
  });

  it("send ix_impact's next step to a core tool", () => {
    const base: ImpactFacts = {
      name: "X",
      kind: "function",
      targetPath: "src/x.ts",
      members: 0,
      callers: 2,
      callees: 1,
      directImporters: 0,
      directDependents: 0,
      memberLevelCallers: 0,
      propagationBuckets: [],
    };
    const cases: ImpactFacts[] = [
      { ...base, name: "NodeKind", kind: "enum", members: 24, directImporters: 8, directDependents: 12 },
      { ...base, name: "pickBest", path: "ix-cli/src/cli/resolve.ts", callers: 1, callees: 4 },
      { ...base, name: "IxClient", kind: "class", members: 15, callers: 0, directImporters: 8, directDependents: 20, memberLevelCallers: 66 },
    ];
    let seen = 0;
    for (const facts of cases) {
      const next = inferRiskSemantics(facts).nextStep;
      if (next === undefined) continue;
      seen += 1;
      expectRunnableOverMcp(next);
      expect(next).toMatch(/ix_neighbors symbol=\S+ relation=(callers|imported_by)/);
    }
    expect(seen).toBeGreaterThanOrEqual(2);
  });
});

describe("hints produced for the CLI", () => {
  beforeEach(() => withCaller(undefined));

  it("are unchanged", () => {
    expect(forMcp()).toBe(false);
    expect(roleHint(1)).toBe("1 test/fixture candidate hidden. Use --include-tests to include.");
    expect(disambiguationHint("Use --pick <n> or --path to disambiguate.")).toBe("Use --pick <n> or --path to disambiguate.");
    expect(nextReads({ evidence: [{ location: { path: "src/a.ts", lineStart: 1, lineEnd: 900 } }] } as never)).toEqual([
      { cmd: "ix read src/a.ts:1-900", stale: false },
    ]);
  });
});

describe("toolCall", () => {
  it("drops empty arguments and quotes values with spaces", () => {
    expect(toolCall("ix_search", { term: "parse config", kind: undefined, limit: 5 })).toBe(
      'ix_search term="parse config" limit=5',
    );
  });
});

describe("the MCP runner", () => {
  afterEach(() => withCaller(undefined));

  it("marks every command it runs as serving MCP, and only while it runs", async () => {
    withCaller(undefined);
    const runIx = createInProcessRunner({
      createProgram: () => {
        const program = new Command();
        program.command("probe").action(() => console.log(`caller=${process.env[IX_CALLER_ENV] ?? "cli"}`));
        return program;
      },
    });
    const result = await runIx(["probe"]);
    expect(result.stdout.trim()).toBe("caller=mcp");
    expect(process.env[IX_CALLER_ENV]).toBeUndefined();
  });
});

describe("ix_context over MCP", () => {
  it("takes issue text, through a file that is gone after the call", async () => {
    const seen: Array<{ args: string[]; text?: string }> = [];
    const client = await connect(async (args) => {
      const flag = args.find((arg) => arg.startsWith("--from-issue="));
      const file = flag?.slice("--from-issue=".length);
      seen.push({ args, text: file ? readFileSync(file, "utf8") : undefined });
      return { ok: true, stdout: "context target=x", stderr: "" };
    });

    const result = await client.callTool({ name: "ix_context", arguments: { issue: "Login fails in verify()", max_tokens: 1500 } });

    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("Login fails in verify()");
    expect(seen[0].args).toContain("--max-tokens=1500");
    expect(seen[0].args).not.toContain("--");
    const file = seen[0].args.find((arg) => arg.startsWith("--from-issue="))!.slice("--from-issue=".length);
    expect(existsSync(file)).toBe(false);
  });

  it("forwards the disambiguation a target needs", async () => {
    const calls: string[][] = [];
    const client = await connect(async (args) => {
      calls.push(args);
      return { ok: true, stdout: "ok", stderr: "" };
    });
    await client.callTool({ name: "ix_context", arguments: { target: "verify", path: "src/auth.ts", pick: 2 } });
    await client.callTool({ name: "ix_impact", arguments: { target: "verify", kind: "function", pick: 1 } });
    await client.callTool({ name: "ix_search", arguments: { term: "verify", include_tests: true } });
    expect(calls).toEqual([
      ["context", "--path=src/auth.ts", "--pick=2", "--format=llm", "--", "verify"],
      ["impact", "--kind=function", "--pick=1", "--format=llm", "--", "verify"],
      ["search", "--limit=10", "--include-tests", "--format=llm", "--", "verify"],
    ]);
  });

  it("refuses combinations in its own terms, not the CLI's flags", async () => {
    const client = await connect();
    for (const args of [
      {},
      { target: "a", issue: "b" },
      { issue: "b", path: "src" },
      { target: "a", max_tokens: 1000, max_chars: 4000 },
    ]) {
      const result = await client.callTool({ name: "ix_context", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text, text).not.toMatch(/--[a-z]/);
    }
  });
});
