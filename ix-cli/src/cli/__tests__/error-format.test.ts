// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CliResolutionError,
  CliUsageError,
  WorkspaceNotMappedError,
  bindCommanderErrors,
  commandFormat,
  renderCliError,
  resolveErrorFormat,
  setErrorFormat,
  setErrorFormatFallback,
  throwCommanderExit,
  usageErrorFormat,
  writeCommanderError,
} from "../errors.js";
import { exitCodeFor } from "../outcome.js";

/**
 * The error boundary answers in the format the run answers in, wherever that
 * format came from: a typed `--format`, `IX_FORMAT`, or `format` in
 * config.yaml. Before this, only a typed `--format llm` got a record; json, and
 * either configured default, got prose on stderr and an empty stdout.
 *
 * json adds the record and keeps the prose on stderr, where callers already
 * read their error guidance; llm's record is the whole report.
 */

// ── Capture ────────────────────────────────────────────────────────────────

interface Captured { out: string; err: string; exitCode: number | undefined }

function capture(fn: () => void): Captured {
  let out = "";
  let err = "";
  let exitCode: number | undefined;
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out += args.map(String).join(" ") + "\n";
    }),
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      err += args.map(String).join(" ") + "\n";
    }),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    }),
  ];
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exit__");
  }) as never);
  try {
    fn();
  } catch (error) {
    if ((error as Error).message !== "__exit__") throw error;
  } finally {
    for (const spy of spies) spy.mockRestore();
    exit.mockRestore();
  }
  return { out, err, exitCode };
}

afterEach(() => {
  setErrorFormat(undefined);
  setErrorFormatFallback(undefined);
});

// ── Where the format comes from ────────────────────────────────────────────

describe("resolveErrorFormat", () => {
  const noConfig = () => undefined;

  it("is the typed flag first", () => {
    expect(resolveErrorFormat(["stats", "--format", "json"], { IX_FORMAT: "llm" }, () => "llm")).toBe("json");
    expect(resolveErrorFormat(["stats", "--format=llm"], {}, () => "json")).toBe("llm");
  });

  it("then IX_FORMAT, then config.format, then text", () => {
    expect(resolveErrorFormat(["stats"], { IX_FORMAT: "llm" }, () => "json")).toBe("llm");
    expect(resolveErrorFormat(["stats"], {}, () => "json")).toBe("json");
    expect(resolveErrorFormat(["stats"], {}, noConfig)).toBe("text");
  });

  it("skips a configured value that is not a format, as the command default does", () => {
    expect(resolveErrorFormat(["stats"], { IX_FORMAT: "yaml" }, () => "llm")).toBe("llm");
  });

  it("never throws, even when config cannot be read", () => {
    const broken = () => { throw new Error("config.yaml is not valid YAML"); };
    expect(resolveErrorFormat(["stats"], {}, broken)).toBe("text");
  });

  it("is resolved once, and a throwing fallback does not escape the boundary", () => {
    let reads = 0;
    setErrorFormatFallback(() => { reads += 1; throw new Error("boom"); });
    const first = capture(() => renderCliError(new Error("odd")));
    const second = capture(() => renderCliError(new Error("odd")));
    expect(first.err).toContain("Error: odd");
    expect(second.exitCode).toBe(1);
    expect(reads).toBe(1);
  });
});

describe("commandFormat", () => {
  it("is the parsed command's own --format, so the failure matches the payload", () => {
    const command = new Command("query").option("--format <fmt>", "", "text");
    command.parse(["--format", "json"], { from: "user" });
    expect(commandFormat(command)).toBe("json");
  });

  it("is text for a command that prints prose, whatever IX_FORMAT says", () => {
    expect(commandFormat(new Command("hook"))).toBe("text");
  });

  it("outranks the pre-parse fallback once recorded", () => {
    // `query` renders text and json only, so IX_FORMAT=llm leaves it on text.
    setErrorFormatFallback(() => "llm");
    setErrorFormat("text");
    const { out, err } = capture(() => renderCliError(new Error("odd")));
    expect(out).toBe("");
    expect(err).toContain("Error: odd");
  });
});

// ── Failure kind × format × format source ──────────────────────────────────

/** Node's fetch shape: `TypeError: fetch failed` with the real error nested. */
function unreachable(): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:8090"),
    { code: "ECONNREFUSED" },
  );
  return err;
}

function named(name: string, fields: Record<string, string>): Error {
  return Object.assign(new Error(name), { name, ...fields });
}

