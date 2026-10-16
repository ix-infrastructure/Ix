// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerOssCommands } from "../register/oss.js";
import { LOAD_ALL_COMMANDS_ENV, OSS_COMMAND_TABLE, planStartup, registerForPlan } from "../register/oss-table.js";

/**
 * The CLI registers only the command being run when it can
 * (`register/oss-table.ts`). These tests hold that fast path to the full one:
 * the same commands, the same option setup, the same bytes out, and only the
 * one command module loaded.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN = join(SRC, "cli/main.ts");
const TSX = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("tsx")).href;
const VERSION = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf-8")).version as string;

const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

let home: string;   // IX_HOME: exists, no config.yaml
let work: string;   // cwd: not a git repository, not a mapped workspace
let tracer: string; // --import module recording every module the CLI loads

beforeAll(() => {
  home = tempDir("ix-fast-home-");
  work = tempDir("ix-fast-work-");
  writeFileSync(join(work, "a.txt"), "first line\nneedle here\nlast line\n");
  const hooks = tempDir("ix-fast-hooks-");
  writeFileSync(join(hooks, "hooks.mjs"),
    'import { appendFileSync } from "node:fs";\n' +
    "export async function load(url, context, next) {\n" +
    "  if (process.env.IX_TEST_MODULE_TRACE) appendFileSync(process.env.IX_TEST_MODULE_TRACE, url + \"\\n\");\n" +
    "  return next(url, context);\n" +
    "}\n");
  writeFileSync(join(hooks, "register.mjs"),
    'import { register } from "node:module";\nregister(new URL("./hooks.mjs", import.meta.url));\n');
  tracer = pathToFileURL(join(hooks, "register.mjs")).href;
});

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run { stdout: string; stderr: string; status: number | null }

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, IX_HOME: home, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1", ...extra };
  for (const key of ["FORCE_COLOR", "IX_FORMAT", LOAD_ALL_COMMANDS_ENV, "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function runCli(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string; imports?: string[] } = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", TSX, ...(opts.imports ?? []).flatMap((m) => ["--import", m]), MAIN, ...args], {
      cwd: opts.cwd ?? work, env: opts.env ?? baseEnv(), stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf-8").on("data", (d: string) => { stderr += d; });
    child.on("error", fail);
    child.on("close", (status) => done({ stdout, stderr, status }));
    child.stdin.end(opts.input ?? "");
  });
}

/** The `commands/*` modules a run loaded, by file name without extension. */
async function commandModulesLoaded(args: string[], extraEnv: Record<string, string> = {}, input?: string): Promise<string[]> {
  const trace = join(tempDir("ix-fast-trace-"), "modules.txt");
  writeFileSync(trace, "");
  await runCli(args, { env: baseEnv({ IX_TEST_MODULE_TRACE: trace, ...extraEnv }), imports: [tracer], input });
  const urls = readFileSync(trace, "utf-8").split("\n").filter(Boolean);
  // Proves the tracer saw the CLI at all, so an empty answer means something.
  expect(urls.some((u) => /\/cli\/main\.ts$/.test(u))).toBe(true);
  const names = urls
    .map((u) => /\/src\/cli\/commands\/([^/]+)\.ts$/.exec(u)?.[1])
    .filter((n): n is string => n !== undefined);
  return [...new Set(names)].sort();
}

function namesAndAliases(program: Command): string[] {
  return program.commands.flatMap((c) => [c.name(), ...c.aliases()]).sort();
}

/** What `configureOssOptions` decides about a command, in a comparable shape. */
function optionShape(command: Command): unknown {
  return {
    name: command.name(),
    aliases: command.aliases(),
    options: command.options.map((o) => ({
      flags: o.flags, description: o.description, defaultValue: o.defaultValue, choices: o.argChoices,
    })),
    values: command.opts(),
    children: command.commands.map(optionShape),
  };
}

describe("the fast-path table", () => {
  it("names every command and alias registerOssCommands() registers, and nothing else", () => {
    const program = new Command();
    registerOssCommands(program);
    expect(Object.keys(OSS_COMMAND_TABLE).sort()).toEqual(namesAndAliases(program));
  });

  it("points each name at the module that registers it", async () => {
    for (const [name, load] of Object.entries(OSS_COMMAND_TABLE)) {
      const program = new Command();
      (await load())(program);
      expect(namesAndAliases(program), name).toContain(name);
    }
  });
});

