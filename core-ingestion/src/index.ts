import * as nodePath from 'node:path';
// @ts-ignore — tree-sitter has no bundled types
import Parser from 'tree-sitter';
// @ts-ignore
import JavaScript from 'tree-sitter-javascript';
// @ts-ignore
import TypeScript from 'tree-sitter-typescript';
// @ts-ignore
import Python from 'tree-sitter-python';
// @ts-ignore
import Java from 'tree-sitter-java';
// @ts-ignore
import C from 'tree-sitter-c';
// @ts-ignore
import CPP from 'tree-sitter-cpp';
// @ts-ignore
import CSharp from 'tree-sitter-c-sharp';
// @ts-ignore
import Go from 'tree-sitter-go';
// @ts-ignore
import Rust from 'tree-sitter-rust';
// @ts-ignore
import Ruby from 'tree-sitter-ruby';
// @ts-ignore
import PHP from 'tree-sitter-php';
// @ts-ignore
import Scala from 'tree-sitter-scala';

import { SupportedLanguages, languageFromPath } from './languages.js';
import { LANGUAGE_QUERIES } from './queries.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedEntity {
  name: string;
  kind: string;       // NodeKind string: "class", "function", "method", etc.
  lineStart: number;
  lineEnd: number;
  language: string;
  /** Direct enclosing class/interface/trait, if any (undefined for file-level entities). */
  container?: string;
}

export interface ParsedRelationship {
  srcName: string;
  dstName: string;
  predicate: string;  // "CONTAINS" | "CALLS" | "IMPORTS" | "EXTENDS"
}

export interface FileParseResult {
  filePath: string;
  language: SupportedLanguages;
  entities: ParsedEntity[];
  relationships: ParsedRelationship[];
}

// ---------------------------------------------------------------------------
// Language → grammar map
// ---------------------------------------------------------------------------

const GRAMMAR_MAP: Partial<Record<SupportedLanguages, any>> = {
  [SupportedLanguages.JavaScript]: JavaScript,
  [SupportedLanguages.TypeScript]: TypeScript.typescript,
  [SupportedLanguages.Python]: Python,
  [SupportedLanguages.Java]: Java,
  [SupportedLanguages.C]: C,
  [SupportedLanguages.CPlusPlus]: CPP,
  [SupportedLanguages.CSharp]: CSharp,
  [SupportedLanguages.Go]: Go,
  [SupportedLanguages.Rust]: Rust,
  [SupportedLanguages.Ruby]: Ruby,
  [SupportedLanguages.PHP]: PHP.php_only,
  [SupportedLanguages.Scala]: Scala,
};

// Capture key prefix → NodeKind string
const DEFINITION_KIND_MAP: Record<string, string> = {
  'definition.class':     'class',
  'definition.interface': 'interface',
  'definition.function':  'function',
  'definition.method':    'method',
  'definition.struct':    'class',
  'definition.enum':      'class',
  'definition.trait':     'trait',
  'definition.module':    'module',
  'definition.namespace': 'module',
  'definition.impl':      'class',
  'definition.type':      'class',
  'definition.property':  'function',
  'definition.const':     'function',
  'definition.static':    'function',
  'definition.macro':     'function',
  'definition.union':     'class',
  'definition.typedef':   'class',
  'definition.template':  'class',
  'definition.record':    'class',
  'definition.delegate':  'class',
  'definition.annotation':'class',
  'definition.constructor':'method',
};

// Builtins to exclude from CALLS edges
const BUILTINS = new Set([
  'print', 'println', 'len', 'range', 'int', 'str', 'float', 'list', 'dict',
  'set', 'tuple', 'type', 'isinstance', 'super', 'property', 'enumerate',
  'zip', 'map', 'filter', 'sorted', 'any', 'all', 'min', 'max', 'sum',
  'console', 'log', 'warn', 'error', 'debug', 'info',
  'module', 'exports', 'undefined', 'null', 'true', 'false',
  'if', 'for', 'while', 'return', 'new', 'this', 'self',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON',
  'Math', 'Date', 'Error', 'Map', 'Set', 'Symbol',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'process', 'Buffer', 'global', 'window', 'document',
  'require', 'fetch', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
]);

