// Copyright 2026 Ix Infrastructure Inc.

/**
 * Every MCP tool's argv, parsed by the real command tree.
 *
 * Each tool in `mcp/server.ts` builds its flags by hand, and each command
 * declares its own in its command file. The other MCP tests check the argv
 * strings against a stub runner, so a flag a command stopped accepting still
 * passed there and broke the tool at run time with a usage error. That has
 * happened: `ix_explain` forwarded a `--limit` that `ix explain` rejects.
 *
 * Here the runner registers the real OSS commands, swaps every action for a
 * no-op, and parses the tool's argv with `exitOverride`. Commander's own checks
 * (unknown option, invalid choice, excess argument, option parsers) and the
 * shared `preAction` validation run exactly as they do for a real call; only
 * the command body is skipped.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import {
  createIxMcpServer,
  IX_MCP_JSON_RESULT_TOOLS,
  IX_MCP_OSS_TOOL_NAMES,
  IX_MCP_PRO_TOOL_NAMES,
  type IxRunner,
} from "../../mcp/server.js";
import { registerOssCommands } from "../register/oss.js";

type OssTool = (typeof IX_MCP_OSS_TOOL_NAMES)[number];
type Args = Record<string, unknown>;

/** One argv as the real command tree saw it. */
interface Parsed {
  args: string[];
  /** The command whose action ran, when the parse succeeded. */
  ran?: Command;
  /** The usage error, when it did not. */
  error?: string;
}

function walk(command: Command): Command[] {
  return [command, ...command.commands.flatMap(walk)];
}

/**
 * Parse `args` as `ix <args>` against the OSS commands, running no command body.
 *
 * Built fresh per call: commander keeps parsed option values on the Command
 * objects, so a reused tree would carry one call's flags into the next.
 */
async function parseWithRealCommands(args: string[], mutate?: (program: Command) => void): Promise<Parsed> {
  const program = new Command().name("ix");
  registerOssCommands(program);
  mutate?.(program);
  let ran: Command | undefined;
  for (const command of walk(program)) {
    command.exitOverride();
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    // Leaves only: giving a parent an action would change how it dispatches to
    // its subcommands.
    if (command.commands.length === 0) command.action(() => { ran = command; });
  }
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    return { args, error: error instanceof Error ? error.message : String(error) };
  }
  return { args, ran };
}

