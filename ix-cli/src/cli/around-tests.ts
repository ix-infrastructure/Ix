// Copyright 2026 Ix Infrastructure Inc.

import * as path from "node:path";
import type { SourceFiles } from "./edge-sites.js";
import type { AroundRef } from "./around.js";

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
/**
 * Test files read for import evidence per call, nearest the target first. A
 * monorepo can hold thousands of test files; naming evidence needs no read.
 */
const MAX_TEST_READS = 400;
const TEST_DIR = /^(?:tests?|__tests__|specs?)$/;

/**
 * Where a test lives in the source tree: its directory above the first test
 * directory (`packages/a/tests/unit/x.py` -> `packages/a`), else its own.
 */
function testAnchor(test: string): string {
  const dirs = path.posix.dirname(test).split("/").filter((d) => d !== ".");
  const at = dirs.findIndex((d) => TEST_DIR.test(d));
  return (at < 0 ? dirs : dirs.slice(0, at)).join("/");
}

/** A test can only be named for a file in its own part of the tree, not a same-named file in another package. */
function inScope(target: string, test: string): boolean {
  const anchor = testAnchor(test);
  const dir = path.posix.dirname(target);
  return anchor === "" || dir === anchor || dir.startsWith(anchor + "/");
}

/** The module name a test is named for: a package initializer or index takes its directory's. */
function moduleName(file: string): string {
  const base = path.posix.basename(file, path.posix.extname(file));
  return base === "__init__" || base === "index" ? path.posix.basename(path.posix.dirname(file)) : base;
}

/**
 * Naming evidence is file-level: it does not imply a call to any particular
 * symbol. `rivals` are the other non-test files with the target's module name:
 * a test is named for the target only if no rival in its scope is as near to
 * it, so a root `tests/test_utils.py` names no `utils.py` in a monorepo with two.
 */
function namedFor(
  target: string, test: string, rivals: string[], near: (from: string, to: string) => number,
): boolean {
  if (!inScope(target, test)) return false;
  const distance = near(test, target);
  if (rivals.some((r) => inScope(r, test) && near(test, r) <= distance)) return false;
  const ext = path.posix.extname(target);
  const mod = moduleName(target);
  const name = path.posix.basename(test);
  // A longer name must continue past a separator: `a` is not named by `api`.
  const continues = (stem: string, prefix: string) =>
    stem === prefix || (stem.startsWith(prefix) && /^[._-]/.test(stem.slice(prefix.length)));
  if (ext === ".py" && test.endsWith(".py")) {
    return name === `test_${mod}.py` || name === `${mod}_test.py`
      || (/(^|\/)tests\//.test(test) && continues(name.replace(/\.py$/, ""), `test_${mod}`));
  }
  if (!SCRIPT.test(target) || !SCRIPT.test(test)) return false;
  const stem = name.replace(SCRIPT, "");
  return stem === `${mod}.test` || stem === `${mod}.spec`
    || (/(^|\/)__tests__\//.test(test) && continues(stem, mod));
}

/** Resolve only local Python modules. Ambiguous package-root suffixes are not evidence. */
function pythonResolver(paths: string[]): (module: string, importer: string) => string | undefined {
  const modules = new Map<string, string[]>();
  for (const file of paths) {
    if (!file.endsWith(".py")) continue;
    const module = file.replace(/\.py$/, "").replace(/\/__init__$/, "");
    const parts = module.split("/");
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join("/");
      modules.set(key, [...(modules.get(key) ?? []), file]);
    }
  }
  const known = new Set(paths);
  const at = (base: string) => [base + ".py", base + "/__init__.py"].find((p) => known.has(p));
  // A suffix match stands for `module` only if its implied sys.path entry is
  // not itself inside a package and the name is dotted: `import json` is the
  // standard library (or a site package), not some `app/json.py`.
  const rootOf = (file: string, tail: string) =>
    file.replace(/\.py$/, "").replace(/\/__init__$/, "").slice(0, -tail.length).replace(/\/$/, "");
  return (module, importer) => {
    const dots = module.match(/^\.+/)?.[0].length ?? 0;
    const tail = module.slice(dots).replace(/\./g, "/");
    if (dots) {
      const base = path.posix.join(path.posix.dirname(importer), ...Array(dots - 1).fill(".."), tail);
      return at(base);
    }
    const exact = at(tail) ?? at(`src/${tail}`);
    if (exact) return exact;
    if (!tail.includes("/")) return undefined;
    const candidates = modules.get(tail) ?? [];
    if (candidates.length !== 1) return undefined;
    const root = rootOf(candidates[0], tail);
    return root && known.has(`${root}/__init__.py`) ? undefined : candidates[0];
  };
}

function scriptImport(spec: string, importer: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
  const candidates = [base];
  // NodeNext code spells .js while the source file is .ts/.tsx.
  if (/\.[cm]?jsx?$/.test(base)) {
    const stem = base.replace(/\.[cm]?jsx?$/, "");
    const extensions = base.endsWith(".mjs") ? [".mts"] : base.endsWith(".cjs") ? [".cts"] : [".ts", ".tsx"];
    candidates.push(...extensions.map((ext) => stem + ext));
  } else if (!SCRIPT.test(base)) {
    // Extensionless, including dotted basenames: `./foo.service` is foo.service.ts.
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
      candidates.push(base + ext, `${base}/index${ext}`);
    }
  }
  return candidates.find((p) => known.has(p));
}

