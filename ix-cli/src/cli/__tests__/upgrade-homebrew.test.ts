// Copyright 2026 Ix Infrastructure Inc.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { homebrewInstall } from "../commands/upgrade.js";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn((..._args: unknown[]) => ""),
}));

vi.mock("child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));

describe("homebrewInstall", () => {
  it("recognises an entry point inside a Homebrew Cellar", () => {
    expect(homebrewInstall("/opt/homebrew/Cellar/ix/0.12.0/libexec/dist/cli/main.js")).toBe(true);
    expect(homebrewInstall("/usr/local/Cellar/ix/0.11.1/libexec/dist/cli/main.js")).toBe(true);
    expect(homebrewInstall("/home/linuxbrew/.linuxbrew/Cellar/ix/0.12.0/libexec/dist/cli/main.js")).toBe(true);
  });

  it("does not take an installer or source checkout for one", () => {
    expect(homebrewInstall("/home/u/.ix/cli/cli/dist/cli/main.js")).toBe(false);
    expect(homebrewInstall("/home/u/src/Ix/ix-cli/dist/cli/main.js")).toBe(false);
    expect(homebrewInstall("/opt/homebrew/Cellar/other/1.0/bin/main.js")).toBe(false);
  });
});

describe("ix upgrade on a Homebrew install with a newer CLI released", () => {
  const TEST_DIR = dirname(fileURLToPath(import.meta.url));
  const CURRENT = JSON.parse(readFileSync(join(TEST_DIR, "..", "..", "..", "package.json"), "utf-8"))
    .version as string;
  let home: string;
  let originalIxHome: string | undefined;
  let originalArgv1: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalIxHome = process.env.IX_HOME;
    originalArgv1 = process.argv[1];
    home = mkdtempSync(join(tmpdir(), "ix-upgrade-homebrew-"));
    process.env.IX_HOME = home;
    mkdirSync(join(home, "backend"), { recursive: true });
    writeFileSync(join(home, ".backend-version"), "1.0.17");
    writeFileSync(
      join(home, "backend", "docker-compose.yml"),
      "services:\n  memory-layer:\n    image: ghcr.io/ix-infrastructure/ix-memory-layer:latest\n",
    );
    process.argv[1] = "/opt/homebrew/Cellar/ix/0.0.1/libexec/dist/cli/main.js";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/ix-memory-layer-dist/")) {
          return new Response(JSON.stringify({ tag_name: "v1.0.17" }), { status: 200 });
        }
        if (url.includes("/ix-compass-dist/")) return new Response("", { status: 404 });
        return new Response(JSON.stringify({ tag_name: "v99.0.0" }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    if (originalIxHome === undefined) delete process.env.IX_HOME;
    else process.env.IX_HOME = originalIxHome;
    if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
  });

  it("points at brew, downloads nothing, and does not close with [ok] up to date", async () => {
    expect(CURRENT).not.toBe("99.0.0");
    const { registerUpgradeCommand } = await import("../commands/upgrade.js");
    const program = new Command();
    program.name("ix").exitOverride();
    registerUpgradeCommand(program);

    const output: string[] = [];
    const capture = (...values: unknown[]) => void output.push(values.join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(capture);
    const error = vi.spyOn(console, "error").mockImplementation(capture);
    try {
      await program.parseAsync(["upgrade"], { from: "user" });
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    const text = output.join("\n");

    expect(text).toContain("brew upgrade ix");
    expect(mocks.execFileSync.mock.calls.some(([command]) => command === "curl")).toBe(false);
    expect(text).not.toContain("[ok] ix is up to date");
    expect(text).toContain("ix upgrade finished with the CLI unchanged");
  });
});
