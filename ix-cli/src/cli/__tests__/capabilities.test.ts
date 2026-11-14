// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES_SCHEMA,
  HOOK_SUBCOMMANDS,
  collectCapabilities,
  parseFastCapabilitiesArgs,
  renderCapabilities,
  runFastCapabilities,
} from "../capabilities.js";
import { registerCapabilitiesCommand } from "../commands/capabilities.js";
import { registerHookCommand } from "../commands/hook.js";
import { proInstallState } from "../register/pro-loader.js";
import { isRepairInvocation, skipsProLoading } from "../register/pro-failure.js";
import { setPrettyJson } from "../format.js";

/**
 * `ix capabilities` is the probe plugins run instead of `ix briefing`,
 * `ix --version` parsing and `ix mcp --help` grepping. Its JSON shape is a
 * contract with them, so it is pinned here field by field.
 */

function notFound(code: string): Error {
  return Object.assign(new Error(`Cannot find ${code}`), { code });
}

/** A resolver that resolves exactly the specifiers in `ok`, failing the rest with `code`. */
function resolver(ok: string[], code = "ERR_MODULE_NOT_FOUND"): (s: string) => string {
  return (specifier) => {
    if (ok.includes(specifier)) return `file:///x/node_modules/${specifier}.js`;
    throw notFound(code);
  };
}

describe("proInstallState", () => {
  it("is absent when neither the package nor its register entry resolves", () => {
    expect(proInstallState(resolver([]))).toBe("absent");
  });

  it("is installed when the register entry resolves to a file that exists", () => {
    expect(proInstallState(resolver(["@ix/pro", "@ix/pro/register"]), () => true)).toBe("installed");
  });

  it("is broken when the register entry resolves but its file is gone", () => {
    // `exports` still maps ./register, so resolution succeeds; the file does not exist.
    const seen: string[] = [];
    const exists = (url: string) => { seen.push(url); return false; };
    expect(proInstallState(resolver(["@ix/pro", "@ix/pro/register"]), exists)).toBe("broken");
    expect(seen).toEqual(["file:///x/node_modules/@ix/pro/register.js"]);
  });

  it("is broken when the package resolves but its register entry does not", () => {
    expect(proInstallState(resolver(["@ix/pro"]))).toBe("broken");
  });

  it("is broken when the package is there but exports no entry point", () => {
    // ERR_PACKAGE_PATH_NOT_EXPORTED still proves the package is installed.
    expect(proInstallState(resolver([], "ERR_PACKAGE_PATH_NOT_EXPORTED"))).toBe("broken");
  });

  it("is absent in this checkout, which has no @ix/pro", () => {
    expect(proInstallState()).toBe("absent");
  });
});

describe("collectCapabilities", () => {
  it("has the stable ix-capabilities/1 shape", () => {
    const caps = collectCapabilities(() => "installed", "1.2.3");
    expect(caps).toEqual({
      schema: "ix-capabilities/1",
      version: "1.2.3",
      pro: { available: true, state: "installed" },
      hooks: ["claude-post-edit"],
    });
    expect(Object.keys(caps)).toEqual(["schema", "version", "pro", "hooks"]);
    expect(CAPABILITIES_SCHEMA).toBe("ix-capabilities/1");
  });

  it("reports Pro available only when it is installed", () => {
    expect(collectCapabilities(() => "absent", "1.0.0").pro).toEqual({ available: false, state: "absent" });
    expect(collectCapabilities(() => "broken", "1.0.0").pro).toEqual({ available: false, state: "broken" });
  });

  it("lists exactly the ix hook subcommands the CLI registers", () => {
    const program = new Command();
    registerHookCommand(program);
    const hook = program.commands.find((c) => c.name() === "hook");
    expect(hook?.commands.map((c) => c.name())).toEqual([...HOOK_SUBCOMMANDS]);
  });
});

describe("renderCapabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setPrettyJson(false);
  });

  function captured(format: string): string {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    renderCapabilities(collectCapabilities(() => "absent", "1.2.3"), format);
    return lines.join("\n");
  }

  it("prints one JSON object for json", () => {
    expect(JSON.parse(captured("json")).schema).toBe("ix-capabilities/1");
  });

  it("prints llm records", () => {
    expect(captured("llm")).toBe(
      "capabilities schema=ix-capabilities/1 version=1.2.3 pro=absent\nhook name=claude-post-edit",
    );
  });

  it("prints text for a person", () => {
    expect(captured("text")).toBe("Version: 1.2.3\nIx Pro:  not installed\nHooks:   claude-post-edit");
  });
});