const FAILURES: Array<{ kind: string; make: () => unknown; code: string; exit: number; next: boolean }> = [
  { kind: "backend unreachable", make: unreachable, code: "backend_unreachable", exit: 1, next: true },
  {
    kind: "backend structured error",
    make: () => new Error('404: {"error":"workspace_not_found","message":"No such workspace","next":"Run ix map"}'),
    code: "workspace_not_found", exit: 1, next: true,
  },
  { kind: "usage", make: () => new CliUsageError("Bad flag", "Try --kind class"), code: "usage_error", exit: 1, next: true },
  { kind: "resolution", make: () => new CliResolutionError("No match", "Try ix search"), code: "resolution_failed", exit: 1, next: true },
  {
    kind: "workspace not mapped", make: () => new WorkspaceNotMappedError("/tmp/elsewhere"),
    code: "workspace_not_mapped", exit: exitCodeFor("not_mapped"), next: true,
  },
  {
    kind: "config parse", make: () => named("ConfigParseError", { path: "/h/config.yaml", detail: "bad indent" }),
    code: "config_parse_error", exit: 1, next: true,
  },
  { kind: "config lock", make: () => named("ConfigLockError", { detail: "held" }), code: "config_lock_timeout", exit: 1, next: true },
  { kind: "local token", make: () => named("LocalTokenRequiredError", {}), code: "local_token_required", exit: 1, next: true },
  {
    kind: "commander usage", make: () => new CommanderError(1, "commander.unknownOption", "error: unknown option '--bogus'"),
    code: "usage_error", exit: 1, next: false,
  },
  {
    kind: "option validation", make: () => new InvalidArgumentError("option '--limit' must be a non-negative integer"),
    code: "usage_error", exit: 1, next: false,
  },
  { kind: "unrecognised", make: () => new Error("something odd"), code: "cli_error", exit: 1, next: false },
];

/** How the format reaches the boundary: typed, IX_FORMAT, or config.yaml. */
const SOURCES: Array<{ source: string; arm: (format: string) => void }> = [
  { source: "flag", arm: (f) => setErrorFormatFallback(() => resolveErrorFormat(["stats", "--format", f], {}, () => undefined)) },
  { source: "IX_FORMAT", arm: (f) => setErrorFormatFallback(() => resolveErrorFormat(["stats"], { IX_FORMAT: f }, () => undefined)) },
  { source: "config.format", arm: (f) => setErrorFormatFallback(() => resolveErrorFormat(["stats"], {}, () => f)) },
  { source: "parsed command", arm: (f) => setErrorFormat(f) },
];

describe("renderCliError answers every failure in the requested format", () => {
  for (const failure of FAILURES) {
    for (const { source, arm } of SOURCES) {
      it(`${failure.kind} · json · ${source}`, () => {
        arm("json");
        const { out, err, exitCode } = capture(() => renderCliError(failure.make(), false, "http://localhost:8090"));
        const lines = out.trimEnd().split("\n");
        expect(lines).toHaveLength(1);
        const record = JSON.parse(lines[0]);
        expect(record.error).toBe(failure.code);
        expect(typeof record.message).toBe("string");
        expect(record.message.length).toBeGreaterThan(0);
        expect(record.message).not.toMatch(/^error:/);
        if (failure.next) expect(typeof record.next).toBe("string");
        else expect(record).not.toHaveProperty("next");
        // The prose stays on stderr, as text has it: callers read it there.
        expect(err).toContain(record.message);
        expect(err).not.toContain('"error"');
        expect(exitCode).toBe(failure.exit);
      });

      it(`${failure.kind} · llm · ${source}`, () => {
        arm("llm");
        const { out, err, exitCode } = capture(() => renderCliError(failure.make(), false, "http://localhost:8090"));
        const lines = out.trimEnd().split("\n");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(new RegExp(`^error code=${failure.code} message=`));
        if (failure.next) expect(lines[0]).toContain(" hint=");
        expect(err).toBe("");
        expect(exitCode).toBe(failure.exit);
      });
    }

    it(`${failure.kind} · text · prose on stderr, nothing on stdout`, () => {
      setErrorFormatFallback(() => resolveErrorFormat(["stats"], {}, () => undefined));
      const { out, err, exitCode } = capture(() => renderCliError(failure.make(), false, "http://localhost:8090"));
      expect(out).toBe("");
      expect(err.length).toBeGreaterThan(0);
      expect(exitCode).toBe(failure.exit);
    });
  }

  it("keeps the workspace_not_mapped json shape, dir included", () => {
    setErrorFormat("json");
    const { out } = capture(() => renderCliError(new WorkspaceNotMappedError("/tmp/elsewhere")));
    expect(Object.keys(JSON.parse(out))).toEqual(["error", "message", "dir", "next"]);
  });

  it("writes json's record to stdout and the same prose as text to stderr", () => {
    const failure = () => unreachable();
    setErrorFormat("text");
    const text = capture(() => renderCliError(failure(), false, "http://localhost:8090"));
    setErrorFormat("json");
    const json = capture(() => renderCliError(failure(), false, "http://localhost:8090"));
    expect(JSON.parse(json.out)).toEqual({
      error: "backend_unreachable",
      message: "Ix backend not reachable at http://localhost:8090.",
      next: "Start it with `ix docker start`, then check `ix status`.",
    });
    expect(json.err).toBe(text.err);
    expect(json.err).toContain("Start it with `ix docker start`");
    expect(json.exitCode).toBe(text.exitCode);
  });
});