/** A server whose runner parses against the real command tree and records each argv. */
async function connect(mutate?: (program: Command) => void): Promise<{ client: Client; runs: Parsed[] }> {
  const runs: Parsed[] = [];
  const runIx: IxRunner = async (args) => {
    const parsed = await parseWithRealCommands(args, mutate);
    runs.push(parsed);
    return parsed.error === undefined
      ? { ok: true, stdout: "{}", stderr: "" }
      : { ok: false, stdout: "", stderr: parsed.error };
  };
  // `all`: every OSS tool, not just the core five. No Pro: those commands are
  // registered by @ix/pro, which this package cannot see.
  const server = createIxMcpServer({ version: "test", runIx, tools: "all", proAvailable: false });
  const client = new Client({ name: "ix-mcp-argv-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return { client, runs };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const DISAMBIGUATE = { kind: "function", path: "src", pick: 2 };
const EDGE = { symbol: "config", ...DISAMBIGUATE, limit: 20, offset: 40 };

/**
 * Calls that between them set every input of every tool to a valid value.
 *
 * More than one where inputs exclude each other (target/issue, path/github,
 * max_tokens/max_chars) or select different commands (ix_neighbors). A test
 * below fails when a tool gains an input no call here sets, so a new flag
 * cannot arrive unchecked.
 */
const CASES: Record<OssTool, Args[]> = {
  ix_context: [
    {
      target: "config",
      ...DISAMBIGUATE,
      as_of_rev: 3,
      max_entities: 10,
      max_relationships: 20,
      max_evidence: 10,
      max_tokens: 3000,
      structured: true,
    },
    { issue: "the config loader drops a key", max_entities: 10, max_chars: 5000 },
  ],
  ix_health: [{}],
  ix_locate: [{ symbol: "config", path: "src", pick: 2 }],
  ix_search: [{ term: "config", kind: "function", path: "src", language: "typescript", limit: 5, include_tests: true }],
  ix_text: [{ pattern: "needle", limit: 5, path: "src", language: "typescript", offset: 20 }],
  ix_impact: [{ target: "config", ...DISAMBIGUATE, limit: 5 }],
  ix_map: [{}],
  ix_overview: [{ target: "config", path: "src", pick: 2 }],
  ix_read: [{ symbol: "config", ...DISAMBIGUATE }],
  ix_diff: [{ from_rev: 1, to_rev: 2, target: "config", summary: true, path: "src", pick: 2 }],
  ix_neighbors: ["callers", "callees", "imports", "imported_by", "overrides"].map((relation) => ({ ...EDGE, relation })),
  ix_callers: [EDGE],
  ix_callees: [EDGE],
  ix_imported_by: [EDGE],
  ix_imports: [EDGE],
  ix_overrides: [EDGE],
  ix_depends: [{ symbol: "config", depth: 3, path: "src", pick: 2 }],
  ix_trace: [{ symbol: "config", to: "loadConfig", depth: 4, path: "src", pick: 2 }],
  ix_explain: [{ symbol: "config", ...DISAMBIGUATE }],
  ix_rank: [{ by: "dependents", kind: "class", top: 5, path: "src" }],
  ix_inventory: [{ kind: "function", path: "src", limit: 20, offset: 40 }],
  ix_smells: [{ path: "src", limit: 20, structured: true }],
  ix_stats: [{}],
  ix_subsystems: [{}],
  ix_history: [{ target: "config", path: "src", pick: 2 }],
  ix_ingest: [
    // `src` of this checkout: inside a git repository, so the server's own
    // workspace confinement lets it through to the CLI.
    { path: "src", since: "2026-01-01" },
    { github: "owner/repo", limit: 10, since: "2026-01-01" },
  ],
};

interface JsonSchemaProperty {
  type?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

async function inputProperties(client: Client): Promise<Map<string, Record<string, JsonSchemaProperty>>> {
  const { tools } = await client.listTools();
  return new Map(tools.map((tool) => [
    tool.name,
    ((tool.inputSchema as { properties?: Record<string, JsonSchemaProperty> }).properties ?? {}),
  ]));
}

/** Call a tool and return the argv it ran, each as the real command tree parsed it. */
async function callAndParse(client: Client, runs: Parsed[], name: string, args: Args): Promise<Parsed[]> {
  const before = runs.length;
  await client.callTool({ name, arguments: args });
  return runs.slice(before);
}

/** Problems with one tool call's argv; empty when the real command tree took it. */
function problems(tool: string, args: Args, parsed: Parsed[]): string[] {
  const label = `${tool} ${JSON.stringify(args)}`;
  // A call that never reached the runner was refused by the tool's own schema:
  // the case is wrong, and nothing was checked.
  if (parsed.length === 0) return [`${label}: ran no command`];
  return parsed.flatMap((run) => {
    if (run.error !== undefined) return [`${label}: ix ${run.args.join(" ")} -> ${run.error}`];
    const ran = run.ran;
    if (!ran || (ran.name() !== run.args[0] && !ran.aliases().includes(run.args[0]))) {
      return [`${label}: ix ${run.args.join(" ")} ran ${ran ? `\`${ran.name()}\`` : "no action"}, not \`${run.args[0]}\``];
    }
    return [];
  });
}

describe("MCP tool argv against the real command tree", () => {
  it("has calls for every OSS tool the server advertises under --tools=all", async () => {
    const { client } = await connect();
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(listed).toEqual([...IX_MCP_OSS_TOOL_NAMES].sort());
    expect(Object.keys(CASES).sort()).toEqual(listed);
  });

  it("sets every input of every tool in at least one call", async () => {
    const { client } = await connect();
    const unset: string[] = [];
    for (const [tool, properties] of await inputProperties(client)) {
      const set = new Set((CASES[tool as OssTool] ?? []).flatMap((args) => Object.keys(args)));
      for (const key of Object.keys(properties)) if (!set.has(key)) unset.push(`${tool}.${key}`);
    }
    expect(unset).toEqual([]);
  });

  it("builds argv every command accepts, with every input set", async () => {
    const { client, runs } = await connect();
    const failures: string[] = [];
    for (const [tool, cases] of Object.entries(CASES)) {
      for (const args of cases) failures.push(...problems(tool, args, await callAndParse(client, runs, tool, args)));
    }
    expect(failures).toEqual([]);
  });

  it("runs --format json for exactly the OSS tools IX_MCP_JSON_RESULT_TOOLS names", async () => {
    // scripts/check-plugin-contract.mjs reads the list to tell a tool whose
    // result has JSON fields from one that returns `--format llm` records.
    const { client, runs } = await connect();
    const json = new Set<string>();
    for (const [tool, cases] of Object.entries(CASES)) {
      for (const args of cases) {
        const ran = await callAndParse(client, runs, tool, args);
        expect(ran.length, tool).toBeGreaterThan(0);
        for (const run of ran) {
          const format = run.args.find((a) => a.startsWith("--format="));
          expect(["--format=json", "--format=llm"], `${tool}: ${run.args.join(" ")}`).toContain(format);
          if (format === "--format=json") json.add(tool);
        }
      }
    }
    const oss = new Set<string>(IX_MCP_OSS_TOOL_NAMES);
    expect([...json].sort()).toEqual(IX_MCP_JSON_RESULT_TOOLS.filter((tool) => oss.has(tool)).sort());
  });

  it("lists every Pro tool as JSON, as each one runs", async () => {
    const formats = new Map<string, string | undefined>();
    const runIx: IxRunner = async (args) => {
      formats.set(args[0], args.find((a) => a.startsWith("--format=")));
      return { ok: true, stdout: "{}", stderr: "" };
    };
    const server = createIxMcpServer({ version: "test", runIx, tools: "all", proAvailable: true });
    const client = new Client({ name: "ix-mcp-json-tools-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);
    for (const tool of IX_MCP_PRO_TOOL_NAMES) {
      await client.callTool({ name: tool, arguments: tool === "ix_decide" ? { title: "t", rationale: "r" } : {} });
      expect(IX_MCP_JSON_RESULT_TOOLS).toContain(tool);
    }
    expect([...formats.values()]).toEqual(IX_MCP_PRO_TOOL_NAMES.map(() => "--format=json"));
  });

  it("accepts each numeric bound a tool schema allows", async () => {
    // A schema that admits a value its command refuses turns a valid tool call
    // into a usage error, e.g. a `min(0)` limit forwarded to a flag whose parser
    // wants at least 1.
    const { client, runs } = await connect();
    const failures: string[] = [];
    let checked = 0;
    for (const [tool, properties] of await inputProperties(client)) {
      for (const [key, property] of Object.entries(properties)) {
        if (property.type !== "integer" && property.type !== "number") continue;
        const bounds = [
          property.minimum ?? (property.exclusiveMinimum !== undefined ? property.exclusiveMinimum + 1 : undefined),
          property.maximum ?? (property.exclusiveMaximum !== undefined ? property.exclusiveMaximum - 1 : undefined),
        ].filter((bound): bound is number => bound !== undefined && Number.isSafeInteger(bound));
        const base = CASES[tool as OssTool].find((args) => key in args)!;
        for (const bound of bounds) {
          const args = { ...base, [key]: bound };
          failures.push(...problems(tool, args, await callAndParse(client, runs, tool, args)));
          checked += 1;
        }
      }
    }
    expect(failures).toEqual([]);
    // Guards the loop itself: a schema shape this no longer reads would check nothing.
    expect(checked).toBeGreaterThan(40);
  });

  it("fails when any flag a tool sends is removed from its command", async () => {
    // What makes the checks above worth having: every flag a tool forwards is
    // one its command would reject if it were gone, rather than one commander
    // lets through unchecked.
    const { client, runs } = await connect();
    for (const [tool, cases] of Object.entries(CASES)) {
      for (const args of cases) await callAndParse(client, runs, tool, args);
    }
    // Runs that already failed are reported by the test above.
    const accepted = runs.filter((run) => run.ran !== undefined);
    const flagsByCommand = new Map<string, Set<string>>();
    for (const run of accepted) {
      const command = run.ran!.name();
      const flags = flagsByCommand.get(command) ?? new Set<string>();
      for (const arg of run.args) {
        if (arg === "--") break;
        if (arg.startsWith("--")) flags.add(arg.split("=")[0]);
      }
      flagsByCommand.set(command, flags);
    }

    const unnoticed: string[] = [];
    let removed = 0;
    for (const [commandName, flags] of flagsByCommand) {
      for (const flag of flags) {
        const withFlag = accepted.find((r) => r.ran!.name() === commandName && r.args.some((a) => a.split("=")[0] === flag))!;
        let declared = true;
        const parsed = await parseWithRealCommands(withFlag.args, (program) => {
          const command = program.commands.find((c) => c.name() === commandName)!;
          const options = command.options as unknown as Array<{ long?: string }>;
          const index = options.findIndex((option) => option.long === flag);
          if (index < 0) declared = false;
          else options.splice(index, 1);
        });
        if (!declared) {
          unnoticed.push(`ix ${commandName} ${flag}: accepted, but not declared on the command`);
          continue;
        }
        removed += 1;
        if (!/unknown option/.test(parsed.error ?? "")) {
          unnoticed.push(`ix ${commandName} without ${flag}: ${parsed.error ?? "accepted"}`);
        }
      }
    }
    expect(unnoticed).toEqual([]);
    expect(removed).toBeGreaterThan(40);
  });

  it("reports a flag the command does not declare", async () => {
    // The ix_explain regression, replayed: a tool forwarding a flag its
    // command lacks is a failure here, not an "ok" from a stub.
    const parsed = await parseWithRealCommands(["explain", "--limit=5", "--format=llm", "--", "config"]);
    expect(parsed.error).toMatch(/unknown option '--limit=5'/);
  });
});
