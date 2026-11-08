// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerInstallCommand } from "../commands/install.js";
import {
  createSkillEngine,
  engineArgs,
  locateSkillInstaller,
  parseSelection,
  parseSkillReport,
  runInstallMenu,
  type EngineResult,
  type InstallMenuDeps,
  type InstallOptions,
  type SkillEngine,
  type SkillHost,
} from "../install-menu.js";

/**
 * Parity tests for `ix install` (#612): the menu is a pre-fill over
 * scripts/install-skill.sh, so the same choices made through the menu and
 * through the script must give the same per-host decisions.
 *
 * The real-engine tests run the actual script in a scratch HOME (HOME and
 * HARNESS_HOME both point at it, so presence and destinations agree). They are
 * skipped on Windows: a bare `bash` there can resolve to the WSL launcher in
 * System32 rather than Git Bash, which says nothing about this code. CI's
 * Windows harness smoke covers the script under Git Bash.
 */

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(harnesses: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), "ix-install-menu-"));
  scratch.push(home);
  for (const id of harnesses) mkdirSync(join(home, `.${id}`), { recursive: true });
  return home;
}

const script = locateSkillInstaller();

/**
 * PATH with node and the basic tools the script needs, and no harness CLIs:
 * presence then comes from config directories in the scratch HOME only.
 */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    HARNESS_HOME: home,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    LANG: "C",
  };
  return env;
}

function realEngine(home: string): SkillEngine & { calls: string[][] } {
  if (!script) throw new Error("scripts/install-skill.sh not found beside the CLI source");
  const run = createSkillEngine(script, hermeticEnv(home));
  const calls: string[][] = [];
  const engine = ((args: string[]) => {
    calls.push(args);
    return run(args);
  }) as SkillEngine & { calls: string[][] };
  engine.calls = calls;
  return engine;
}

interface Harness {
  deps: InstallMenuDeps;
  stdout: () => string;
  stderr: () => string;
  questions: string[];
}