describe("commander's own exits", () => {
  it("leave help and version as silent successes in every format", () => {
    for (const format of ["text", "json", "llm"]) {
      setErrorFormat(format);
      for (const code of ["commander.helpDisplayed", "commander.version", "commander.help"]) {
        const result = capture(() => renderCliError(new CommanderError(0, code, "(outputHelp)")));
        expect(result).toEqual({ out: "", err: "", exitCode: 0 });
      }
    }
  });

  it("keep a help-on-error exit code without adding a record", () => {
    setErrorFormat("llm");
    const result = capture(() => renderCliError(new CommanderError(1, "commander.help", "(outputHelp)")));
    expect(result).toEqual({ out: "", err: "", exitCode: 1 });
  });

  it("print commander's message once in text and json, and not at all for llm", () => {
    const writes: string[] = [];
    const command = new Command("ix").exitOverride(throwCommanderExit)
      .configureOutput({ outputError: writeCommanderError, writeErr: (s) => writes.push(s) });

    setErrorFormat("text");
    let thrown: unknown;
    try { command.error("error: unknown option '--bogus'"); } catch (e) { thrown = e; }
    expect(writes).toEqual(["error: unknown option '--bogus'\n"]);
    const text = capture(() => renderCliError(thrown));
    expect(text).toEqual({ out: "", err: "", exitCode: 1 });

    writes.length = 0;
    setErrorFormat("json");
    try { command.error("error: unknown option '--bogus'"); } catch (e) { thrown = e; }
    expect(writes).toEqual(["error: unknown option '--bogus'\n"]);
    const json = capture(() => renderCliError(thrown));
    expect(JSON.parse(json.out)).toEqual({ error: "usage_error", message: "unknown option '--bogus'" });
    expect(json.err).toBe("");
    expect(json.exitCode).toBe(1);

    writes.length = 0;
    setErrorFormat("llm");
    try { command.error("error: unknown option '--bogus'"); } catch (e) { thrown = e; }
    expect(writes).toEqual([]);
    const llm = capture(() => renderCliError(thrown));
    expect(llm.out.trim()).toBe(`error code=usage_error message="unknown option '--bogus'"`);
    expect(llm.err).toBe("");
    expect(llm.exitCode).toBe(1);
  });
});

describe("usage errors answer in records only for commands that take --format", () => {
  /** `ix` with a prose-only command and one that renders records. */
  function program(argv: string[], writes: string[]): Command {
    const root = new Command("ix").exitOverride(throwCommanderExit)
      .configureOutput({ outputError: writeCommanderError, writeErr: (s) => writes.push(s) });
    root.command("hook").option("--quiet").action(() => {});
    root.command("mcp").command("serve").action(() => {});
    root.command("patches").option("--limit <n>").option("--format <fmt>", "", "text").action(() => {});
    bindCommanderErrors(root, argv);
    return root;
  }

  function parse(argv: string[]): { writes: string[]; result: Captured } {
    const writes: string[] = [];
    let thrown: unknown;
    try { program(argv, writes).parse(argv, { from: "user" }); } catch (e) { thrown = e; }
    return { writes, result: capture(() => renderCliError(thrown)) };
  }

  for (const argv of [["hook", "--bogus"], ["mcp", "serve", "--bogus"], ["bogus"]]) {
    it(`\`ix ${argv.join(" ")}\` stays prose under IX_FORMAT=json`, () => {
      setErrorFormatFallback(() => resolveErrorFormat(argv, { IX_FORMAT: "json" }, () => undefined));
      const { writes, result } = parse(argv);
      expect(result.out).toBe("");
      expect(writes.join("")).toMatch(/^error: unknown (option|command)/);
      expect(result.exitCode).toBe(1);
    });
  }

  it("a command with --format answers in it, typed before or after the bad option", () => {
    for (const argv of [["patches", "--bogus", "--format", "json"], ["patches", "--format", "json", "--bogus"]]) {
      const { writes, result } = parse(argv);
      expect(JSON.parse(result.out)).toMatchObject({ error: "usage_error" });
      expect(writes.join("")).toContain("unknown option '--bogus'");
      expect(result.exitCode).toBe(1);
    }
  });

  it("usageErrorFormat: text without --format, else the typed flag, else the command's default", () => {
    const hook = new Command("hook");
    const patches = new Command("patches").option("--format <fmt>", "", "llm");
    expect(usageErrorFormat(hook, ["hook", "--format", "json"])).toBe("text");
    expect(usageErrorFormat(patches, ["patches", "--format", "json"])).toBe("json");
    expect(usageErrorFormat(patches, ["patches"])).toBe("llm");
  });
});