describe("planStartup", () => {
  const absent = () => true;
  const present = () => false;
  const kind = (args: string[], env: NodeJS.ProcessEnv = {}, pro = absent) => planStartup(args, env, pro).kind;

  it("registers one command for a known first word", () => {
    for (const name of ["text", "locate", "read", "explain", "callers", "search", "context", "impact", "around", "hook"]) {
      const plan = planStartup([name, "x"], {}, absent);
      expect(plan.kind, name).toBe("command");
      expect(plan.kind === "command" && plan.name).toBe(name);
    }
    expect(kind(["text", "--help"])).toBe("command");
  });

  it("registers no command for a lone --version or -V", () => {
    expect(kind(["--version"])).toBe("version");
    expect(kind(["-V"])).toBe("version");
  });

  it("registers everything whenever commander needs the whole list", () => {
    expect(kind([])).toBe("all");
    expect(kind(["--help"])).toBe("all");
    expect(kind(["-h"])).toBe("all");
    expect(kind(["help"])).toBe("all");
    expect(kind(["help", "text"])).toBe("all");
    expect(kind(["txt"])).toBe("all");            // unknown: "did you mean"
    expect(kind(["briefing"])).toBe("all");       // a Pro command / stub
    expect(kind(["--pretty", "text", "x"])).toBe("all");
    expect(kind(["--version", "text"])).toBe("all");
    expect(kind(["constructor"])).toBe("all");    // not an own key of the table
    expect(kind(["__proto__"])).toBe("all");
  });

  it("registers everything when Pro is installed, broken or not", () => {
    expect(kind(["text", "x"], {}, present)).toBe("all");
    expect(kind(["--version"], {}, present)).toBe("all");
    expect(kind(["patches"], {}, present)).toBe("all");
  });

  it("registers everything when IX_LOAD_ALL_COMMANDS=1", () => {
    expect(kind(["text", "x"], { [LOAD_ALL_COMMANDS_ENV]: "1" })).toBe("all");
    expect(kind(["--version"], { [LOAD_ALL_COMMANDS_ENV]: "1" })).toBe("all");
  });

  it("does not look for Pro when the answer is everything anyway", () => {
    let probes = 0;
    planStartup(["--help"], {}, () => { probes++; return true; });
    planStartup(["txt"], {}, () => { probes++; return true; });
    expect(probes).toBe(0);
  });
});

describe("registerForPlan", () => {
  let savedHome: string | undefined;
  let savedFormat: string | undefined;
  beforeAll(() => {
    savedHome = process.env.IX_HOME;
    savedFormat = process.env.IX_FORMAT;
    process.env.IX_HOME = home;
    process.env.IX_FORMAT = "llm"; // exercises the configured-default rewrite
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.IX_HOME; else process.env.IX_HOME = savedHome;
    if (savedFormat === undefined) delete process.env.IX_FORMAT; else process.env.IX_FORMAT = savedFormat;
  });

  it("registers exactly the module's commands, set up as registerOssCommands() sets them up", async () => {
    const full = new Command();
    registerOssCommands(full);
    for (const name of Object.keys(OSS_COMMAND_TABLE)) {
      if (name === "help") continue; // never planned: it needs every command
      const program = new Command();
      const plan = planStartup([name], {}, () => true);
      expect(await registerForPlan(program, plan), name).toBe(true);
      const registered = program.commands.map((c) => c.name());
      // A module that registers two commands (callers/callees) brings both.
      expect(registered.length, name).toBeLessThanOrEqual(2);
      for (const command of program.commands) {
        const twin = full.commands.find((c) => c.name() === command.name());
        expect(optionShape(command), name).toEqual(optionShape(twin!));
      }
    }
  });

  it("registers nothing for --version and everything for the full plan", async () => {
    const none = new Command();
    expect(await registerForPlan(none, { kind: "version" })).toBe(true);
    expect(none.commands).toEqual([]);

    const all = new Command();
    expect(await registerForPlan(all, { kind: "all" })).toBe(false);
    const expected = new Command();
    registerOssCommands(expected);
    expect(namesAndAliases(all)).toEqual(namesAndAliases(expected));
  });
});

describe("the CLI loads only the command it runs", () => {
  const cases: Array<[string[], string[]]> = [
    [["--version"], []],
    [["text", "needle", "--format", "json"], ["text"]],
    [["locate", "x"], ["locate"]],
    [["read", "a.txt"], ["read"]],
    [["explain", "x"], ["depends", "explain"]],   // explain/facts.ts uses depends' tree
    [["callers", "x"], ["callers", "text"]],      // the text fallback's snippet clipper
    [["search", "x"], ["search"]],
    [["context", "x"], ["context", "depends"]],
    [["impact", "x"], ["impact"]],
    [["around", "a.txt"], ["around"]],
    [["hook", "--help"], ["hook"]],
  ];

  it.concurrent.each(cases)("ix %j loads %j", async (args, expected) => {
    expect(await commandModulesLoaded(args)).toEqual(expected);
  }, 60_000);

  it.concurrent("ix hook claude-post-edit loads no command module", async () => {
    expect(await commandModulesLoaded(["hook", "claude-post-edit"], {}, "{}")).toEqual([]);
  }, 60_000);

  it.concurrent("the full path still loads every command module", async () => {
    const loaded = await commandModulesLoaded(["--version"], { [LOAD_ALL_COMMANDS_ENV]: "1" });
    expect(loaded.length).toBeGreaterThanOrEqual(38);
    expect(loaded).toEqual(expect.arrayContaining(["text", "read", "workflows", "upgrade"]));
  }, 60_000);
});

