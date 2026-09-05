import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverTools, NO_DISCOVERY, parseToolscanOutput, resolveToolscan, type ToolDiscovery } from "../../mcp/discovery.js";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ix-discovery-"));
  scratch.push(dir);
  return dir;
}

describe("parseToolscanOutput", () => {
  it("indexes tools by lowercased name, keeping the first reported path", () => {
    const { names, paths } = parseToolscanOutput(
      JSON.stringify({
        tools: [
          { name: "claude", path: "C:\\a\\claude.cmd", source: "PATH" },
          { name: "CODE", path: "C:\\b\\code.exe", source: "PATH" },
          { name: "claude", path: "C:\\later\\claude.cmd", source: "root" },
        ],
      }),
    );

    expect(names.has("claude")).toBe(true);
    expect(names.has("code")).toBe(true);
    expect(paths.get("claude")).toBe("C:\\a\\claude.cmd");
    expect(paths.get("code")).toBe("C:\\b\\code.exe");
  });

  it("degrades to empty on non-JSON output", () => {
    const { names, paths } = parseToolscanOutput("traceback noise, not JSON");

    expect(names.size).toBe(0);
    expect(paths.size).toBe(0);
  });

  it("skips malformed tool entries without failing the rest", () => {
    const { names } = parseToolscanOutput(
      JSON.stringify({ tools: [{ name: 42 }, {}, null, { name: "" }, { name: "ok", path: "p" }] }),
    );

    expect([...names]).toEqual(["ok"]);
  });
});

describe("discoverTools", () => {
  it("returns the empty discovery when toolscan cannot be resolved", async () => {
    const discovery = await discoverTools(async () => null);

    expect(discovery).toEqual(NO_DISCOVERY);
  });

  it("returns the empty discovery when the toolscan run fails", async () => {
    const discovery = await discoverTools(
      async () => ({ cmd: "definitely-not-toolscan", args: [] }),
      parseToolscanOutput,
      async () => {
        throw new Error("spawn ENOENT");
      },
    );

    expect(discovery).toEqual(NO_DISCOVERY);
  });

  it("returns the empty discovery when the output parses to nothing", async () => {
    const discovery = await discoverTools(
      async () => ({ cmd: "toolscan", args: [] }),
      parseToolscanOutput,
      async () => ({ stdout: "garbage" }),
    );

    expect(discovery).toEqual(NO_DISCOVERY);
  });

  it("indexes real toolscan output", async () => {
    const discovery = await discoverTools(
      async () => ({ cmd: "toolscan", args: [] }),
      parseToolscanOutput,
      async () => ({
        stdout: JSON.stringify({ tools: [{ name: "claude", path: "C:\\a\\claude.cmd" }], truncated: false }),
      }),
    );

    expect(discovery.source).toBe("toolscan");
    expect(discovery.names.has("claude")).toBe(true);
  });

  it("resolves TOOLSCAN_PATH scripts through node and consumes their output", async () => {
    const script = join(tempDir(), "fake-toolscan.mjs");
    writeFileSync(script, 'console.log(JSON.stringify({ tools: [{ name: "claude", path: "x" }] }));');

    const previous = process.env.TOOLSCAN_PATH;
    process.env.TOOLSCAN_PATH = script;
    try {
      const discovery: ToolDiscovery = await discoverTools();
      expect(discovery.source).toBe("toolscan");
      expect(discovery.names.has("claude")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TOOLSCAN_PATH;
      else process.env.TOOLSCAN_PATH = previous;
    }
  });

  it("never executes a bare `toolscan` found on PATH", async () => {
    // Security pin: a PATH fallback would let any attacker-planted `toolscan`
    // decide which host config files `ix mcp install` writes. Discovery is
    // opt-in via TOOLSCAN_PATH only — a bare name on PATH is ignored even
    // though it resolves.
    const dir = tempDir();
    const name = process.platform === "win32" ? "toolscan.cmd" : "toolscan";
    writeFileSync(join(dir, name), process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(join(dir, name), 0o755);

    const previousPath = process.env.PATH;
    const previousToolscan = process.env.TOOLSCAN_PATH;
    delete process.env.TOOLSCAN_PATH;
    process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
    try {
      // The resolver itself must refuse the bare name even though it resolves.
      expect(await resolveToolscan()).toBeNull();
      const discovery = await discoverTools();
      expect(discovery).toEqual(NO_DISCOVERY);
    } finally {
      if (previousToolscan === undefined) delete process.env.TOOLSCAN_PATH;
      else process.env.TOOLSCAN_PATH = previousToolscan;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});