// ── The real CLI, end to end ───────────────────────────────────────────────

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN = join(SRC, "cli/main.ts");
const TSX = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("tsx")).href;

const scratch: string[] = [];
let endpoint: string;
let work: string;

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

beforeAll(async () => {
  endpoint = `http://127.0.0.1:${await closedPort()}`;
  work = mkdtempSync(join(tmpdir(), "ix-errfmt-work-"));
  scratch.push(work);
});

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run { stdout: string; stderr: string; status: number | null }

function runCli(args: string[], env: Record<string, string>, configFormat?: string): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), "ix-errfmt-home-"));
  scratch.push(home);
  writeFileSync(join(home, "config.yaml"), `endpoint: ${endpoint}\n${configFormat ? `format: ${configFormat}\n` : ""}`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, IX_HOME: home, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1", ...env };
  for (const key of ["FORCE_COLOR", "IX_FORMAT", "IX_ENDPOINT", "IX_TOKEN", "IX_DEBUG"]) {
    if (!(key in env)) delete childEnv[key];
  }
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
      cwd: work, env: childEnv, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf-8").on("data", (d: string) => { stderr += d; });
    child.on("error", fail);
    child.on("close", (status) => done({ stdout, stderr, status }));
    child.stdin.end("");
  });
}

const CLI_FAILURES = [
  { kind: "backend down", args: ["patches"], code: "backend_unreachable" },
  { kind: "unknown option", args: ["patches", "--bogus"], code: "usage_error" },
];

const CLI_SOURCES: Array<{ source: string; run: (args: string[], format: string) => Promise<Run> }> = [
  { source: "flag", run: (args, f) => runCli([...args, "--format", f], {}) },
  { source: "IX_FORMAT", run: (args, f) => runCli(args, { IX_FORMAT: f }) },
  { source: "config.format", run: (args, f) => runCli(args, {}, f) },
];

describe.concurrent("ix, against a backend that is not there", () => {
  for (const failure of CLI_FAILURES) {
    for (const { source, run } of CLI_SOURCES) {
      it(`${failure.kind} · json · ${source}`, async () => {
        const { stdout, stderr, status } = await run(failure.args, "json");
        const record = JSON.parse(stdout.trim());
        expect(record).toMatchObject({ error: failure.code });
        // The prose is still on stderr, where the plugin runners read it.
        expect(stderr).toContain(record.message);
        expect(status).toBe(1);
      }, 30_000);

      it(`${failure.kind} · llm · ${source}`, async () => {
        const { stdout, stderr, status } = await run(failure.args, "llm");
        expect(stdout.trimEnd().split("\n")).toHaveLength(1);
        expect(stdout).toMatch(new RegExp(`^error code=${failure.code} message=`));
        expect(stderr).toBe("");
        expect(status).toBe(1);
      }, 30_000);
    }

    it(`${failure.kind} · text · prose on stderr as before`, async () => {
      const { stdout, stderr, status } = await runCli(failure.args, {});
      expect(stdout).toBe("");
      expect(stderr.length).toBeGreaterThan(0);
      expect(status).toBe(1);
    }, 30_000);
  }

  it("keeps prose-only commands' usage errors as prose under IX_FORMAT=json", async () => {
    for (const args of [["hook", "--bogus"], ["mcp", "serve", "--bogus"]]) {
      const { stdout, stderr, status } = await runCli(args, { IX_FORMAT: "json" });
      expect(stdout).toBe("");
      expect(stderr).toContain("unknown option '--bogus'");
      expect(status).toBe(1);
    }
  }, 30_000);

  it("ix status, which catches the failure itself, answers json and llm too", async () => {
    const json = await runCli(["status", "--format", "json"], {});
    const record = JSON.parse(json.stdout.trim());
    expect(record).toMatchObject({ error: "backend_unreachable", message: expect.stringContaining(endpoint) });
    expect(typeof record.next).toBe("string");
    expect(json.stderr).toContain(record.message);
    expect(json.status).toBe(1);

    const llm = await runCli(["status", "--format", "llm"], {});
    expect(llm.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(llm.stdout).toMatch(/^error code=backend_unreachable message=.* hint=/);
    expect(llm.stderr).toBe("");
    expect(llm.status).toBe(1);

    const text = await runCli(["status"], {});
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain(record.message);
    expect(text.status).toBe(1);
  }, 30_000);

  it("keeps --version and --help successes under a records format", async () => {
    const version = await runCli(["--version"], { IX_FORMAT: "llm" });
    expect(version.status).toBe(0);
    expect(version.stdout).not.toMatch(/^error /);
    const help = await runCli(["patches", "--help"], { IX_FORMAT: "json" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
  }, 30_000);
});
