// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { chooseCentre, pickStartingPoints, rankIssueFiles, type SymbolHit } from "../explain/issue.js";

const noise = Array.from({ length: 25 }, (_, i) => ({ path: `src/noise${i}.py`, score: 300 - i }));
const definition = (name: string, path: string, id = path): SymbolHit => ({ id, name, path, kind: "function" });
const rank = (starts: Parameters<typeof rankIssueFiles>[0]["starts"], path: string) =>
  rankIssueFiles({ starts, bm25: [...noise, { path, score: 1 }], near: new Map() });

describe("strong issue starts", () => {
  it.each([
    "src/briefcase/platforms/linux/flatpak.py",
    "src/a2a/client/transports/base.py",
    "kedro/__init__.py",
  ])("pins a uniquely resolved path ahead of high BM25 noise: %s", async (path) => {
    const { starts } = await pickStartingPoints(`The failure is in ${path}`, {
      files: [path, ...noise.map((h) => h.path)], search: async () => [],
    });
    const ranked = rank(starts, path);
    expect(ranked[0].path).toBe(path);
    expect(ranked[0].reason).toContain("starting point");
    expect(ranked).toHaveLength(20);
  });

  it.each(["EqualTo", "new_figure_manager"])("pins a prose definition: %s", async (name) => {
    const path = "src/expressions/__init__.py";
    const { starts } = await pickStartingPoints(`${name} fails on this input`, {
      files: [path], search: async (token) => token === name ? [definition(name, path)] : [],
    });
    // Full bundles resolve graph nodes before ranking; metadata must survive that copy.
    const located = await chooseCentre(starts, [], async () => undefined);
    expect(rank(located.starts, path)[0].path).toBe(path);
    expect(Object.keys(JSON.parse(JSON.stringify(starts[0]))).sort()).toEqual([
      "id", "kind", "name", "path", "token", "via",
    ]);
  });

  it.each([1, 3, 4])("counts distinct definition files for the frequency guard: %i", async (count) => {
    const paths = Array.from({ length: count }, (_, i) => `src/definition${i}.py`);
    const { starts } = await pickStartingPoints("renderValue fails", {
      files: paths,
      // Many overloads in one file should not trip the frequency guard.
      search: async () => paths.flatMap((path) => Array.from({ length: 5 }, (_, i) => definition("renderValue", path, `${path}:${i}`))),
    });
    const ranked = rankIssueFiles({
      starts, bm25: [{ path: noise[0].path, score: 300 }, { path: paths[0], score: 1 }], near: new Map(),
    });
    expect(ranked[0].path).toBe(count <= 3 ? paths[0] : noise[0].path);
    expect(ranked.find((r) => r.path === paths[0])?.score).toBe(31);
  });

  it("keeps a generic prose name under the capped boost even with one definition", async () => {
    const path = "src/model.py";
    const { starts } = await pickStartingPoints("`save` fails", {
      files: [path], search: async () => [definition("save", path)],
    });
    expect(rank(starts, path).map((r) => r.path)).not.toContain(path);
  });

  it("gives a snippet-only name neither precedence nor a boost", async () => {
    const path = "src/model.py";
    const { starts } = await pickStartingPoints("```python\nrenderValue()\n```", {
      files: [path], search: async () => [definition("renderValue", path)],
    });
    expect(starts[0].snippet).toBe(true);
    const ranked = rankIssueFiles({ starts, bm25: [{ path, score: 1 }, ...noise], near: new Map() }, 30);
    expect(ranked.at(-1)).toMatchObject({ path, score: 1 });
    expect(ranked.at(-1)?.reason).toContain("boost 0.00");
  });

  it("orders pinned paths before identifiers, then by BM25 rather than graph closeness", async () => {
    const paths = ["src/first.py", "src/second.py", "src/identifier.py"];
    const { starts } = await pickStartingPoints(`${paths[1]} and ${paths[0]} fail in renderValue`, {
      files: paths, search: async () => [definition("renderValue", paths[2])],
    });
    const ranked = rankIssueFiles({ starts, bm25: [
      ...noise, { path: paths[0], score: 2 }, { path: paths[1], score: 1.9 }, { path: paths[2], score: 200 },
    ], near: new Map([[paths[1], { weight: 1, reason: "one hop" }]]) });
    expect(ranked.slice(0, 4).map((r) => r.path)).toEqual([...paths, noise[0].path]);
  });

  it("reserves the innermost traceback frame without pinning it", async () => {
    const { starts } = await pickStartingPoints([
      "Traceback (most recent call last):", '  File "src/outer.py", line 1, in run',
      '  File "src/inner.py", line 2, in fail', "ValueError: broken",
    ].join("\n"), { files: ["src/outer.py", "src/inner.py"], search: async () => [] });
    expect(starts.map((s) => s.path)).toEqual(["src/inner.py"]);
    expect(rank(starts, "src/inner.py").at(-1)?.path).toBe("src/inner.py");
  });
});
