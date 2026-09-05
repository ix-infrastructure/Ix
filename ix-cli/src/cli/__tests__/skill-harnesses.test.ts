import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { quoteForCmd as tsQuoteForCmd } from "../../mcp/hosts.js";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The helper is plain ESM (.mjs) that install-skill.sh runs without a build
 * step. Its public shape is declared here instead of in a hand-written
 * .d.mts, so a signature change in the helper surfaces as a runtime failure
 * in these tests rather than a typecheck that checks nothing.
 */
type HarnessRow = { id: string; label: string; bin: string; cfg: string; skill: string };
type ProbeResult = { present: boolean; via: string };

// @ts-expect-error — no .d.mts by design (review #591): the local interface
// below is the type contract, and a helper shape change fails here at runtime.
const helper = (await import("../../../scripts/skill-harnesses.mjs")) as unknown as {
  readHarnesses: () => HarnessRow[];
  probePresent: (
    row: HarnessRow,
    deps?: {
      toolscanNames?: Set<string> | null;
      binOnPath?: (bin: string) => boolean;
      exists?: (path: string) => boolean;
    },
  ) => ProbeResult;
  resolveToolscan: () => { cmd: string; args: string[] } | null;
  runToolscanOnce: (resolve?: () => { cmd: string; args: string[] } | null) => Set<string> | null;
  quoteForCmd: (arg: string) => string;
};

const { probePresent, readHarnesses, resolveToolscan, runToolscanOnce, quoteForCmd } = helper;

const row = (overrides: Partial<{ bin: string; cfg: string }> = {}) => ({
  id: "claude",
  label: "Claude Code",
  bin: "claude",
  cfg: "~/.claude",
  skill: "~/.claude/skills",
  ...overrides,
});

describe("probePresent", () => {
  it("counts a harness present when toolscan found its CLI, even off PATH", () => {
    const present = probePresent(row(), {
      toolscanNames: new Set(["claude"]),
      binOnPath: () => false,
      exists: () => false,
    });

    expect(present).toEqual({ present: true, via: "toolscan" });
  });

  it("counts a harness present when its config dir exists, even with no CLI", () => {
    // The GUI-only case: no bin anywhere, but ~/.agents exists.
    const present = probePresent(row({ bin: "cursor", cfg: "~/.cursor" }), {
      toolscanNames: new Set(["claude"]),
      binOnPath: () => false,
      exists: (path) => path.endsWith(".cursor"),
    });

    expect(present).toEqual({ present: true, via: "config-dir" });
  });

  it("counts a harness absent when neither toolscan, PATH, nor the config dir has it", () => {
    const present = probePresent(row({ bin: "codex", cfg: "~/.codex" }), {
      toolscanNames: new Set(["claude"]),
      binOnPath: () => false,
      exists: () => false,
    });

    expect(present).toEqual({ present: false, via: "none" });
  });

  it("falls back to the embedded PATH probe when toolscan is unavailable", () => {
    const present = probePresent(row(), {
      toolscanNames: null,
      binOnPath: () => true,
      exists: () => false,
    });

    expect(present).toEqual({ present: true, via: "path" });
  });

  it("matches toolscan names against the lowercased bin", () => {
    // runToolscanOnce lowercases at ingestion; the probe receives that shape.
    const present = probePresent(row(), {
      toolscanNames: new Set(["claude"]),
      binOnPath: () => false,
      exists: () => false,
    });

    expect(present).toEqual({ present: true, via: "toolscan" });
  });
});

