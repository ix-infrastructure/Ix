// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

/**
 * CL-18: a config.yaml that did not parse was silently replaced by defaults;
 * parallel registrations each renamed their own copy over the others' and kept
 * one or two of eight; `ix config show` printed nested credentials; and every
 * load re-parsed the file.
 */

const execFileAsync = promisify(execFile);
const CLI_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TSX = join(CLI_ROOT, "node_modules", ".bin", "tsx");
const BOOTSTRAP = join(CLI_ROOT, "src", "cli", "bootstrap.ts");

let home: string;
let saved: string | undefined;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "ix-cfg-"));
  saved = process.env.IX_HOME;
  process.env.IX_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = saved;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const configPath = () => join(home, "config.yaml");

describe("parallel registrations", () => {
  it.skipIf(process.platform === "win32")("8 processes registering 8 repositories at once keep all 8", async () => {
    const script = join(home, "register.mts");
    writeFileSync(script, `import { ensureWorkspaceRegistered } from ${JSON.stringify(BOOTSTRAP)};\nensureWorkspaceRegistered(process.argv[2]);\n`);
    for (let trial = 0; trial < 2; trial++) {
      rmSync(configPath(), { force: true });
      const dirs = Array.from({ length: 8 }, (_, i) => {
        const d = join(home, `t${trial}-repo${i}`);
        mkdirSync(d, { recursive: true });
        return d;
      });
      await Promise.all(dirs.map((d) =>
        execFileAsync(TSX, [script, d], { env: { ...process.env, IX_HOME: home, IX_LOCK_DIR: join(home, "locks") } })));
      const registered = (parse(readFileSync(configPath(), "utf8")).workspaces ?? []).map((w: { root_path: string }) => w.root_path);
      expect(registered.sort()).toEqual(dirs.sort());
    }
  }, 60_000);
});

