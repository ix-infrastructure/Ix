// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every package the CLI loads before any command runs, following the static
 * `import`/`export ... from` edges from the entry point. Type-only imports
 * are erased by tsc and dynamic `import()` is deferred, so neither counts.
 */
function startupPackages(entries: string[]): { packages: Set<string>; modules: number } {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [...entries];
  const edge = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf-8");
    for (const match of text.matchAll(edge)) {
      const spec = match[1];
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        if (existsSync(target)) queue.push(target);
        else packages.add(spec); // e.g. a relative path out to core-ingestion's dist
      } else if (!spec.startsWith("node:")) {
        packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    }
  }
  return { packages, modules: seen.size };
}

describe("CLI start-up module graph", () => {
  it("does not load zod, the MCP SDK or the parser for every command", () => {
    // `main.ts` imports `run-cli.ts` unconditionally, after enabling the
    // compile cache, and `run-cli.ts` imports `register/oss.ts` (every command)
    // whenever it cannot register just the one being run -- a dynamic import,
    // so it is named here. Together they are the largest start-up graph.
    const { packages, modules } = startupPackages([
      join(SRC, "cli/main.ts"), join(SRC, "cli/run-cli.ts"), join(SRC, "cli/register/oss.ts"),
    ]);

    // The walk really reached the command registry.
    expect(modules).toBeGreaterThan(50);
    expect(packages.has("commander")).toBe(true);
    // zod is ~40 ms and ~95 modules; only `ix context --out/--save/--resume`
    // and the MCP server need it, and they load it themselves.
    expect(packages.has("zod")).toBe(false);
    expect(packages.has("@modelcontextprotocol/sdk")).toBe(false);
    expect([...packages].filter((p) => /core-ingestion|tree-sitter/.test(p))).toEqual([]);
  });

  it("loads zod on the first bundle validation, not on import", () => {
    const schema = join(SRC, "cli/context-bundle-schema.ts");
    const script = `
      const { createRequire } = await import("node:module");
      const req = createRequire(${JSON.stringify(schema)});
      const loaded = () => Object.keys(req.cache).some((k) => /[\\\\/]node_modules[\\\\/]zod[\\\\/]/.test(k));
      const m = await import(${JSON.stringify("file://" + schema)});
      const before = loaded();
      const bad = m.contextBundleSchema.safeParse({}).success;
      console.log(JSON.stringify({ before, after: loaded(), bad }));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: SRC, encoding: "utf-8",
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ before: false, after: true, bad: false });
  }, 30_000);
});
