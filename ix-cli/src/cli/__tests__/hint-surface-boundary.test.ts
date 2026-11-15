// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The command layer knows nothing about MCP's tool catalog (#935).
 *
 * Commands describe a next step as data (`next-step.ts`); the MCP layer
 * (`mcp/hints.ts`) is the only place that turns one into a tool call. So no
 * source file under `src/cli/` may name an MCP tool in code or read the
 * caller from the environment.
 */
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The one table that maps Pro commands to their MCP tools. It is the single
 * registry the MCP server and the plugin contract script both read, not a
 * hint, and it must stay import-free (see its header).
 */
const ALLOWED = new Set(["register/pro-surface.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The file with comments removed: prose may name a tool; code may not. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("src/cli has no MCP awareness", () => {
  const files = sourceFiles(CLI_ROOT).map((file) => ({ file, rel: relative(CLI_ROOT, file).split("\\").join("/") }));

  it("finds the sources it checks", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("names no MCP tool outside the Pro surface table", () => {
    const offenders: string[] = [];
    for (const { file, rel } of files) {
      if (ALLOWED.has(rel)) continue;
      const names = code(readFileSync(file, "utf8")).match(/["'`]ix_(?!on_path\b|missing\b)[a-z_]+/g);
      if (names) offenders.push(`${rel}: ${[...new Set(names)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("never reads IX_CALLER", () => {
    const offenders = files
      .filter(({ file }) => /IX_CALLER/.test(readFileSync(file, "utf8")))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
