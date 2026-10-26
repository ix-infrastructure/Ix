// Copyright 2026 Ix Infrastructure Inc.

import * as path from "node:path";
import type { SourceFiles } from "./edge-sites.js";
import type { AroundRef } from "./around.js";

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

/** Naming evidence is file-level: it does not imply a call to any particular symbol. */
function namedFor(target: string, test: string): boolean {
  const ext = path.posix.extname(target);
  const base = path.posix.basename(target, ext);
  const mod = base === "__init__" || base === "index" ? path.posix.basename(path.posix.dirname(target)) : base;
  const name = path.posix.basename(test);
  if (ext === ".py" && test.endsWith(".py")) {
    return name === `test_${mod}.py` || name === `${mod}_test.py`
      || (/(^|\/)tests\//.test(test) && name.startsWith(`test_${mod}`));
  }
  if (!SCRIPT.test(target) || !SCRIPT.test(test)) return false;
  const stem = name.replace(SCRIPT, "");
  return stem === `${mod}.test` || stem === `${mod}.spec`
    || (/(^|\/)__tests__\//.test(test) && stem.startsWith(mod));
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
  return (module, importer) => {
    const dots = module.match(/^\.+/)?.[0].length ?? 0;
    const tail = module.slice(dots).replace(/\./g, "/");
    if (dots) {
      const base = path.posix.join(path.posix.dirname(importer), ...Array(dots - 1).fill(".."), tail);
      return at(base);
    }
    const exact = at(tail) ?? at(`src/${tail}`);
    if (exact) return exact;
    const candidates = modules.get(tail) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
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
  } else if (!path.posix.extname(base)) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
      candidates.push(base + ext, `${base}/index${ext}`);
    }
  }
  return candidates.find((p) => known.has(p));
}

/**
 * Match imports to the target file node's source path, rather than its basename.
 * The graph can omit an IMPORTS edge when Python imports name a package/module.
 * Scan only source test files; SourceFiles bounds and guards every disk read.
 */
export function heuristicTests(
  target: string, files: SourceFiles, isTest: (file: string) => boolean,
): AroundRef[] {
  if (!target.endsWith(".py") && !SCRIPT.test(target)) return [];
  const paths = files.sourcePaths();
  const known = new Set([...paths, target]);
  const resolvePython = pythonResolver([...known]);
  const rows: AroundRef[] = [];
  for (const file of paths) {
    if (file === target || !isTest(file)) continue;
    const python = target.endsWith(".py") && file.endsWith(".py");
    const script = SCRIPT.test(target) && SCRIPT.test(file);
    if (!python && !script) continue;
    const naming = namedFor(target, file);
    const lines = files.lines(file);
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
      } else if (script && !/^(?:\/\/|\/\*|\*)/.test(line)) {
        const re = /\bfrom\s*["']([^"']+)["']|\b(?:require|import)\s*\(\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/g;
        for (const match of line.matchAll(re)) {
          if (scriptImport(match[1] ?? match[2] ?? match[3], file, known) === target) imported = i + 1;
        }
      }
      if (imported !== undefined) break;
    }
    if (naming || imported !== undefined) rows.push({
      path: file, line: imported, snippet: imported !== undefined ? lines![imported - 1].trim() : undefined,
      sources: [...(imported !== undefined ? ["import" as const] : []), ...(naming ? ["naming" as const] : [])],
    });
  }
  return rows;
}