describe("the fast and full paths answer identically", () => {
  const cases: Array<[string, string[], Record<string, string>?]> = [
    ["--version", ["--version"]],
    ["-V", ["-V"]],
    ["root --help", ["--help"]],
    ["help text", ["help", "text"]],
    ["unknown command", ["txt"]],
    ["Pro command, Pro absent", ["briefing", "list"]],
    ["subcommand --help", ["text", "--help"]],
    ["missing argument", ["read"]],
    ["read --format json", ["read", "a.txt", "--format", "json"]],
    ["read --pretty", ["read", "a.txt", "--format", "json", "--pretty"]],
    ["read --fields", ["read", "a.txt", "--format", "json", "--fields", "content,lineStart"]],
    ["read --quiet", ["read", "a.txt:1-2", "--quiet"]],
    ["read --format llm", ["read", "a.txt", "--format", "llm"]],
    ["configured default format", ["read", "a.txt"], { IX_FORMAT: "json" }],
    ["invalid --format choice", ["text", "needle", "--format", "bogus"]],
    ["invalid integer option", ["text", "needle", "--limit", "abc"]],
    ["invalid OPTION_CHOICES value", ["context", "x", "--depth", "bogus"]],
    ["unknown option", ["locate", "x", "--bogus"]],
    ["text --format json", ["text", "needle", "--format", "json"]],
    ["graph command outside a workspace", ["locate", "x", "--format", "json"]],
    ["hook --help", ["hook", "--help"]],
  ];

  it.concurrent.each(cases)("%s", async (_label, args, extra = {}) => {
    const [fast, full] = await Promise.all([
      runCli(args, { env: baseEnv(extra) }),
      runCli(args, { env: baseEnv({ ...extra, [LOAD_ALL_COMMANDS_ENV]: "1" }) }),
    ]);
    expect(fast).toEqual(full);
    expect(fast.stdout + fast.stderr).not.toBe("");
  }, 60_000);

  it.concurrent("--version prints the version and nothing else", async () => {
    expect(await runCli(["--version"])).toEqual({ stdout: `${VERSION}\n`, stderr: "", status: 0 });
  }, 60_000);
});

describe("the compile cache", () => {
  const supported = typeof (nodeModule as { enableCompileCache?: unknown }).enableCompileCache === "function";

  it.skipIf(!supported)("lives under IX_HOME/cache, private to the user", async () => {
    const own = tempDir("ix-cc-home-");
    expect(await runCli(["--version"], { env: baseEnv({ IX_HOME: own }) })).toEqual({ stdout: `${VERSION}\n`, stderr: "", status: 0 });
    const dir = join(own, "cache", "node-compile-cache");
    expect(statSync(dir).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
  }, 60_000);

  it("does not create IX_HOME to hold it", async () => {
    const missing = join(tempDir("ix-cc-parent-"), "home");
    expect(await runCli(["--version"], { env: baseEnv({ IX_HOME: missing }) })).toEqual({ stdout: `${VERSION}\n`, stderr: "", status: 0 });
    expect(existsSync(missing)).toBe(false);
  }, 60_000);

  it("is silently skipped when its directory cannot be created", async () => {
    // A regular file where a directory has to go fails for every user,
    // root included, on every platform.
    const fileHome = join(tempDir("ix-cc-file-"), "home");
    writeFileSync(fileHome, "");
    expect(await runCli(["--version"], { env: baseEnv({ IX_HOME: fileHome }) })).toEqual({ stdout: `${VERSION}\n`, stderr: "", status: 0 });

    const blocked = tempDir("ix-cc-blocked-");
    writeFileSync(join(blocked, "cache"), "");
    expect(await runCli(["--version"], { env: baseEnv({ IX_HOME: blocked }) })).toEqual({ stdout: `${VERSION}\n`, stderr: "", status: 0 });
    const read = await runCli(["read", "a.txt", "--format", "json"], { env: baseEnv({ IX_HOME: blocked }) });
    expect(read.status).toBe(0);
    expect(read.stderr).toBe("");
  }, 60_000);

  it("never writes into the directory the command runs in", async () => {
    const cwd = tempDir("ix-cc-cwd-");
    mkdirSync(join(cwd, "rel-home"));
    const run = await runCli(["--version"], { cwd, env: baseEnv({ IX_HOME: "rel-home" }) });
    expect(run).toEqual({ stdout: `${VERSION}\n`, stderr: "", status: 0 });
    expect(readdirSync(join(cwd, "rel-home"))).toEqual([]);
    expect(readdirSync(cwd)).toEqual(["rel-home"]);
  }, 60_000);
});