/**
 * Match imports to the target file node's source path, rather than its basename.
 * The graph can omit an IMPORTS edge when Python imports name a package/module.
 * Scan only source test files, at most {@link MAX_TEST_READS} of them, nearest
 * `target` first (`near(from, to)`: smaller is nearer); SourceFiles bounds and
 * guards every disk read.
 */
export function heuristicTests(
  target: string, files: SourceFiles, isTest: (file: string) => boolean, near: (from: string, to: string) => number,
): AroundRef[] {
  if (!target.endsWith(".py") && !SCRIPT.test(target)) return [];
  const paths = files.sourcePaths();
  const known = new Set([...paths, target]);
  const resolvePython = pythonResolver([...known]);
  const python = target.endsWith(".py");
  const sameLanguage = (file: string) => python ? file.endsWith(".py") : SCRIPT.test(file);
  const mod = moduleName(target);
  const rivals = paths.filter((file) => file !== target && sameLanguage(file) && !isTest(file) && moduleName(file) === mod);
  const tests = paths
    .filter((file) => file !== target && isTest(file) && sameLanguage(file))
    .map((file) => ({ file, near: near(target, file) }))
    .sort((a, b) => a.near - b.near || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const rows: AroundRef[] = [];
  let reads = 0;
  for (const { file } of tests) {
    const naming = namedFor(target, file, rivals, near);
    const lines = reads++ < MAX_TEST_READS ? files.lines(file) : null;
    let imported: number | undefined;
    for (let i = 0; lines && i < lines.length; i++) {
      const line = lines[i].trim();
      if (python) {
        if (!/^(?:from\s|import\s)/.test(line)) continue;
        let statement = line.replace(/#.*$/, "");
        // Parenthesized and backslash-continued import lists.
        let end = i;
        while ((statement.includes("(") && !statement.includes(")") || /\\\s*$/.test(statement))
          && end + 1 < lines.length && end - i < 40) {
          statement = statement.replace(/\\\s*$/, "") + " " + lines[++end].replace(/#.*$/, "").trim();
        }
        const from = statement.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
        const imports = from ? from[2] : statement.replace(/^import\s+/, "");
        const modules = imports.replace(/[()]/g, "").split(",").map((item) => item.trim().split(/\s+as\s+/)[0]);
        const specs = from ? [from[1], ...modules.filter((m) => /^\w+$/.test(m)).map((m) =>
          `${from[1]}${from[1].endsWith(".") ? "" : "."}${m}`)] : modules;
        if (specs.some((spec) => resolvePython(spec, file) === target)) imported = i + 1;
        i = end;
      } else if (!/^(?:\/\/|\/\*|\*)/.test(line)) {
        const re = /\bfrom\s*["']([^"']+)["']|\b(?:require|import)\s*\(\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/g;
        for (const match of line.matchAll(re)) {
          if (scriptImport(match[1] ?? match[2] ?? match[3], file, known) === target) imported = i + 1;
        }
      }
      if (imported !== undefined) break;
    }
    // Unread (past the cap, or unreadable): naming alone needs the file to be
    // there, since an unverified git listing still holds deleted tracked files.
    if (imported === undefined && (!naming || (!lines && !files.exists(file)))) continue;
    rows.push({
      path: file, line: imported, snippet: imported !== undefined ? lines![imported - 1].trim() : undefined,
      sources: [...(imported !== undefined ? ["import" as const] : []), ...(naming ? ["naming" as const] : [])],
    });
  }
  return rows;
}