describe("the fast path's arguments", () => {
  it("accepts an explicit --format, in either spelling, and --pretty", () => {
    expect(parseFastCapabilitiesArgs(["--format", "json"])).toEqual({ format: "json", pretty: false });
    expect(parseFastCapabilitiesArgs(["--format=llm"])).toEqual({ format: "llm", pretty: false });
    expect(parseFastCapabilitiesArgs(["--pretty", "--format", "json"])).toEqual({ format: "json", pretty: true });
    expect(parseFastCapabilitiesArgs(["--format", "text", "--format", "json"])).toEqual({ format: "json", pretty: false });
  });

  it("leaves everything else to the full CLI", () => {
    for (const rest of [
      [],                         // default format comes from IX_FORMAT / config
      ["--pretty"],
      ["--format"],
      ["--format", "yaml"],       // commander's error, in its words
      ["--format=yaml"],
      ["--format", "json", "--help"],
      ["-h"],
      ["--format", "json", "--quiet"],
      ["extra"],
    ]) {
      expect(parseFastCapabilitiesArgs(rest), JSON.stringify(rest)).toBeUndefined();
    }
  });

  it("prints nothing and declines when IX_LOAD_ALL_COMMANDS=1", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(runFastCapabilities(["--format", "json"], { IX_LOAD_ALL_COMMANDS: "1" })).toBe(false);
      expect(runFastCapabilities(["--bogus"], {})).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("a broken Ix Pro", () => {
  it("does not stop ix capabilities, which reports it", () => {
    expect(isRepairInvocation(["node", "ix", "capabilities"])).toBe(true);
  });
});

describe("an installed Ix Pro", () => {
  // The help text and flags.md promise Pro is resolved, never loaded or
  // initialized. main.ts's fast path keeps that for `--format <fmt>`; every
  // other form (`--help`, `--quiet`, no `--format`) reaches run-cli, which must
  // skip tryLoadProCommands for it as it does for `ix hook`.
  it("is never loaded by ix capabilities on the full CLI path", () => {
    for (const rest of [[], ["--help"], ["--quiet"], ["--format", "json", "--fields", "x"]]) {
      expect(skipsProLoading(["node", "ix", "capabilities", ...rest])).toBe(true);
    }
    expect(skipsProLoading(["node", "ix", "hook", "claude-post-edit"])).toBe(true);
  });

  it("is still loaded for every other command", () => {
    for (const word of ["status", "briefing", "doctor", "help", undefined]) {
      const argv = word === undefined ? ["node", "ix"] : ["node", "ix", word];
      expect(skipsProLoading(argv)).toBe(false);
    }
  });
});

describe("when to ask again", () => {
  // Installing, breaking or repairing Ix Pro changes pro.state while the ix
  // executable stays byte-for-byte the same, so a plugin cache keyed on the
  // resolved ix path and its mtime would keep a stale answer. This drives a
  // real install layout through those steps to prove it, then holds the
  // advice to "ask again once per session".
  it("pro.state changes across a Pro install, breakage and repair while the ix entry point does not", () => {
    const root = mkdtempSync(join(tmpdir(), "ix-capabilities-"));
    try {
      const main = join(root, "dist", "cli", "main.js");
      mkdirSync(dirname(main), { recursive: true });
      writeFileSync(main, "// ix\n");
      const req = createRequire(main);
      // Resolve from the ix entry point, as the loader resolves from itself.
      // CommonJS says MODULE_NOT_FOUND where ESM says ERR_MODULE_NOT_FOUND.
      const resolve = (specifier: string): string => {
        try {
          return pathToFileURL(req.resolve(specifier)).href;
        } catch (error) {
          const code = (error as { code?: string }).code;
          throw Object.assign(new Error(String(error)), { code: code === "MODULE_NOT_FOUND" ? "ERR_MODULE_NOT_FOUND" : code });
        }
      };
      const probe = () => collectCapabilities(() => proInstallState(resolve), "1.0.0").pro.state;
      const ixKey = () => { const st = statSync(main); return `${main}@${st.mtimeMs}`; };
      const key = ixKey();

      expect(probe()).toBe("absent");

      const pro = join(root, "node_modules", "@ix", "pro");
      const register = join(pro, "register.js");
      mkdirSync(pro, { recursive: true });
      writeFileSync(join(pro, "package.json"), JSON.stringify({
        name: "@ix/pro", exports: { ".": "./index.js", "./register": "./register.js" },
      }));
      writeFileSync(join(pro, "index.js"), "");
      writeFileSync(register, "");
      expect(probe()).toBe("installed");

      rmSync(register);
      expect(probe()).toBe("broken");

      writeFileSync(register, "");
      expect(probe()).toBe("installed");

      expect(ixKey()).toBe(key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is advised once per session, not cached per ix path, in the help and in flags.md", () => {
    const program = new Command();
    let help = "";
    program.configureOutput({ writeOut: (s) => { help += s; }, writeErr: () => {} });
    registerCapabilitiesCommand(program);
    program.commands.find((c) => c.name() === "capabilities")!.outputHelp();

    const flagsMd = readFileSync(
      fileURLToPath(new URL("../../../../skills/ix/references/flags.md", import.meta.url)), "utf8",
    );
    const section = flagsMd.slice(flagsMd.indexOf("### `ix capabilities`"), flagsMd.indexOf("### `ix config`"));

    for (const [where, text] of [["help", help.replace(/\s+/g, " ")], ["flags.md", section]] as const) {
      expect(text, where).toContain("Ask again once per session");
      expect(text, where).not.toMatch(/cache it per resolved/i);
    }
  });
});
