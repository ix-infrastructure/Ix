// Copyright 2026 Ix Infrastructure Inc.

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { SupportedLanguages } from './languages.js';

/**
 * Everything `resolveEdges` needs to know about a file when it is the TARGET
 * of a resolution rather than the file being resolved: what it defines, what
 * it exports, what it imports. Small enough to keep for a whole repository, so
 * a batch of changed files can be resolved against all the others without
 * parsing them (IN-09), and later persisted beside the ingest baseline (IN-10).
 *
 * Built by `summarizeParseResult` in `index.ts`. A batch file's summary and the
 * one in the index for the same content are identical, which is what makes
 * resolution independent of how the files are batched.
 */
export interface FileSummary {
  filePath: string;
  language: SupportedLanguages;
  /** Entities, file node included -- only the count is used (Go package anchors). */
  entityCount: number;
  /** `[name, qualifiedKey]` per entity other than the file and module nodes, in source order. */
  qkeys: Array<[string, string]>;
  /**
   * `[public, local]` export names (JS/TS), when the file has any. A renaming
   * re-export adds the module specifier it names: `[public, local, source]`.
   */
  exportPublicNames?: Array<[string, string, string?]>;
  /** The file's IMPORTS relationships, as the import resolver reads them. */
  imports: Array<{ dstName: string; importRaw?: string; importVia?: string; importAliased?: boolean }>;
  /** `[fqcn, typeName]` for unambiguous PHP types. */
  phpTypes?: Array<[string, string]>;
  /** Receiver inference facts needed across incremental batches. */
  receiverFactories?: Array<[string, string]>;
  receiverHeritage?: Array<[string, string]>;
  receiverPackage?: string;
  importAliases?: Record<string, string>;
  /** TypeScript: the type names this file puts in the global scope. */
  tsGlobalTypes?: string[];
  /** TypeScript: the file is a module, so only its tsGlobalTypes are globals. Absent in older summaries. */
  tsModule?: true;
  /** Sorted unique names this file calls, references or extends (for IN-11). */
  refs: string[];
  /** Hash of what other files can resolve to here (`summarySignature`). */
  sig: string;
}

/** The fields of a summary other files bind to: what `summaryBindings` reads. */
type BindingFields = Pick<FileSummary,
  'language' | 'qkeys' | 'exportPublicNames' | 'imports' | 'phpTypes' | 'receiverFactories' |
  'receiverHeritage' | 'receiverPackage' | 'importAliases' | 'tsGlobalTypes'>;

/**
 * A summary as the dependents functions read it. One read back from the CLI's
 * symbol table is JSON from disk, so any field may be missing; every read
 * treats a missing field as empty.
 */
export type StoredFileSummary = Partial<FileSummary>;

/**
 * What other files can bind to in a summary, as `key -> names`: one key per
 * entity name and qualified key, per export pair, PHP type, receiver factory,
 * receiver heritage, namespace export and TypeScript global. The key carries
 * what the name resolves to, so `export { a as foo }` becoming
 * `export { b as foo }` changes a key although no name came or went. The
 * names are what a file referring to that binding names; every key has at
 * least one.
 *
 * This is the one definition of "what other files depend on":
 * `summarySignature` hashes these keys and `changedNames` diffs them, so the
 * signature changes exactly when some name's binding does.
 */
export function summaryBindings(s: Partial<BindingFields> | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!s) return out;
  const pkg = s.receiverPackage ?? '';
  for (const [name, qkey] of s.qkeys ?? []) out.set(`q\0${pkg}\0${name}\0${qkey}`, [name, qkey]);
  for (const [publicName, local, source] of s.exportPublicNames ?? []) {
    out.set(source === undefined ? `e\0${publicName}\0${local}` : `e\0${publicName}\0${local}\0${source}`, [publicName]);
  }
  for (const [fqcn, typeName] of s.phpTypes ?? []) out.set(`p\0${fqcn}\0${typeName}`, [fqcn, typeName]);
  // A factory's return type resolves through this file's imports (and Go
  // import aliases), a superclass through its imports: both are in the key.
  // A Java method result (`URL.getUrl`) types a chained call, which names the
  // method only (`x.getUrl().m()`): the method name counts too.
  if (s.receiverFactories?.length) {
    const imports = heritageImportsKey(s.imports, s.importAliases);
    for (const [name, type] of s.receiverFactories) out.set(`f\0${pkg}\0${name}\0${type}\0${imports}`, javaMember(s, name));
  }
  if (s.receiverHeritage?.length) {
    const imports = heritageImportsKey(s.imports);
    for (const [name, base] of s.receiverHeritage) out.set(`h\0${pkg}\0${name}\0${base}\0${imports}`, [name]);
  }
  // JS/TS `export * as ns from './a'` (key `export:ns`): what an importer's
  // `import { ns }` resolves `ns.Base` through. A file's own namespace import
  // is not something an importer binds to.
  for (const [key, spec] of Object.entries(s.importAliases ?? {})) {
    if (key.startsWith('export:')) out.set(`n\0${key}\0${spec}`, [key.slice('export:'.length)]);
  }
  // TypeScript globals an unimported heritage base may name.
  for (const name of s.tsGlobalTypes ?? []) out.set(`g\0${name}`, [name]);
  return out;
}

