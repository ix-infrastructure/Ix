// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { baseScore, hasDefinitionOf, originPenalty, scoreCandidate } from "../resolve/score.js";
import {
  AMBIGUOUS_HINT, allCandidatesOf, applyPick, pickBest, pickFromNotice, roundRobinByFile,
} from "../resolve/pick.js";
import type { ResolveResult } from "../resolve/types.js";
import * as barrel from "../resolve.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every module a file loads at runtime, following static `import` and
 * `export … from` edges. Type-only imports are erased by tsc, so they do not
 * count (the same rule as startup-imports.test.ts).
 */
function runtimeModules(entry: string): string[] {
  const edge = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf-8").matchAll(edge)) {
      const spec = match[1];
      if (!spec.startsWith(".")) {
        seen.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) queue.push(target);
      else seen.add(target);
    }
  }
  return [...seen];
}

describe("resolve/score.ts and resolve/pick.ts are pure", () => {
  for (const name of ["score", "pick"]) {
    const entry = resolve(CLI, "resolve", `${name}.ts`);

    it(`${name}.ts loads no client, no process and no output module`, () => {
      const modules = runtimeModules(entry);
      const offenders = modules.filter((m) =>
        m.includes(`${"/"}client${"/"}`)
        || m === "node:process" || m === "process"
        || /[\\/](stderr|ui|bootstrap|config|system)\.ts$/.test(m));
      expect(offenders).toEqual([]);
      // Nothing it loads reads the environment or writes anywhere.
      for (const m of modules.filter((f) => f.endsWith(".ts"))) {
        const text = readFileSync(m, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(text, m).not.toMatch(/\bprocess\s*\.|\bconsole\s*\.|\bstderr\s*\(|\bstdout\b/);
      }
    });
  }
});

const node = (id: string, name: string, kind: string, path: string, line = 1) => ({
  id, name, kind, provenance: { sourceUri: path }, attrs: { line_start: line },
});

describe("scoring without a client", () => {
  it("ranks an exact definition ahead of an import and a prefix match", () => {
    const cls = node("c", "Parser", "class", "src/parser.ts");
    const imp = node("i", "Parser", "module", "src/main.ts");
    const prefix = node("p", "ParserOptions", "interface", "src/options.ts");
    const scores = [cls, imp, prefix].map((n) => scoreCandidate(n, "Parser"));
    expect(scores[0]).toBeLessThan(scores[1]);
    expect(scores[1]).toBeLessThan(scores[2]);
    expect(originPenalty(imp, "Parser")).toBe(scoreCandidate(imp, "Parser") - baseScore(imp, "Parser"));
  });

  it("hasDefinitionOf ignores structural nodes that only carry the name", () => {
    expect(hasDefinitionOf([node("f", "load", "function", "src/a.ts")], "load")).toBe(true);
    expect(hasDefinitionOf([node("d", "load", "directory", "ix:map/load")], "load")).toBe(false);
  });
});

const ambiguous = (): ResolveResult => ({
  resolved: false,
  ambiguous: true,
  result: {
    resolutionMode: "ambiguous",
    candidates: [{ id: "a", name: "run", kind: "function" }, { id: "b", name: "run", kind: "function" }],
  },
});

describe("picking without a client", () => {
  it("pickBest resolves a clear winner", () => {
    const r = pickBest(
      [node("c", "Parser", "class", "src/parser.ts"), node("p", "ParserOptions", "interface", "src/o.ts")],
      "Parser", [], { hint: AMBIGUOUS_HINT },
    );
    expect(r).toMatchObject({ resolved: true, entity: { id: "c", resolutionMode: "exact" } });
  });

  it("pickBest reports a genuine tie with the hint it was given", () => {
    const r = pickBest(
      [node("b", "run", "function", "src/b.ts"), node("a", "run", "function", "src/a.ts")],
      "run", [], { hint: "HINT" },
    );
    expect(r?.resolved).toBe(false);
    if (r && !r.resolved && r.ambiguous) {
      // Ties break by (path, line, id), never by the order the backend sent.
      expect(r.result.candidates.map((c) => c.id)).toEqual(["a", "b"]);
      expect(r.result.diagnostics?.[0]).toEqual({ code: "ambiguous_resolution", message: "HINT" });
      expect(allCandidatesOf(r.result).map((c) => c.id)).toEqual(["a", "b"]);
    }
  });

  it("roundRobinByFile deals one per file per round", () => {
    const ranked = [node("1", "x", "function", "a.ts"), node("2", "x", "function", "a.ts"), node("3", "x", "function", "b.ts")];
    expect(roundRobinByFile(ranked).map((n) => n.id)).toEqual(["1", "3", "2"]);
  });

  it("an out-of-range --pick is handed to the caller, never printed", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const said: string[] = [];
      const r = applyPick(ambiguous(), { pick: 5 }, (m) => said.push(m));
      expect(said).toEqual(["--pick 5 is out of range (1-2)."]);
      expect(r && !r.resolved && r.ambiguous && r.result.diagnostics?.[0].code).toBe("pick_out_of_range");
      expect(applyPick(ambiguous(), { pick: 5 })).not.toBeNull();

      const resolved: ResolveResult = {
        resolved: true,
        entity: { id: "a", name: "run", kind: "function", resolutionMode: "scored" },
        notices: [{
          code: "ambiguous_target", target: "run", message: "", total: 2,
          chosen: { id: "a", name: "run", kind: "function" },
          candidates: [{ id: "a", name: "run", kind: "function" }, { id: "b", name: "run", kind: "function" }],
        }],
      };
      const kept = pickFromNotice(resolved, { pick: 9 });
      expect(kept.resolved && kept.entity.id).toBe("a");
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});

describe("resolve.ts stays the import path", () => {
  it("re-exports the moved scoring and picking functions", () => {
    expect(barrel.scoreCandidate).toBe(scoreCandidate);
    expect(barrel.baseScore).toBe(baseScore);
    expect(barrel.originPenalty).toBe(originPenalty);
    expect(barrel.hasDefinitionOf).toBe(hasDefinitionOf);
    expect(barrel.roundRobinByFile).toBe(roundRobinByFile);
    expect(barrel.allCandidatesOf).toBe(allCandidatesOf);
  });

  it("its applyPick still says an out-of-range --pick on stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      barrel.applyPick(ambiguous(), { pick: 3 });
      expect(write).toHaveBeenCalledWith("--pick 3 is out of range (1-2).\n");
    } finally {
      write.mockRestore();
    }
  });
});
