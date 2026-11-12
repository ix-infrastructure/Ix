// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (file: string) => relative(SRC, file).split("\\").join("/");

/**
 * The relative modules a file imports: static `import`/`export ... from`
 * edges (type-only ones are erased by tsc, so they do not count) and, when
 * `dynamic` is set, `import("...")` as well.
 */
function edges(file: string, dynamic: boolean): string[] {
  const text = readFileSync(file, "utf-8");
  const specs: string[] = [];
  const staticEdge = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of text.matchAll(staticEdge)) specs.push(m[1]);
  if (dynamic) for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs
    .filter((s) => s.startsWith("."))
    .map((s) => resolve(dirname(file), s.replace(/\.js$/, ".ts")))
    .filter((t) => existsSync(t));
}

/** Every module reachable from `entries`, entries included. */
function closure(entries: string[], dynamic: boolean): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...edges(file, dynamic));
  }
  return seen;
}

const clientModules = readdirSync(join(SRC, "client"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => join(SRC, "client", f));

describe("cli/config.ts split (#943)", () => {
  it("client/ imports from cli/ only the endpoint and connection modules", () => {
    const direct = new Set<string>();
    for (const file of clientModules) {
      for (const target of edges(file, true)) {
        if (rel(target).startsWith("cli/")) direct.add(rel(target));
      }
    }
    expect([...direct].sort()).toEqual(["cli/connection.ts", "cli/endpoint.ts"]);
  });

  it("the client package never loads cli/config.ts, workspace selection or the read guard", () => {
    const reached = [...closure(clientModules, true)].map(rel).filter((f) => f.startsWith("cli/"));
    expect(reached).not.toContain("cli/config.ts");
    expect(reached).not.toContain("cli/workspace.ts");
    expect(reached).not.toContain("cli/read-guard.ts");
    expect(reached).not.toContain("cli/state-paths.ts");
  });

  it("no import cycle runs through cli/config.ts or client/factory.ts, dynamic imports included", () => {
    for (const start of ["cli/config.ts", "client/factory.ts"]) {
      const file = join(SRC, start);
      const fromIt = closure(edges(file, true), true);
      expect(fromIt.has(file), `${start} reaches itself`).toBe(false);
    }
  });

  it("config.ts only re-exports", () => {
    const code = readFileSync(join(SRC, "cli/config.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s).toMatch(/^export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+"\.\/[\w-]+\.js"$/);
  });

  it("every runtime export config.js had still resolves, and getActiveWorkspaceRoot is gone", async () => {
    const config = await import("../config.js");
    expect(Object.keys(config).sort()).toEqual([
      "ConfigLockError", "ConfigParseError", "DEFAULT_ENDPOINT", "absoluteFromSourceUri",
      "canonicalWorkspacePath", "clearIngestMtimeCache", "clearLocalToken", "clearMapBaseline",
      "clearMapResultCache", "clearStitchScopeCache", "createClient", "ensureLocalToken",
      "findWorkspaceForCwd", "getDefaultWorkspace", "getEndpoint", "getLocalToken", "gitRootFor",
      "ingestMtimeCachePath", "ingestOrphanSweepPath", "ingestRebuildPath", "ingestSymbolsJournalPath",
      "ingestSymbolsPath", "isLinkedWorktreeRoot", "isPathInside", "isPathInsideResolvedRoot",
      "isReadablePath", "loadConfig", "loadWorkspaces", "mapBaselinePath", "mapRefreshOutcomePath",
      "mapResultCachePath", "mapStalePath", "readConfiguredFormat", "readStitchScope", "readableRoots",
      "resetConfigMemo", "resetMalformedPruneWarningsForTests", "resolveWorkspaceRoot", "saveConfig",
      "selectWorkspaceForCwd", "stitchScopeCachePath", "storedLocalToken", "updateConfig",
      "verifyRecordPath", "withConfigWriteLock", "writeStitchScope", "WORKSPACE_STATE_FILES",
    ].sort());
    expect("getActiveWorkspaceRoot" in config).toBe(false);
  });
});
