// Copyright 2026 Ix Infrastructure Inc.

/**
 * A small repository as a model, rendered to Python, TypeScript and Java, and
 * the edits an incremental `ix map` has to survive.
 *
 * Shared by the fake-backend equivalence test (`ingest-equivalence.test.ts`)
 * and meant for the real-backend harness too, so both run the same scenarios.
 * Each file is a list of functions; each function returns a sum of calls and a
 * constant. That is enough to produce the edges that matter -- CONTAINS,
 * DEFINES, IMPORTS and same-file and cross-file CALLS -- and to change any of
 * them with a one-field edit.
 */

export type Lang = "py" | "ts" | "java";
export interface Call { path: string; name: string }
export interface Fn { name: string; value: number; calls: Call[] }
/** Workspace-relative path -> functions. A file's language is its extension. */
export type Repo = Map<string, Fn[]>;

export const langOf = (path: string): Lang =>
  path.endsWith(".py") ? "py" : path.endsWith(".ts") ? "ts" : "java";

const stem = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

/** Source text for one file. Imports are derived from the cross-file calls. */
export function render(path: string, fns: Fn[]): string {
  const callees = [...new Map(fns.flatMap((f) => f.calls).filter((c) => c.path !== path)
    .map((c) => [`${c.path}\0${c.name}`, c])).values()];
  const body = (f: Fn, call: (c: Call) => string): string => [...f.calls.map(call), String(f.value)].join(" + ");
  switch (langOf(path)) {
    case "py": {
      const imports = callees.map((c) => `from ${c.path.replace(/\.py$/, "").replace(/\//g, ".")} import ${c.name}\n`);
      const defs = fns.map((f) => `def ${f.name}():\n    return ${body(f, (c) => `${c.name}()`)}\n`);
      return [imports.join(""), ...defs].filter(Boolean).join("\n");
    }
    case "ts": {
      const imports = callees.map((c) => `import { ${c.name} } from './${stem(c.path)}';\n`);
      const defs = fns.map((f) => `export function ${f.name}(): number {\n  return ${body(f, (c) => `${c.name}()`)};\n}\n`);
      return [imports.join(""), ...defs].filter(Boolean).join("\n");
    }
    case "java": {
      // One package, so a cross-file call needs no import: `Util.helper()`.
      const call = (c: Call) => (c.path === path ? `${c.name}()` : `${stem(c.path)}.${c.name}()`);
      const defs = fns.map((f) => `  public static int ${f.name}() {\n    return ${body(f, call)};\n  }\n`);
      return `package com.ex;\n\npublic class ${stem(path)} {\n${defs.join("\n")}}\n`;
    }
  }
}

/**
 * Twelve files, four per language. In each language one file is called by the
 * other three (`util.py`, `math.ts`, `Util.java`) and one calls through a
 * second file (`app.py -> service.py -> util.py`).
 */
export function initialRepo(): Repo {
  const fn = (name: string, value: number, ...calls: Array<[string, string]>): Fn =>
    ({ name, value, calls: calls.map(([path, n]) => ({ path, name: n })) });
  return new Map<string, Fn[]>([
    ["pkg/util.py", [fn("helper", 1), fn("scale", 2, ["pkg/util.py", "helper"])]],
    ["pkg/service.py", [fn("run", 3, ["pkg/util.py", "helper"], ["pkg/util.py", "scale"])]],
    ["pkg/app.py", [fn("main", 4, ["pkg/service.py", "run"])]],
    ["pkg/models.py", [fn("make", 5, ["pkg/util.py", "helper"])]],
    ["web/math.ts", [fn("add", 1), fn("mul", 2, ["web/math.ts", "add"])]],
    ["web/calc.ts", [fn("total", 3, ["web/math.ts", "add"], ["web/math.ts", "mul"])]],
    ["web/main.ts", [fn("start", 4, ["web/calc.ts", "total"])]],
    ["web/report.ts", [fn("report", 5, ["web/math.ts", "add"])]],
    ["src/com/ex/Util.java", [fn("helper", 1), fn("twice", 2, ["src/com/ex/Util.java", "helper"])]],
    ["src/com/ex/Service.java", [fn("run", 3, ["src/com/ex/Util.java", "helper"])]],
    ["src/com/ex/App.java", [fn("main", 4, ["src/com/ex/Service.java", "run"])]],
    ["src/com/ex/Model.java", [fn("build", 5, ["src/com/ex/Util.java", "twice"])]],
  ]);
}