function harness(
  engine: SkillEngine,
  answers: string[],
  extra: Partial<InstallMenuDeps> = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const queue = [...answers];
  return {
    deps: {
      engine,
      interactive: true,
      ask: async (q) => {
        questions.push(q);
        return queue.length > 0 ? (queue.shift() as string) : null;
      },
      out: (t) => out.push(t),
      err: (t) => err.push(t.endsWith("\n") ? t : `${t}\n`),
      banner: () => "  BANNER",
      ...extra,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    questions,
  };
}

const opts = (o: Partial<InstallOptions> = {}): InstallOptions => ({
  ids: [],
  dryRun: false,
  force: false,
  json: false,
  yes: false,
  ...o,
});

const decisions = (stdout: string) =>
  (parseSkillReport(stdout)?.hosts ?? []).map((h) => ({
    id: h.id,
    action: h.action,
    detectedVia: h.detectedVia,
  }));

const ANSI = /\u001b\[/;

describe("engineArgs", () => {
  it("spells the choices the way the script does", () => {
    expect(engineArgs({ ids: ["claude", "codex"], dryRun: true, force: true, json: true })).toEqual(
      ["--dry-run", "--force", "--json", "claude", "codex"],
    );
    expect(engineArgs({ ids: [], dryRun: false, force: false, json: false })).toEqual([]);
  });
});

describe("parseSelection", () => {
  const hosts: SkillHost[] = ["claude", "agents", "codex"].map((id) => ({
    id,
    action: "skip",
    dest: null,
    detectedVia: "none",
  }));

  it("accepts ids and row numbers, returned in registry order", () => {
    expect(parseSelection("3, claude", hosts, [])).toEqual({ ids: ["claude", "codex"] });
  });

  it("keeps the default on an empty answer and selects nothing on 'none'", () => {
    expect(parseSelection("  ", hosts, ["agents"])).toEqual({ ids: ["agents"] });
    expect(parseSelection("none", hosts, ["agents"])).toEqual({ ids: [] });
  });

  it("names a token it cannot place", () => {
    expect(parseSelection("claude 9", hosts, [])).toMatchObject({
      error: expect.stringContaining("'9'"),
    });
  });
});

describe("rows come from the engine's preview", () => {
  it("renders one row per host the engine reports: a fifth registry id gives five rows", async () => {
    const ids = ["claude", "agents", "codex", "cursor", "fifth"];
    const report = {
      dryRun: true,
      hosts: ids.map((id) => ({ id, action: "skip", dest: null, detectedVia: "none" })),
    };
    const fake: SkillEngine = (): EngineResult => ({
      status: 0,
      stdout: JSON.stringify(report),
      stderr: "",
    });
    const h = harness(fake, ["none"]);

    expect(await runInstallMenu(opts(), h.deps)).toBe(0);
    const rows = h
      .stderr()
      .split("\n")
      .filter((l) => /^\s+\[[ x]\]\s+\d+\. /.test(l));
    expect(rows).toHaveLength(5);
    expect(rows[4]).toContain("fifth");
  });
});

describe("--help", () => {
  it("exits 0 with no toolchain on PATH and never runs the engine", () => {
    const program = new Command();
    program.exitOverride();
    let help = "";
    program.configureOutput({ writeOut: (s) => (help += s), writeErr: () => {} });
    registerInstallCommand(program);
    const command = program.commands.find((c) => c.name() === "install");
    command?.exitOverride();
    command?.configureOutput({ writeOut: (s) => (help += s), writeErr: () => {} });
    const previous = process.env.PATH;
    process.env.PATH = "";
    try {
      program.parse(["node", "ix", "install", "--help"]);
      throw new Error("--help did not exit");
    } catch (e) {
      expect(e).toBeInstanceOf(CommanderError);
      expect((e as CommanderError).exitCode).toBe(0);
    } finally {
      process.env.PATH = previous;
    }
    expect(help).toContain("--dry-run");
    expect(help).toContain("Nothing is");
  });
});

describe.skipIf(process.platform === "win32" || !script)(
  "ix install against the real installer",
  () => {
    it("off a terminal: prints the hint, writes nothing, never runs the engine", async () => {
      const home = scratchHome(["claude"]);
      const engine = realEngine(home);
      const h = harness(engine, [], { interactive: false });

      expect(await runInstallMenu(opts({ ids: ["claude"] }), h.deps)).toBe(1);
      expect(h.stderr()).toContain("not an interactive terminal, so nothing was written");
      expect(h.stdout()).toBe("");
      expect(engine.calls).toEqual([]);
      expect(existsSync(join(home, ".claude", "skills", "ix"))).toBe(false);
    });

    it("off a terminal with --dry-run --json: stdout is the script's report, byte for byte", async () => {
      const home = scratchHome(["claude", "codex"]);
      const h = harness(realEngine(home), [], { interactive: false });

      const code = await runInstallMenu(opts({ dryRun: true, json: true }), h.deps);
      const scripted = realEngine(home)(["--dry-run", "--json"]);

      expect(code).toBe(scripted.status);
      expect(h.stdout()).toBe(scripted.stdout);
    });

    it("declining the confirmation writes nothing", async () => {
      const home = scratchHome(["claude", "codex"]);
      const engine = realEngine(home);
      const h = harness(engine, ["", "a", "n"]);

      expect(await runInstallMenu(opts(), h.deps)).toBe(0);
      expect(h.stderr()).toContain("Nothing was written.");
      expect(engine.calls.every((args) => args.includes("--dry-run"))).toBe(true);
      expect(existsSync(join(home, ".claude", "skills", "ix"))).toBe(false);
      expect(existsSync(join(home, ".codex", "skills", "ix"))).toBe(false);
    });

    it("a chosen subset, dry run, matches the scripted --dry-run --json report action by action", async () => {
      const home = scratchHome(["claude", "codex", "cursor"]);
      const h = harness(realEngine(home), ["claude cursor", "d"]);

      const code = await runInstallMenu(opts({ json: true }), h.deps);
      const scripted = realEngine(home)(["--dry-run", "--json", "claude", "cursor"]);

      expect(code).toBe(scripted.status);
      expect(decisions(h.stdout())).toEqual(decisions(scripted.stdout));
      expect(decisions(h.stdout()).map((d) => d.action)).toEqual([
        "would-install",
        "would-install",
      ]);
      expect(h.stderr()).toContain(
        "Equivalent command: bash scripts/install-skill.sh --dry-run --json claude cursor",
      );
    });

    it("a chosen subset, applied, matches the scripted apply action by action", async () => {
      const menuHome = scratchHome(["claude", "codex", "cursor"]);
      const scriptHome = scratchHome(["claude", "codex", "cursor"]);
      const h = harness(realEngine(menuHome), ["1 3", "a", "y"]);

      const code = await runInstallMenu(opts({ json: true }), h.deps);
      const scripted = realEngine(scriptHome)(["--json", "claude", "codex"]);

      expect(code).toBe(scripted.status);
      expect(decisions(h.stdout())).toEqual(decisions(scripted.stdout));
      expect(decisions(h.stdout()).map((d) => d.action)).toEqual(["installed", "installed"]);
      expect(existsSync(join(menuHome, ".claude", "skills", "ix", "SKILL.md"))).toBe(true);
      expect(existsSync(join(menuHome, ".cursor", "skills-cursor", "ix"))).toBe(false);
    });

    it("a foreign skill named ix is refused for that host only, and left untouched", async () => {
      const home = scratchHome(["claude", "codex"]);
      const foreign = join(home, ".claude", "skills", "ix");
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, "SKILL.md"), "---\nname: someone-elses\n---\n", "utf8");
      const h = harness(realEngine(home), ["claude codex", "a", "n", "y"]);

      const code = await runInstallMenu(opts({ json: true }), h.deps);

      expect(code).toBe(1);
      expect(h.questions.some((q) => q.includes("--force"))).toBe(true);
      const byId = new Map(decisions(h.stdout()).map((d) => [d.id, d.action]));
      expect(byId.get("claude")).toBe("refused");
      expect(byId.get("codex")).toBe("installed");
      expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toContain("someone-elses");
    });

    it("--json stdout parses and carries no banner; the banner goes to stderr", async () => {
      const home = scratchHome(["claude"]);
      const h = harness(realEngine(home), ["", "d"]);

      await runInstallMenu(opts({ json: true }), h.deps);

      expect(() => JSON.parse(h.stdout())).not.toThrow();
      expect(h.stdout()).not.toContain("BANNER");
      expect(h.stderr()).toContain("BANNER");
    });

    it("TERM=dumb / NO_COLOR give the same report, with no ANSI anywhere", async () => {
      const home = scratchHome(["claude", "agents"]);
      const plain = harness(realEngine(home), ["", "d"]);
      await runInstallMenu(opts({ json: true }), plain.deps);

      const dumbEngine = createSkillEngine(script as string, {
        ...hermeticEnv(home),
        TERM: "dumb",
        NO_COLOR: "1",
      });
      const dumb = harness(dumbEngine, ["", "d"]);
      await runInstallMenu(opts({ json: true }), dumb.deps);

      expect(dumb.stdout()).toBe(plain.stdout());
      expect(dumb.stdout()).not.toMatch(ANSI);
      expect(dumb.stderr().replace("BANNER", "")).not.toMatch(ANSI);
    });

    it("--yes skips the menu and runs the script with the same options", async () => {
      const home = scratchHome(["agents"]);
      const engine = realEngine(home);
      const h = harness(engine, []);

      expect(await runInstallMenu(opts({ yes: true, json: true, ids: ["agents"] }), h.deps)).toBe(
        0,
      );
      expect(h.questions).toEqual([]);
      expect(engine.calls).toEqual([["--json", "agents"]]);
      expect(decisions(h.stdout()).map((d) => d.action)).toEqual(["installed"]);
    });

    it("an unknown pre-filled id is an error before any question", async () => {
      const home = scratchHome();
      const h = harness(realEngine(home), []);

      expect(await runInstallMenu(opts({ ids: ["nope"] }), h.deps)).toBe(1);
      expect(h.stderr()).toContain("unknown harness id 'nope'");
      expect(h.questions).toEqual([]);
    });
  },
);