/** Returns true if a grammar is installed for the given file's language. */
export function isGrammarSupported(filePath: string): boolean {
  const language = languageFromPath(filePath);
  if (!language) return false;
  if (filePath.endsWith('.tsx')) return true; // TSX uses TypeScript.tsx, always available
  return GRAMMAR_MAP[language] !== undefined;
}

// ---------------------------------------------------------------------------
// Parser instance (reused across calls)
// ---------------------------------------------------------------------------

let _parser: Parser | null = null;

function getParser(): Parser {
  if (!_parser) _parser = new Parser();
  return _parser;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

export function parseFile(filePath: string, source: string): FileParseResult | null {
  const language = languageFromPath(filePath);
  if (!language) return null;

  // TypeScript TSX uses a separate grammar
  const isTsx = filePath.endsWith('.tsx');
  const grammar = isTsx ? TypeScript.tsx : GRAMMAR_MAP[language];
  if (!grammar) return null;

  const queries = LANGUAGE_QUERIES[language];
  if (!queries) return null;

  try {
    const parser = getParser();
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    const query = new Parser.Query(grammar, queries);
    const matches = query.matches(tree.rootNode);

    const fileName = nodePath.basename(filePath);
    const lines = source.split('\n');

    const entities: ParsedEntity[] = [
      { name: fileName, kind: 'file', lineStart: 1, lineEnd: lines.length, language },
    ];
    const relationships: ParsedRelationship[] = [];

    // Track class ranges for containment: [name, startLine, endLine]
    const classRanges: Array<{ name: string; start: number; end: number }> = [];
    // Track seen calls per enclosing scope to avoid duplicate CALLS edges
    const seenCalls = new Map<string, Set<string>>();

    // --- First pass: collect definitions ---
    for (const match of matches) {
      // Definition captures: name + definition.*
      const defCapture = match.captures.find((c: any) =>
        c.name.startsWith('definition.')
      );
      const nameCapture = match.captures.find((c: any) => c.name === 'name');

      if (defCapture) {
        const kind = DEFINITION_KIND_MAP[defCapture.name] ?? 'function';
        const name = nameCapture?.node.text
          ?? (defCapture.name === 'definition.constructor' ? 'init' : '');
        if (!name || name.length === 0) continue;

        const defNode = defCapture.node;
        const lineStart = defNode.startPosition.row + 1;
        const lineEnd = defNode.endPosition.row + 1;

        // Containment: file CONTAINS or class CONTAINS
        const enclosing = findEnclosing(classRanges, lineStart, name);

        entities.push({
          name,
          kind,
          lineStart,
          lineEnd,
          language,
          container: enclosing ?? undefined,
        });

        if (kind === 'class' || kind === 'interface' || kind === 'trait') {
          classRanges.push({ name, start: lineStart, end: lineEnd });
        }

        if (enclosing) {
          relationships.push({ srcName: enclosing, dstName: name, predicate: 'CONTAINS' });
        } else {
          relationships.push({ srcName: fileName, dstName: name, predicate: 'CONTAINS' });
        }
        continue;
      }

      // Heritage: EXTENDS
      const heritageClass = match.captures.find((c: any) =>
        c.name === 'heritage.class'
      );
      const heritageExtends = match.captures.find((c: any) =>
        c.name === 'heritage.extends' || c.name === 'heritage.trait'
      );
      if (heritageClass && heritageExtends) {
        relationships.push({
          srcName: heritageClass.node.text,
          dstName: heritageExtends.node.text,
          predicate: 'EXTENDS',
        });
        continue;
      }

      // Heritage: IMPLEMENTS (separate edge type, use EXTENDS for simplicity)
      const heritageImpl = match.captures.find((c: any) =>
        c.name === 'heritage.implements'
      );
      if (heritageClass && heritageImpl) {
        relationships.push({
          srcName: heritageClass.node.text,
          dstName: heritageImpl.node.text,
          predicate: 'EXTENDS',
        });
        continue;
      }
    }

    // --- Second pass: calls and imports ---
    for (const match of matches) {
      // Import captures
      const importSource = match.captures.find((c: any) => c.name === 'import.source');
      if (importSource) {
        let importPath = importSource.node.text
          .replace(/^["'`]|["'`]$/g, '') // strip quotes
          .replace(/\\\\/g, '/');          // normalise backslashes
        if (importPath.length > 0 && importPath !== '*') {
          const rawMod = importPath.split('/').filter(s => s !== '*').pop() ?? importPath;
          const modName = rawMod.replace(/^\.+/, '');   // strip leading dots: '.models' → 'models'
          if (!modName) continue;                        // skip bare '.' relative imports
          entities.push({ name: modName, kind: 'module', lineStart: importSource.node.startPosition.row + 1, lineEnd: importSource.node.startPosition.row + 1, language });
          relationships.push({ srcName: fileName, dstName: modName, predicate: 'IMPORTS' });
        }
        continue;
      }

      // Import name captures (e.g. from . import utils — the symbol name, not the module path)
      const importName = match.captures.find((c: any) => c.name === 'import.name');
      if (importName) {
        const name = importName.node.text;
        if (name && name !== '*' && name.length > 1) {
          entities.push({ name, kind: 'module', lineStart: importName.node.startPosition.row + 1, lineEnd: importName.node.startPosition.row + 1, language });
          relationships.push({ srcName: fileName, dstName: name, predicate: 'IMPORTS' });
        }
        continue;
      }

      // Call captures
      const callName = match.captures.find((c: any) => c.name === 'call.name');
      if (callName) {
        const callee = callName.node.text;
        if (!callee || BUILTINS.has(callee) || callee.length <= 1) continue;

        // Find enclosing function/method for the call
        const callLine = callName.node.startPosition.row + 1;
        const caller = findEnclosingFunction(entities, callLine) ?? fileName;

        const scope = caller;
        if (!seenCalls.has(scope)) seenCalls.set(scope, new Set());
        const seen = seenCalls.get(scope)!;
        if (!seen.has(callee)) {
          seen.add(callee);
          relationships.push({ srcName: caller, dstName: callee, predicate: 'CALLS' });
        }
        continue;
      }
    }

    return { filePath, language, entities, relationships };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-file CALLS resolution
// ---------------------------------------------------------------------------

export interface ResolvedCallEdge {
  callerFilePath: string;
  callerName: string;           // the caller entity (function/method/file)
  calleeFilePath: string;       // the file where the callee is actually defined
  calleeName: string;           // plain name as it appears in the CALLS relationship
  calleeQualifiedKey: string;   // qualified key used for nodeId in the callee file
                                // e.g. 'PaymentService.charge' for a class method,
                                // or plain 'processPayment' for a module-level function
  confidence: number;           // 0.9 import-scoped | 0.5 global
}

// ---------------------------------------------------------------------------
// resolveCallEdges helpers
// ---------------------------------------------------------------------------

/** Build the qualified key for an entity (mirrors buildPatch's entityQKey logic). */
function qualifiedKey(e: ParsedEntity): string {
  return e.container ? `${e.container}.${e.name}` : e.name;
}

/**
 * Given a file's qualified-key map and a plain callee name, return the single
 * unambiguous qualified key, or null if the name maps to 0 or >1 entities.
 * Callers must treat null as "do not emit" to avoid dangling nodeIds.
 */
function bestQKey(
  fileQKeys: Map<string, Map<string, string[]>>,
  filePath: string,
  plainName: string,
): string | null {
  const qks = fileQKeys.get(filePath)?.get(plainName) ?? [];
  return qks.length === 1 ? qks[0] : null;
}

/**
 * Resolves CALLS relationships to their cross-file targets by building a
 * symbol table and import map over the full batch of parsed files.
 *
 * Tiers (in priority order):
 *   0.9 — import-scoped: callee is in a file the caller explicitly imports
 *   0.5 — global fallback: callee exists in exactly one other file (unambiguous)
 *
 * Same-file calls (tier 0.95) are already handled correctly by buildPatch and
 * are not emitted here.
 *
 * Import resolution handles:
 *   - Stem-based:      './payments'     → 'payments.ts'
 *   - Path-aliased:    '@/lib/payments' → 'payments.ts'  (last segment)
 *   - Directory index: './services'     → 'services/index.ts'
 *   - Bare aliases:    '@components'    → 'components.ts' (strip leading non-word chars)
 *                      '~lib'           → 'lib.ts'
 *   - External bare:   'react'          → unresolved (no match in batch)
 *
 * Qualified-key resolution:
 *   - Module-level function: calleeQualifiedKey === calleeName
 *   - Unambiguous class method: calleeQualifiedKey === 'ClassName.method'
 *   - Ambiguous (two classes define same method name): edge not emitted
 */
export function resolveCallEdges(results: FileParseResult[]): ResolvedCallEdge[] {
  // fileQKeys: filePath → (plainName → qualifiedKeys[])
  // Mirrors the entityQKey computation in buildPatch so nodeIds match exactly.
  const fileQKeys = new Map<string, Map<string, string[]>>();
  for (const r of results) {
    const qkMap = new Map<string, string[]>();
    for (const e of r.entities) {
      if (e.kind === 'file' || e.kind === 'module') continue;
      const qk = qualifiedKey(e);
      const list = qkMap.get(e.name) ?? [];
      list.push(qk);
      qkMap.set(e.name, list);
    }
    fileQKeys.set(r.filePath, qkMap);
  }

  // fileHasSymbol: filePath → Set<plainName>  (fast membership check)
  const fileHasSymbol = new Map<string, Set<string>>();
  for (const [fp, qkMap] of fileQKeys) {
    fileHasSymbol.set(fp, new Set(qkMap.keys()));
  }

  // stemToFiles: basename-without-extension → filePath[]
  // Matches the last path segment of an import to files in the batch.
  // e.g. './payments' → modName 'payments' → 'payments.ts'
  //      '@/lib/payments' → modName 'payments' → 'payments.ts'
  const stemToFiles = new Map<string, string[]>();
  for (const r of results) {
    const stem = nodePath.basename(r.filePath, nodePath.extname(r.filePath));
    const list = stemToFiles.get(stem) ?? [];
    list.push(r.filePath);
    stemToFiles.set(stem, list);
  }

  // dirToIndexFiles: directory basename → filePath[] for 'index.*' files
  // Handles directory imports: './services' → 'services/index.ts'
  const dirToIndexFiles = new Map<string, string[]>();
  for (const r of results) {
    const stem = nodePath.basename(r.filePath, nodePath.extname(r.filePath));
    if (stem === 'index') {
      const dirName = nodePath.basename(nodePath.dirname(r.filePath));
      const list = dirToIndexFiles.get(dirName) ?? [];
      list.push(r.filePath);
      dirToIndexFiles.set(dirName, list);
    }
  }

  const resolved: ResolvedCallEdge[] = [];

  for (const result of results) {
    const callerFilePath = result.filePath;
    const callerSymbols = fileHasSymbol.get(callerFilePath)!;

    // Build the set of file paths this caller explicitly imports.
    // For each IMPORTS edge, try the modName as-is, then with leading
    // non-word characters stripped (handles bare aliases: '@components' → 'components',
    // '~lib' → 'lib', '#utils' → 'utils').
    const importedFilePaths = new Set<string>();
    for (const rel of result.relationships) {
      if (rel.predicate !== 'IMPORTS') continue;
      const candidates = [rel.dstName];
      const stripped = rel.dstName.replace(/^[^a-zA-Z0-9_]+/, '');
      if (stripped && stripped !== rel.dstName) candidates.push(stripped);
      for (const modName of candidates) {
        for (const fp of stemToFiles.get(modName) ?? []) {
          if (fp !== callerFilePath) importedFilePaths.add(fp);
        }
        for (const fp of dirToIndexFiles.get(modName) ?? []) {
          if (fp !== callerFilePath) importedFilePaths.add(fp);
        }
      }
    }

    // Build one-hop transitive import set: files imported by directly-imported files.
    // Handles re-exports: baz.ts → index.ts (re-exports from bar.ts) → bar.ts
    const transitiveFilePaths = new Set<string>();
    for (const fp of importedFilePaths) {
      const fpResult = results.find(r => r.filePath === fp);
      if (!fpResult) continue;
      for (const rel of fpResult.relationships) {
        if (rel.predicate !== 'IMPORTS') continue;
        const candidates = [rel.dstName];
        const stripped = rel.dstName.replace(/^[^a-zA-Z0-9_]+/, '');
        if (stripped && stripped !== rel.dstName) candidates.push(stripped);
        for (const modName of candidates) {
          for (const transitiveFp of stemToFiles.get(modName) ?? []) {
            if (transitiveFp !== callerFilePath && !importedFilePaths.has(transitiveFp))
              transitiveFilePaths.add(transitiveFp);
          }
          for (const transitiveFp of dirToIndexFiles.get(modName) ?? []) {
            if (transitiveFp !== callerFilePath && !importedFilePaths.has(transitiveFp))
              transitiveFilePaths.add(transitiveFp);
          }
        }
      }
    }

    for (const rel of result.relationships) {
      if (rel.predicate !== 'CALLS') continue;
      const calleeName = rel.dstName;
      const callerName = rel.srcName;

      // Tier 1: same-file — already correct in buildPatch, skip here
      if (callerSymbols.has(calleeName)) continue;

      // Tier 2: import-scoped (confidence 0.9)
      const importMatches: string[] = [];
      for (const fp of importedFilePaths) {
        if (fileHasSymbol.get(fp)?.has(calleeName)) importMatches.push(fp);
      }

      if (importMatches.length === 1) {
        const fp = importMatches[0];
        const calleeQualifiedKey = bestQKey(fileQKeys, fp, calleeName);
        if (calleeQualifiedKey === null) continue; // ambiguous class methods — do not emit bad nodeId
        resolved.push({ callerFilePath, callerName, calleeFilePath: fp, calleeName, calleeQualifiedKey, confidence: 0.9 });
        continue;
      }
      if (importMatches.length > 1) continue; // ambiguous file — do not emit

      // Tier 2.5: transitive import-scoped (confidence 0.8) — one re-export hop away
      const transitiveMatches: string[] = [];
      for (const fp of transitiveFilePaths) {
        if (fileHasSymbol.get(fp)?.has(calleeName)) transitiveMatches.push(fp);
      }

      if (transitiveMatches.length === 1) {
        const fp = transitiveMatches[0];
        const calleeQualifiedKey = bestQKey(fileQKeys, fp, calleeName);
        if (calleeQualifiedKey === null) continue;
        resolved.push({ callerFilePath, callerName, calleeFilePath: fp, calleeName, calleeQualifiedKey, confidence: 0.8 });
        continue;
      }
      if (transitiveMatches.length > 1) continue; // ambiguous — do not emit

      // Tier 3: global fallback (confidence 0.5) — exactly one other file defines it
      const globalMatches: string[] = [];
      for (const [fp, symbols] of fileHasSymbol) {
        if (fp !== callerFilePath && symbols.has(calleeName)) globalMatches.push(fp);
      }

      if (globalMatches.length === 1) {
        const fp = globalMatches[0];
        const calleeQualifiedKey = bestQKey(fileQKeys, fp, calleeName);
        if (calleeQualifiedKey === null) continue; // ambiguous class methods — do not emit bad nodeId
        resolved.push({ callerFilePath, callerName, calleeFilePath: fp, calleeName, calleeQualifiedKey, confidence: 0.5 });
      }
      // 0 or >1 global matches — leave as dangling edge, do not emit
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEnclosing(
  ranges: Array<{ name: string; start: number; end: number }>,
  line: number,
  excludeName: string
): string | null {
  // Find the innermost class/interface that contains this line
  let best: { name: string; start: number; end: number } | null = null;
  for (const r of ranges) {
    if (r.name === excludeName) continue;
    if (line >= r.start && line <= r.end) {
      if (!best || (r.end - r.start) < (best.end - best.start)) {
        best = r;
      }
    }
  }
  return best?.name ?? null;
}

function findEnclosingFunction(
  entities: ParsedEntity[],
  line: number
): string | null {
  let best: ParsedEntity | null = null;
  for (const e of entities) {
    if (e.kind !== 'function' && e.kind !== 'method') continue;
    if (line >= e.lineStart && line <= e.lineEnd) {
      if (!best || (e.lineEnd - e.lineStart) < (best.lineEnd - best.lineStart)) {
        best = e;
      }
    }
  }
  return best ? (best.container ? `${best.container}.${best.name}` : best.name) : null;
}