describe("a config that does not parse", () => {
  it("throws ConfigParseError naming the file, rather than answering defaults", async () => {
    writeFileSync(configPath(), "endpoint: [unclosed\nworkspaces:\n  - x\n");
    const { loadConfig, ConfigParseError } = await import("../config.js");
    expect(() => loadConfig()).toThrow(ConfigParseError);
    expect(() => loadConfig()).toThrow(configPath());
  });

  it("a top level that is not a mapping is refused too; an empty file is defaults", async () => {
    const { loadConfig, ConfigParseError, resetConfigMemo } = await import("../config.js");
    writeFileSync(configPath(), "- a\n- b\n");
    expect(() => loadConfig()).toThrow(ConfigParseError);
    resetConfigMemo();
    writeFileSync(configPath(), "");
    expect(loadConfig().endpoint).toBe("http://localhost:8090");
  });

  it("the error boundary prints the path and the code, and exits 1", async () => {
    writeFileSync(configPath(), "endpoint: [unclosed\n");
    const { loadConfig } = await import("../config.js");
    const { renderCliError } = await import("../errors.js");
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { lines.push(String(s)); return true; });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    let err: unknown;
    try { loadConfig(); } catch (e) { err = e; }
    expect(() => renderCliError(err)).toThrow("exit 1");
    expect(lines.join("\n")).toContain(configPath());
    expect(lines.join("\n")).toMatch(/not valid YAML/);
  });

  it("ix map, which finds its root through the config, names it too, not invalid_map_path", async () => {
    writeFileSync(configPath(), "endpoint: [unclosed\n");
    const repo = mkdtempSync(join(tmpdir(), "ix-cfg-repo-"));
    try {
      const main = join(CLI_ROOT, "src", "cli", "main.ts");
      const env: NodeJS.ProcessEnv = { ...process.env, IX_HOME: home, IX_ENDPOINT: "http://127.0.0.1:1" };
      delete env.FORCE_COLOR;
      for (const format of ["json", "llm"]) {
        const out = await execFileAsync(TSX, [main, "map", "--format", format], { cwd: repo, env })
          .then(() => { throw new Error("ix map exited 0 on a broken config"); },
                (e: { code?: number; stdout?: string }) => e);
        expect(out.code).toBe(1);
        expect(out.stdout).toMatch(/config_parse_error/);
        expect(out.stdout).not.toMatch(/invalid_map_path/);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("saveConfig still refuses to overwrite it", async () => {
    writeFileSync(configPath(), "endpoint: [unclosed\n");
    const { saveConfig } = await import("../config.js");
    expect(() => saveConfig({ endpoint: "http://localhost:8090", format: "text" })).toThrow(/not valid YAML/);
    expect(readFileSync(configPath(), "utf8")).toBe("endpoint: [unclosed\n");
  });
});

describe("loadConfig is parsed once per change", () => {
  it("answers from the memo, hands out copies, and sees saves and outside writes", async () => {
    writeFileSync(configPath(), "endpoint: http://localhost:8090\nformat: text\nworkspaces: []\n");
    const parseSpy = vi.fn();
    vi.doMock("yaml", async (orig) => {
      const real = await orig<typeof import("yaml")>();
      return { ...real, parse: (...args: Parameters<typeof real.parse>) => { parseSpy(); return real.parse(...args); } };
    });
    const { loadConfig, saveConfig } = await import("../config.js");
    const first = loadConfig();
    first.workspaces!.push({ workspace_id: "x", workspace_name: "x", root_path: "/x", default: true });
    const second = loadConfig();
    expect(second.workspaces).toEqual([]); // the caller's edit did not reach the memo
    const parsesBefore = parseSpy.mock.calls.length;
    loadConfig();
    loadConfig();
    expect(parseSpy.mock.calls.length).toBe(parsesBefore);

    saveConfig({ ...second, format: "json" });
    expect(loadConfig().format).toBe("json");

    // Another process writes: a different size is seen at once.
    writeFileSync(configPath(), "endpoint: http://localhost:8190\nformat: text\n");
    expect(loadConfig().endpoint).toBe("http://localhost:8190");
    vi.doUnmock("yaml");
  });
});

describe("readConfiguredFormat, for command registration", () => {
  it("reads the top-level format line without parsing the file", async () => {
    const { readConfiguredFormat, resetConfigMemo } = await import("../config.js");
    const cases: Array<[string, string | undefined]> = [
      ["format: llm\n", "llm"],
      ["endpoint: x\nformat: \"json\"  # chosen\n", "json"],
      ["format: 'text'\n", "text"],
      ["endpoint: x\n", undefined],
      ["nested:\n  format: llm\n", undefined],
      // Broken elsewhere: registration still gets its answer; the command reports the file.
      ["format: json\nendpoint: [unclosed\n", "json"],
    ];
    for (const [text, want] of cases) {
      resetConfigMemo();
      writeFileSync(configPath(), text);
      expect(readConfiguredFormat(), text).toBe(want);
    }
    rmSync(configPath());
    expect(readConfiguredFormat()).toBeUndefined();
  });
});

describe("ix config", () => {
  async function run(...args: string[]): Promise<{ out: string; code: number | string | undefined }> {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
    const savedCode = process.exitCode;
    process.exitCode = undefined;
    const { registerConfigCommand } = await import("../commands/config.js");
    const program = new Command().exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(["config", ...args], { from: "user" });
    const code = process.exitCode;
    process.exitCode = savedCode;
    return { out: out.join("\n"), code };
  }

  it("show redacts tokens and does not dump nested credentials", async () => {
    writeFileSync(configPath(),
      "endpoint: http://localhost:8090\nformat: text\nauth:\n  local_token: abc123secretvalue\n" +
      "instances:\n  prod:\n    jwt: eyJhbGciOi\n    refresh_token: rt-123\n");
    const { out } = await run("show");
    expect(out).toContain("auth.local_token");
    expect(out).toContain("(redacted)");
    expect(out).not.toContain("abc123secretvalue");
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).not.toContain("rt-123");
  });

  it("set refuses workspaces and a non-URL endpoint, and accepts a URL", async () => {
    writeFileSync(configPath(), "endpoint: http://localhost:8090\nformat: text\nworkspaces:\n  - workspace_id: \"a\"\n    workspace_name: a\n    root_path: /a\n    default: true\n");
    expect((await run("set", "workspaces", "oops")).code).toBe(1);
    expect((await run("set", "endpoint", "localhost:8090")).code).toBe(1);
    expect((await run("set", "endpoint", "ftp://x")).code).toBe(1);
    expect(parse(readFileSync(configPath(), "utf8")).workspaces).toHaveLength(1);
    expect((await run("set", "endpoint", "http://127.0.0.1:8190")).code).toBeUndefined();
    expect(parse(readFileSync(configPath(), "utf8")).endpoint).toBe("http://127.0.0.1:8190");
  });

  it("prune drops roots that no longer exist, keeps a default, and --dry-run changes nothing", async () => {
    const live = join(home, "live");
    mkdirSync(live);
    writeFileSync(configPath(),
      "endpoint: http://localhost:8090\nformat: text\nworkspaces:\n" +
      `  - workspace_id: "gone"\n    workspace_name: gone\n    root_path: ${join(home, "gone")}\n    default: true\n` +
      `  - workspace_id: "live"\n    workspace_name: live\n    root_path: ${live}\n    default: false\n`);
    const before = readFileSync(configPath(), "utf8");
    expect((await run("prune", "--dry-run")).out).toMatch(/would remove gone/);
    expect(readFileSync(configPath(), "utf8")).toBe(before);

    expect((await run("prune")).out).toMatch(/removed gone/);
    const after = parse(readFileSync(configPath(), "utf8")).workspaces;
    expect(after).toEqual([{ workspace_id: "live", workspace_name: "live", root_path: live, default: true }]);
  });
});