export const cloneRepo = (repo: Repo): Repo =>
  new Map([...repo].map(([p, fns]) => [p, fns.map((f) => ({ ...f, calls: f.calls.map((c) => ({ ...c })) }))]));

export const EDIT_KINDS = [
  "editBody", "addFunction", "removeFunction", "renameFunction", "addCall", "removeCall",
  "addFile", "deleteFile", "renameFile", "revert", "deleteThenRestore",
] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/**
 * One edit. `a` and `b` pick the file and the function, modulo what exists, so
 * any sequence of edits applies to any state. `path` overrides `a` for
 * hand-written scenarios.
 */
export interface Edit { kind: EditKind; a: number; b: number; path?: string }

let counter = 0;
const pick = <T>(xs: T[], i: number): T | undefined => (xs.length === 0 ? undefined : xs[i % xs.length]);

/**
 * Apply one edit. Returns the states to map, in order: one for most edits, two
 * for `deleteThenRestore`. `history` is every state mapped so far, which
 * `revert` picks from. `langs` limits which files an edit may touch.
 */
export function applyEdit(repo: Repo, edit: Edit, history: Repo[], langs?: Lang[]): Repo[] {
  const next = cloneRepo(repo);
  const allPaths = [...next.keys()].sort();
  const paths = langs ? allPaths.filter((p) => langs.includes(langOf(p))) : allPaths;
  const path = edit.path ?? pick(paths, edit.a);
  const fns = path === undefined ? [] : next.get(path) ?? [];
  const f = pick(fns, edit.b);
  const newPath = (lang: Lang, base: string) => {
    const n = ++counter;
    return lang === "py" ? `pkg/${base}${n}.py` : lang === "ts" ? `web/${base}${n}.ts`
      : `src/com/ex/${base[0]!.toUpperCase()}${base.slice(1)}${n}.java`;
  };
  switch (edit.kind) {
    case "editBody":
      if (f) f.value += 1;
      return [next];
    case "addFunction":
      if (path) fns.push({ name: `added${++counter}`, value: 7, calls: [] });
      return [next];
    case "removeFunction":
      if (f && fns.length > 1) fns.splice(fns.indexOf(f), 1);
      return [next];
    case "renameFunction":
      if (f) f.name = `renamed${++counter}`;
      return [next];
    case "addCall": {
      if (!f || !path) return [next];
      const others = allPaths.filter((p) => p !== path && langOf(p) === langOf(path));
      const target = pick(others, edit.a + edit.b);
      const callee = target === undefined ? undefined : pick(next.get(target)!, edit.b);
      if (target && callee && !f.calls.some((c) => c.path === target && c.name === callee.name)) {
        f.calls.push({ path: target, name: callee.name });
      }
      return [next];
    }
    case "removeCall":
      if (f && f.calls.length > 0) f.calls.splice(edit.b % f.calls.length, 1);
      return [next];
    case "addFile": {
      const choices = langs ?? (["py", "ts", "java"] as Lang[]);
      const lang = choices[edit.a % choices.length]!;
      const created = newPath(lang, "extra");
      const target = pick(allPaths.filter((p) => langOf(p) === lang), edit.b);
      const callee = target === undefined ? undefined : pick(next.get(target)!, 0);
      next.set(created, [{ name: `extra${counter}`, value: 1, calls: callee ? [{ path: target!, name: callee.name }] : [] }]);
      return [next];
    }
    case "deleteFile":
      if (path && allPaths.length > 1) next.delete(path);
      return [next];
    case "renameFile": {
      if (!path) return [next];
      const moved = newPath(langOf(path), "moved");
      next.set(moved, next.get(path)!);
      next.delete(path);
      // Callers follow the move, as an IDE refactor would.
      for (const g of [...next.values()].flat()) for (const c of g.calls) if (c.path === path) c.path = moved;
      return [next];
    }
    case "revert":
      return [cloneRepo(pick(history, edit.a) ?? repo)];
    case "deleteThenRestore": {
      if (!path || allPaths.length < 2) return [next];
      const without = cloneRepo(next);
      without.delete(path);
      return [without, next];
    }
  }
}