/** `[Class.method, method]` for a Java method result, else `[name]`. */
function javaMember(s: Partial<BindingFields>, name: string): string[] {
  const dot = name.lastIndexOf('.');
  return s.language === SupportedLanguages.Java && dot > 0 ? [name, name.slice(dot + 1)] : [name];
}

/** The part of a summary other files depend on, hashed: the keys of `summaryBindings`. */
export function summarySignature(s: StoredFileSummary): string {
  const canonical = JSON.stringify([...summaryBindings(s).keys()].sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * The imports a Scala superclass or a factory's return type resolves through,
 * as one key. Any import can pick the type (wildcards included), so all of
 * them count, and so do Go import aliases when given.
 */
export function heritageImportsKey(imports: Array<{ dstName: string }> | undefined, aliases?: Record<string, string>): string {
  const key = [...new Set((imports ?? []).map(i => i.dstName))].sort().join('\0');
  const named = Object.entries(aliases ?? {}).map(([a, m]) => `${a}=${m}`).sort().join('\0');
  return named ? `${key}\0\0${named}` : key;
}

// ── Dependents (IN-11) ──────────────────────────────────────────────────
// A file that did not change can still need re-resolving: a call it makes may
// now resolve somewhere else, or nowhere, because a name it uses was added,
// renamed or removed in another file. Summaries say what every file defines
// and refers to, so the caller can find those files without reading the rest.

/** The names other files can resolve to in a summary. */
export function definedNames(summary: StoredFileSummary | undefined): Set<string> {
  const names = new Set<string>();
  if (!summary) return names;
  for (const [name, qkey] of summary.qkeys ?? []) { names.add(name); names.add(qkey); }
  for (const [publicName] of summary.exportPublicNames ?? []) names.add(publicName);
  for (const [fqcn, typeName] of summary.phpTypes ?? []) { names.add(fqcn); names.add(typeName); }
  return names;
}

/**
 * Names whose binding differs before and after (`summaryBindings`): defined in
 * one but not the other, or now pointing at something else. None when the
 * signature is the same, which is a hash of the same bindings, so a signature
 * that changed always names something.
 */
export function changedNames(before: StoredFileSummary | undefined, after: StoredFileSummary | undefined): Set<string> {
  if (before?.sig !== undefined && before.sig === after?.sig) return new Set();
  const was = summaryBindings(before);
  const now = summaryBindings(after);
  const out = new Set<string>();
  for (const [key, names] of was) if (!now.has(key)) for (const n of names) out.add(n);
  for (const [key, names] of now) if (!was.has(key)) for (const n of names) out.add(n);
  return out;
}

/**
 * Whether a file's imports differ before and after. A file that re-exports
 * (`export { foo } from './x'`, a Python `__init__`) passes names through its
 * imports, which its signature does not cover: when they change, files that
 * import it may resolve differently, so it counts as a path that changed.
 */
export function importsChanged(before: StoredFileSummary | undefined, after: StoredFileSummary | undefined): boolean {
  if (!before || !after) return false;
  const key = (s: StoredFileSummary) =>
    JSON.stringify((s.imports ?? [])
      // An aliased Python import resolves by full path only, so adding or
      // dropping `as m` changes what it names. Unaliased keys stay as they were.
      .map(i => `${i.dstName ?? ''}\0${i.importRaw ?? ''}${i.importAliased ? '\0aliased' : ''}`).sort());
  return key(before) !== key(after);
}

/** The stem an import of `relPath` would name: `math` for `web/math.ts`, `web` for `web/index.ts`. */
function importStem(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/');
  const stem = path.posix.basename(posix).replace(/\.[^.]+$/, '');
  if (stem === 'index' || stem === '__init__' || stem === 'mod') return path.posix.basename(path.posix.dirname(posix));
  return stem;
}

const REF_SEPARATOR = /::|->|[.#\\]/;

/** The segments of an import specifier: `./math.js` -> `math`, `js`; `pkg.util` -> `pkg`, `util`. */
function importSegments(spec: string): string[] {
  return spec.split(/[/\\.:]+/).filter(Boolean);
}

/**
 * Files in `table` that may resolve differently now: a name they refer to is in
 * `names` (also by its first or last segment, for `obj.method` and `Mod::f`), or
 * an import of theirs names the stem of a path in `paths` (a file that appeared,
 * went away, or changed what it imports), or it is a Python file with imports
 * below the directory of a `__init__.py` in `packageEntries` (one that appeared
 * or went away). Files in `exclude` -- the ones the caller already re-resolved
 * -- are left out. Over-matching costs a parse; the caller decides from the
 * new resolution whether anything changed.
 */
export function findDependents(
  table: ReadonlyMap<string, { summary: StoredFileSummary }>,
  names: ReadonlySet<string>,
  paths: Iterable<string>,
  exclude: ReadonlySet<string>,
  packageEntries: Iterable<string> = [],
): string[] {
  const stems = new Set<string>();
  for (const p of paths) {
    const stem = importStem(p);
    if (stem.length > 0 && stem !== '.') stems.add(stem);
  }
  // A `__init__.py` that came or went turns its directory into a package, or
  // back into a plain folder. That changes what imports inside it can bind
  // (`import helpers as h` in `tools/main.py` names `tools/helpers.py` only
  // while `tools/` is not a package), whatever the import's name, so every
  // Python file below it that imports anything is re-resolved.
  const packageDirs: string[] = [];
  for (const p of packageEntries) {
    const posix = p.replace(/\\/g, '/');
    if (path.posix.basename(posix) !== '__init__.py') continue;
    const dir = path.posix.dirname(posix);
    packageDirs.push(dir === '.' ? '' : `${dir}/`);
  }
  if (names.size === 0 && stems.size === 0 && packageDirs.length === 0) return [];
  // A changed superclass changes the members visible through every subclass,
  // even when those subclass files were not edited (or were already sent).
  // Likewise a changed type changes what every factory returning it gives a
  // caller's receiver (a Scala `apply`, a Go `NewX`, a Java method result), so
  // the factory counts too.
  const inheritors = new Map<string, Set<string>>();
  const dependsOn = (type: string, name: string) => {
    for (const key of new Set([type, type.split('.').pop()!])) {
      const children = inheritors.get(key) ?? new Set<string>();
      children.add(name);
      inheritors.set(key, children);
    }
  };
  for (const { summary: s } of table.values()) {
    for (const [child, parent] of s.receiverHeritage ?? []) {
      dependsOn(parent, child);
      if (s.receiverPackage) dependsOn(parent, `${s.receiverPackage}.${child}`);
    }
    for (const [factory, type] of s.receiverFactories ?? []) if (type) for (const name of javaMember(s, factory)) dependsOn(type, name);
  }
  const affectedNames = new Set(names);
  const pending = [...affectedNames];
  for (let i = 0; i < pending.length; i++) {
    for (const child of inheritors.get(pending[i]) ?? []) {
      if (affectedNames.has(child)) continue;
      affectedNames.add(child);
      pending.push(child);
    }
  }
  const out: string[] = [];
  for (const [rel, { summary: s }] of table) {
    if (exclude.has(rel)) continue;
    const byName = affectedNames.size > 0 && (s.refs ?? []).some(ref => {
      if (affectedNames.has(ref)) return true;
      // Most refs are plain names; splitting each costs more than the rest of the scan.
      if (!REF_SEPARATOR.test(ref)) return false;
      const parts = ref.split(/::|->|\.|#|\\/).filter(Boolean);
      return parts.length > 1 && (affectedNames.has(parts[0]) || affectedNames.has(parts[parts.length - 1]));
    });
    // By path segment, not substring: an added `a.ts` must not match every
    // import with an "a" in it.
    const byImport = !byName && stems.size > 0 && (s.imports ?? []).some(imp => {
      const spec = imp.importRaw ?? imp.dstName ?? '';
      for (const stem of stems) {
        if (spec.includes(stem) && importSegments(spec).includes(stem)) return true;
      }
      return false;
    });
    const byPackage = !byName && !byImport && packageDirs.length > 0 && s.language === SupportedLanguages.Python &&
      (s.imports ?? []).length > 0 && packageDirs.some(dir => rel.replace(/\\/g, '/').startsWith(dir));
    if (byName || byImport || byPackage) out.push(rel);
  }
  return out.sort();
}