describe("resolveToolscan (the security pin)", () => {
  it("never resolves a bare `toolscan` from PATH — TOOLSCAN_PATH is the only opt-in", () => {
    // KageBinary #591 round-2 finding: the TS copy of this resolver carries a
    // pin in discovery.test.ts; the shell-side copy must too. A PATH fallback
    // re-added here would execute any attacker-planted `toolscan`; planting one
    // on PATH and expecting null makes that regression go red.
    const dir = mkdtempSync(join(tmpdir(), "ix-skill-pin-"));
    scratch.push(dir);
    const plant = join(dir, process.platform === "win32" ? "toolscan.cmd" : "toolscan");
    writeFileSync(plant, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
    const previousPath = process.env.PATH;
    const previousTs = process.env.TOOLSCAN_PATH;
    delete process.env.TOOLSCAN_PATH;
    process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
    try {
      expect(resolveToolscan()).toBeNull();
    } finally {
      if (previousTs === undefined) delete process.env.TOOLSCAN_PATH;
      else process.env.TOOLSCAN_PATH = previousTs;
      process.env.PATH = previousPath ?? "";
    }
  });
});

describe("quoteForCmd (drift guard vs hosts.ts)", () => {
  // The .mjs mirrors hosts.ts::quoteForCmd because it cannot import TS. This
  // battery keeps the two byte-identical — a divergence here is exactly the
  // "unquoted path with a space gets split" class the mirror exists to avoid.
  const cases = [
    ["C:\\node.exe", "C:\\node.exe"],
    ["C:\\Program Files\\bin\\toolscan.cmd", '"C:\\Program Files\\bin\\toolscan.cmd"'],
    ["C:\\a&b\\x.cmd", '"C:\\a&b\\x.cmd"'],
    // Backslash is in the safe-bare class, so a lone backslash path is bare.
    ["C:\\foo\\", "C:\\foo\\"],
    // A space forces quoting; trailing backslashes are doubled before the
    // closing quote so cmd does not eat it.
    ["C:\\Program Files\\foo\\", '"C:\\Program Files\\foo\\\\"'],
    // `~` is not in the safe-bare class (mirrors hosts.ts exactly).
    ["~/.local/bin/claude", '"~/.local/bin/claude"'],
    ["/opt/ix tools/bin/claude", '"/opt/ix tools/bin/claude"'],
    ["npm-run.cmd", "npm-run.cmd"],
  ] as const;

  for (const [input, expected] of cases) {
    it(`quotes ${JSON.stringify(input)}`, () => {
      expect(quoteForCmd(input)).toBe(expected);
    });
  }

  it("matches hosts.ts::quoteForCmd on every case", () => {
    for (const [input] of cases) {
      expect(quoteForCmd(input)).toBe(tsQuoteForCmd(input));
    }
  });
});

describe("runToolscanOnce", () => {
  it("ignores an entry that names a tool without a usable path", () => {
    const nameOnly = runToolscanOnce(() => ({
      cmd: process.execPath,
      args: ["-e", `process.stdout.write(JSON.stringify({ tools: [{ name: "claude" }], truncated: false }))`],
    }));

    expect(nameOnly).toEqual(new Set());
  });

  it("keeps an entry whose tool carries a path", () => {
    const withPath = runToolscanOnce(() => ({
      cmd: process.execPath,
      args: [
        "-e",
        `process.stdout.write(JSON.stringify({ tools: [{ name: "claude", path: "/x/claude" }], truncated: false }))`,
      ],
    }));

    expect(withPath).toEqual(new Set(["claude"]));
  });
});

describe("readHarnesses", () => {
  it("lists exactly the harnesses with a verified skills convention", () => {
    const rows = readHarnesses();

    // Deliberately small and explicit: only harnesses whose skills directory
    // is verified to be read belong here. gemini/opencode/openclaw/vscode
    // have no skills convention, so they must not be install targets.
    expect(rows.map((r) => r.id)).toEqual(["claude", "agents", "codex", "cursor"]);
  });

  it("points cursor at skills-cursor, the directory Cursor actually reads", () => {
    const cursor = readHarnesses().find((r) => r.id === "cursor");

    expect(cursor).toMatchObject({ cfg: "~/.cursor", skill: "~/.cursor/skills-cursor" });
  });

  it("appends the agents.md surface as a documented supplement", () => {
    const agents = readHarnesses().find((r) => r.id === "agents");

    expect(agents).toMatchObject({ bin: "", cfg: "~/.agents", skill: "~/.agents/skills" });
  });
});