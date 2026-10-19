// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateSet, ALL_CANDIDATES_MAX } from "../resolve.js";
import { runPerTarget } from "../multi-target.js";
import { printJson } from "../format.js";

describe("--all candidate set", () => {
  const c = (id: string, score?: number) => ({ id, name: "clamp", kind: "function", path: `${id}.py`, ...(score !== undefined ? { score } : {}) });

  it("answers only the best score tier: a near-miss listed beside the ties is not a definition", () => {
    const set = candidateSet([c("utils", 10), c("math", 10), c("pricing", 14)]);
    expect(set.entities.map((e) => e.id)).toEqual(["utils", "math"]);
    expect(set.all).toEqual({ total: 2 });
  });

  it("caps the answers and marks the set truncated when more ties exist", () => {
    const set = candidateSet(Array.from({ length: 12 }, (_, i) => c(`t${i}`, 5)));
    expect(set.entities).toHaveLength(ALL_CANDIDATES_MAX);
    expect(set.all).toEqual({ total: 12, truncated: true });
  });

  it("keeps every listed candidate when the candidates carry no scores", () => {
    const set = candidateSet([c("a"), c("b"), c("c")], 3);
    expect(set.entities.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("several targets: a real error on one keeps the others' answers", () => {
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it("json: the failed target is an error record with exit 1; the answered one is intact", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { out.push(String(line)); });
    await runPerTarget(["a", "b"], "json", async (target) => {
      if (target === "b") throw new Error("503: backend unavailable");
      printJson({ resolvedTarget: { name: target } });
    });
    const body = JSON.parse(out.join("\n"));
    expect(body.targets[0]).toMatchObject({ target: "a", exitCode: 0, resolvedTarget: { name: "a" } });
    expect(body.targets[1]).toMatchObject({ target: "b", exitCode: 1, error: "error" });
    expect(body.targets[1].message).toMatch(/backend unavailable/);
    expect(process.exitCode).toBe(1);
  });

  it("llm: an error record for the failed target, then the summary", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { out.push(String(line)); });
    await runPerTarget(["a", "b"], "llm", async (target) => {
      if (target === "a") throw new Error("boom");
      console.log(`entity name=${target}`);
    });
    expect(out.some((l) => /^error code=error /.test(l))).toBe(true);
    expect(out).toContain("entity name=b");
    expect(out.at(-1)).toMatch(/^targets total=2 ok=1 .*failed=1/);
  });
});
