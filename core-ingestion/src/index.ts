import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
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
import { classifyFileRole } from './role-classifier.js';
import type { RoleClassification } from './role-classifier.js';

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

/** A semantic code span extracted from the AST. The primary LLM retrieval unit. */
export interface ParsedChunk {
  /** Semantic name of the chunk (function/class/trait name), or null for file_body. */
  name: string | null;
  /** Chunk kind: "function" | "method" | "class" | "interface" | "trait" | "module_block" | "file_body" */
  chunkKind: string;
  lineStart: number;
  lineEnd: number;
  startByte: number;
  endByte: number;
  /** SHA-256 of the chunk source text for change detection and stable identity. */
  contentHash: string;
  language: string;
  /** Name of the directly enclosing class/trait/interface, if any. */
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
  chunks: ParsedChunk[];
  relationships: ParsedRelationship[];
  fileRole: RoleClassification;
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

// Primitive / built-in types to exclude from REFERENCES edges
const TYPE_BUILTINS = new Set([
  // TypeScript / JavaScript
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'any', 'never',
  'unknown', 'object', 'bigint', 'symbol',
  // Java / Kotlin / Scala
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short',
  'Character', 'Object', 'Void', 'Int', 'Unit', 'Any', 'AnyVal', 'AnyRef',
  'Nothing', 'Null', 'Char', 'Number',
  // C#
  'decimal',
  // Python
  'int', 'str', 'float', 'bool', 'bytes', 'Optional', 'Union', 'List', 'Dict',
  'Set', 'Tuple', 'Type',
  // Rust
  'i8', 'i16', 'i32', 'i64', 'i128', 'u8', 'u16', 'u32', 'u64', 'u128',
  'f32', 'f64', 'usize', 'isize',
  // Go
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'byte', 'rune', 'error',
  // Common stdlib collections / wrappers
  'Array', 'Map', 'Seq', 'Vector', 'Option', 'Future', 'Promise', 'Result',
  'Either', 'Try', 'IO', 'Observable', 'Iterator', 'Iterable',
  // C / C++
  'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t',
  'int16_t', 'int32_t', 'int64_t',
]);

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
const _queryCache = new Map<SupportedLanguages | 'tsx', { grammar: any; query: any }>();

function getParser(): Parser {
  if (!_parser) _parser = new Parser();
  return _parser;
}

function getCachedQuery(
  language: SupportedLanguages | 'tsx',
  grammar: any,
  querySource: string,
): any {
  const cached = _queryCache.get(language);
  if (cached && cached.grammar === grammar) return cached.query;
  const query = new Parser.Query(grammar, querySource);
  _queryCache.set(language, { grammar, query });
  return query;
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
    const cacheKey = isTsx ? 'tsx' as const : language;
    const query = getCachedQuery(cacheKey, grammar, queries);
    const matches = query.matches(tree.rootNode);

    const fileName = nodePath.basename(filePath);
    let sourceLineCount = 1;
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) sourceLineCount++;
    }

    const entities: ParsedEntity[] = [
      { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
    ];
    const chunks: ParsedChunk[] = [];
    const relationships: ParsedRelationship[] = [];
    const pendingChunks: Array<{
      name: string;
      chunkKind: string;
      lineStart: number;
      lineEnd: number;
      startByte: number;
      endByte: number;
      language: SupportedLanguages;
      container?: string;
    }> = [];

    // Track class ranges for containment: [name, startLine, endLine]
    const classRanges: Array<{ name: string; start: number; end: number }> = [];
    // Track seen calls per enclosing scope to avoid duplicate CALLS edges
    const seenCalls = new Map<string, Set<string>>();
    // Track seen type references per enclosing class/file to avoid duplicate REFERENCES edges
    const seenRefs = new Map<string, Set<string>>();

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
        const startByte = defNode.startIndex;
        const endByte = defNode.endIndex;

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

        pendingChunks.push({
          name,
          chunkKind: kind,
          lineStart,
          lineEnd,
          startByte,
          endByte,
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
      // Full import statement captures (Scala: reconstructs dotted package paths)
      const importStmt = match.captures.find((c: any) => c.name === 'import.stmt');
      if (importStmt) {
        const raw = importStmt.node.text.replace(/^import\s+/, '').trim();
        const line = importStmt.node.startPosition.row + 1;
        if (raw.endsWith('._')) {
          // Wildcard: "ix.memory.model._" → package path "ix.memory.model"
          const pkgPath = raw.slice(0, -2);
          entities.push({ name: pkgPath, kind: 'module', lineStart: line, lineEnd: line, language });
          relationships.push({ srcName: fileName, dstName: pkgPath, predicate: 'IMPORTS' });
        } else {
          const braceIdx = raw.lastIndexOf('.{');
          if (braceIdx !== -1) {
            // Selective: "ix.memory.model.{NodeKind, GraphNode}"
            const prefix = raw.slice(0, braceIdx);
            const names = raw.slice(braceIdx + 2, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
            for (const name of names) {
              const dstName = `${prefix}.${name}`;
              entities.push({ name: dstName, kind: 'module', lineStart: line, lineEnd: line, language });
              relationships.push({ srcName: fileName, dstName, predicate: 'IMPORTS' });
            }
          } else {
            // Simple: "ix.memory.model.NodeKind"
            entities.push({ name: raw, kind: 'module', lineStart: line, lineEnd: line, language });
            relationships.push({ srcName: fileName, dstName: raw, predicate: 'IMPORTS' });
          }
        }
        continue;
      }

      // Import captures (JS/TS/Python path-based)
      const importSource = match.captures.find((c: any) => c.name === 'import.source');
      if (importSource) {
        let importPath = importSource.node.text
          .replace(/^["'`]|["'`]$/g, '') // strip quotes
          .replace(/\\\\/g, '/');          // normalise backslashes
        if (importPath.length > 0 && importPath !== '*') {
          const rawMod = importPath.split('/').filter((s: string) => s !== '*').pop() ?? importPath;
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

        // Find enclosing function/method for the call; fall back to enclosing class
        // (e.g. calls in val/lazy val body at class level) before falling back to file.
        const callLine = callName.node.startPosition.row + 1;
        const caller = findEnclosingFunction(entities, callLine)
          ?? findEnclosing(classRanges, callLine, '')
          ?? fileName;

        const scope = caller;
        if (!seenCalls.has(scope)) seenCalls.set(scope, new Set());
        const seen = seenCalls.get(scope)!;

        // If a _qualifier capture is present (field_expression / stable_identifier
        // patterns like NodeKind.Decision), emit the fully qualified name so that
        // resolution can use the qualifier to break ties between same-named symbols
        // in different files (e.g. NodeKind.Decision vs SourceType.Decision).
        const qualifierCapture = match.captures.find((c: any) => c.name === '_qualifier');
        const effectiveCallee = qualifierCapture
          ? `${qualifierCapture.node.text}.${callee}`
          : callee;

        if (!seen.has(effectiveCallee)) {
          seen.add(effectiveCallee);
          relationships.push({ srcName: caller, dstName: effectiveCallee, predicate: 'CALLS' });
        }
        continue;
      }

      // Type reference captures
      const refType = match.captures.find((c: any) => c.name === 'reference.type');
      if (refType) {
        const typeName = refType.node.text;
        if (!typeName || TYPE_BUILTINS.has(typeName) || typeName.length <= 1) continue;

        // Use the enclosing class as the src so the edge reads "ClassX REFERENCES TypeY".
        // Fall back to the file name when no enclosing class is found (top-level usage).
        const refLine = refType.node.startPosition.row + 1;
        const src = findEnclosing(classRanges, refLine, typeName) ?? fileName;

        if (!seenRefs.has(src)) seenRefs.set(src, new Set());
        const seen = seenRefs.get(src)!;
        if (!seen.has(typeName)) {
          seen.add(typeName);
          relationships.push({ srcName: src, dstName: typeName, predicate: 'REFERENCES' });
        }
        continue;
      }
    }

    for (const pendingChunk of pendingChunks) {
      const chunkText = source.slice(pendingChunk.startByte, pendingChunk.endByte);
      const contentHash = crypto.createHash('sha256').update(chunkText).digest('hex').slice(0, 16);
      chunks.push({
        ...pendingChunk,
        contentHash,
      });
    }

    // Fallback: if no semantic chunks found, emit one file_body chunk covering the whole file
    if (chunks.length === 0) {
      const contentHash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
      chunks.push({
        name: null,
        chunkKind: 'file_body',
        lineStart: 1,
        lineEnd: sourceLineCount,
        startByte: 0,
        endByte: source.length,
        contentHash,
        language,
      });
    }

    return { filePath, language, entities, chunks, relationships, fileRole: classifyFileRole(filePath, source) };
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

/** Generalised form of ResolvedCallEdge that covers any cross-file edge predicate. */
export interface ResolvedEdge {
  srcFilePath: string;
  srcName: string;
  dstFilePath: string;          // file where the destination symbol is actually defined
  dstName: string;              // plain name as it appears in the relationship
  dstQualifiedKey: string;      // qualified key used for nodeId in the defining file
  predicate: string;            // "CALLS" | "EXTENDS"
  confidence: number;           // 0.9 import-scoped | 0.8 transitive | 0.5 global
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
  const qks = [...new Set(fileQKeys.get(filePath)?.get(plainName) ?? [])];
  return qks.length === 1 ? qks[0] : null;
}

/**
 * Resolves CALLS and EXTENDS relationships to their cross-file targets by
 * building a symbol table and import map over the full batch of parsed files.
 *
 * Tiers (in priority order):
 *   0.9 — import-scoped: dst is in a file the src explicitly imports
 *   0.8 — transitive import-scoped: one re-export hop away
 *   0.5 — global fallback: dst exists in exactly one other file (unambiguous)
 *
 * Same-file edges are already handled correctly by buildPatch and are not
 * emitted here.
 *
 * Import resolution handles:
 *   - Stem-based:      './payments'     → 'payments.ts'
 *   - Path-aliased:    '@/lib/payments' → 'payments.ts'  (last segment)
 *   - Directory index: './services'     → 'services/index.ts'
 *   - Bare aliases:    '@components'    → 'components.ts' (strip leading non-word chars)
 *   - Dotted paths:    'ix.memory.model.Edge' → stem 'Edge' → 'Edge.scala'
 *                      (handles Scala/Java package imports where tree-sitter
 *                       emits each identifier separately)
 *
 * Qualified-key resolution:
 *   - Module-level function/class: dstQualifiedKey === dstName
 *   - Unambiguous class method: dstQualifiedKey === 'ClassName.method'
 *   - Ambiguous (two entities share the same plain name): edge not emitted
 */
export function resolveEdges(results: FileParseResult[]): ResolvedEdge[] {
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

  // resultsByPath: O(1) lookup replacing results.find() in transitive import loop
  const resultsByPath = new Map<string, FileParseResult>(results.map(r => [r.filePath, r]));

  // symbolToFiles: plainName → filePath[]  — replaces O(F) full-scan in tier-3 and qualifier fallback
  const symbolToFiles = new Map<string, string[]>();
  for (const [fp, symbols] of fileHasSymbol) {
    for (const sym of symbols) {
      const list = symbolToFiles.get(sym) ?? [];
      list.push(fp);
      symbolToFiles.set(sym, list);
    }
  }

  // stemToFiles: basename-without-extension → filePath[]
  // Matches the last path segment of an import to files in the batch.
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

  // packageToFiles: dotted package path → filePath[] (Scala/Java wildcard imports)
  // e.g. "ix.memory.model" → all .scala files under .../ix/memory/model/
  // Builds all suffix keys so that both "model" and "ix.memory.model" resolve.
  const packageToFiles = new Map<string, string[]>();
  for (const r of results) {
    const ext = nodePath.extname(r.filePath);
    if (ext !== '.scala' && ext !== '.java') continue;
    const dir = nodePath.dirname(r.filePath);
    const parts = dir.split(/[/\\]/);
    // Cap at 8 segments to avoid noise from very shallow path components like "src", "main".
    const maxDepth = Math.min(8, parts.length);
    for (let i = parts.length - 1; i >= parts.length - maxDepth; i--) {
      const pkg = parts.slice(i).join('.');
      const list = packageToFiles.get(pkg) ?? [];
      if (!list.includes(r.filePath)) list.push(r.filePath);
      packageToFiles.set(pkg, list);
    }
  }

  /** Resolve a module name to matching file paths in the batch. */
  function modNameToFiles(modName: string, excludeFp: string): string[] {
    const fps: string[] = [];
    // Strip leading non-word chars for bare aliases: '@components' → 'components'
    const candidates = [modName];
    const stripped = modName.replace(/^[^a-zA-Z0-9_]+/, '');
    if (stripped && stripped !== modName) candidates.push(stripped);
    // Strip file extensions so "explain.js" resolves to the "explain" stem
    // (TS/JS ESM imports use .js extensions that map to .ts source files)
    const noExt = modName.replace(/\.(js|ts|mjs|cjs|jsx|tsx|py|scala|java)$/, '');
    if (noExt !== modName && noExt && !candidates.includes(noExt)) candidates.push(noExt);
    // For dotted paths (Scala/Java: 'ix.memory.model.Edge'), also try last segment
    const lastDot = modName.lastIndexOf('.');
    if (lastDot !== -1) {
      const lastSegment = modName.slice(lastDot + 1);
      if (lastSegment && !candidates.includes(lastSegment)) candidates.push(lastSegment);
    }
    for (const cand of candidates) {
      for (const fp of stemToFiles.get(cand) ?? []) {
        if (fp !== excludeFp) fps.push(fp);
      }
      for (const fp of dirToIndexFiles.get(cand) ?? []) {
        if (fp !== excludeFp) fps.push(fp);
      }
    }
    // Package-path wildcard resolution (Scala/Java): "ix.memory.model" → all files in that dir
    for (const fp of packageToFiles.get(modName) ?? []) {
      if (fp !== excludeFp && !fps.includes(fp)) fps.push(fp);
    }
    return fps;
  }

  const resolved: ResolvedEdge[] = [];

  for (const result of results) {
    const srcFilePath = result.filePath;
    const srcSymbols = fileHasSymbol.get(srcFilePath)!;

    // Build the set of file paths this file explicitly imports.
    const importedFilePaths = new Set<string>();
    for (const rel of result.relationships) {
      if (rel.predicate !== 'IMPORTS') continue;
      for (const fp of modNameToFiles(rel.dstName, srcFilePath)) {
        importedFilePaths.add(fp);
      }
    }

    // Build one-hop transitive import set.
    // Handles re-exports: baz.ts → index.ts (re-exports from bar.ts) → bar.ts
    const transitiveFilePaths = new Set<string>();
    for (const fp of importedFilePaths) {
      const fpResult = resultsByPath.get(fp);
      if (!fpResult) continue;
      for (const rel of fpResult.relationships) {
        if (rel.predicate !== 'IMPORTS') continue;
        for (const transitiveFp of modNameToFiles(rel.dstName, srcFilePath)) {
          if (!importedFilePaths.has(transitiveFp)) transitiveFilePaths.add(transitiveFp);
        }
      }
    }

    for (const rel of result.relationships) {
      if (rel.predicate !== 'CALLS' && rel.predicate !== 'EXTENDS' && rel.predicate !== 'REFERENCES' && rel.predicate !== 'IMPORTS') continue;

      // Resolve Scala/Java dotted class imports (e.g. "ix.memory.model.ClaimId")
      // to the actual indexed entity node in the defining file.
      // Uses package-path lookup: extract package ("ix.memory.model") and entity
      // name ("ClaimId"), find files registered under that package, then find
      // the one that defines the entity.
      if (rel.predicate === 'IMPORTS') {
        if (result.language !== SupportedLanguages.Scala && result.language !== SupportedLanguages.Java) continue;
        const dstName = rel.dstName;
        const lastDot = dstName.lastIndexOf('.');
        if (lastDot === -1) continue; // not a dotted class import
        const entityName = dstName.slice(lastDot + 1);
        if (!entityName || entityName === '_') continue; // wildcard import
        const pkgPath = dstName.slice(0, lastDot); // e.g. "ix.memory.model"
        // Find files in the declared package that define this entity
        const pkgFiles = packageToFiles.get(pkgPath) ?? [];
        const matchFiles = pkgFiles.filter(fp => fp !== srcFilePath && fileHasSymbol.get(fp)?.has(entityName));
        if (matchFiles.length !== 1) continue; // ambiguous or not found
        const fp = matchFiles[0];
        const dstQualifiedKey = bestQKey(fileQKeys, fp, entityName);
        if (dstQualifiedKey === null) continue;
        resolved.push({ srcFilePath, srcName: rel.srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: 'IMPORTS', confidence: 0.9 });
        continue;
      }

      const dstName = rel.dstName;
      const srcName = rel.srcName;

      // Tier 1b: qualifier-assisted (confidence 0.9 / 0.7)
      // For dotted names like "NodeKind.Decision" (emitted by field_expression queries):
      // find the file defining the qualifier, then check it also defines the member.
      // This breaks ties where both NodeKind.Decision and SourceType.Decision exist.
      const qualDot = dstName.lastIndexOf('.');
      if (qualDot !== -1) {
        const qualifierPart = dstName.slice(0, qualDot);
        const memberPart = dstName.slice(qualDot + 1);
        if (memberPart && qualifierPart) {
          // Try import-scoped qualifier first
          const qualImportMatches: string[] = [];
          for (const fp of importedFilePaths) {
            if (fileHasSymbol.get(fp)?.has(qualifierPart)) qualImportMatches.push(fp);
          }
          if (qualImportMatches.length === 1) {
            const qfp = qualImportMatches[0];
            if (fileHasSymbol.get(qfp)?.has(memberPart)) {
              const dstQualifiedKey = bestQKey(fileQKeys, qfp, memberPart);
              if (dstQualifiedKey !== null) {
                // dstName must match rel.dstName so buildPatchWithResolution can look it up
                resolved.push({ srcFilePath, srcName, dstFilePath: qfp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.9 });
              }
            }
            continue;
          }
          // Global qualifier fallback — use symbolToFiles index instead of full scan
          const qualGlobalMatches = (symbolToFiles.get(qualifierPart) ?? []).filter(fp => fp !== srcFilePath);
          if (qualGlobalMatches.length === 1) {
            const qfp = qualGlobalMatches[0];
            if (fileHasSymbol.get(qfp)?.has(memberPart)) {
              const dstQualifiedKey = bestQKey(fileQKeys, qfp, memberPart);
              if (dstQualifiedKey !== null) {
                resolved.push({ srcFilePath, srcName, dstFilePath: qfp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.7 });
              }
            }
          }
          continue; // qualified name exhausted — don't try bare-name tiers
        }
      }

      // Tier 1: same-file — already correct in buildPatch, skip here
      if (srcSymbols.has(dstName)) continue;

      // Tier 2: import-scoped (confidence 0.9)
      const importMatches: string[] = [];
      for (const fp of importedFilePaths) {
        if (fileHasSymbol.get(fp)?.has(dstName)) importMatches.push(fp);
      }

      if (importMatches.length === 1) {
        const fp = importMatches[0];
        const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
        if (dstQualifiedKey === null) continue; // ambiguous — do not emit bad nodeId
        resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.9 });
        continue;
      }
      if (importMatches.length > 1) continue; // ambiguous file — do not emit

      // Tier 2.5: transitive import-scoped (confidence 0.8) — one re-export hop away
      const transitiveMatches: string[] = [];
      for (const fp of transitiveFilePaths) {
        if (fileHasSymbol.get(fp)?.has(dstName)) transitiveMatches.push(fp);
      }

      if (transitiveMatches.length === 1) {
        const fp = transitiveMatches[0];
        const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
        if (dstQualifiedKey === null) continue;
        resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.8 });
        continue;
      }
      if (transitiveMatches.length > 1) continue; // ambiguous — do not emit

      // Tier 3: global fallback (confidence 0.5) — exactly one other file defines it
      // Only match files in the same language as the caller to avoid cross-language false positives.
      const srcLanguage = result.language;
      const globalMatches = (symbolToFiles.get(dstName) ?? [])
        .filter(fp => fp !== srcFilePath && languageFromPath(fp) === srcLanguage);

      if (globalMatches.length === 1) {
        const fp = globalMatches[0];
        const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
        if (dstQualifiedKey === null) continue; // ambiguous — do not emit bad nodeId
        resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.5 });
      }
      // 0 or >1 global matches — leave as dangling edge, do not emit
    }
  }

  return resolved;
}

/** @deprecated Use resolveEdges instead. */
export function resolveCallEdges(results: FileParseResult[]): ResolvedCallEdge[] {
  return resolveEdges(results).map(e => ({
    callerFilePath: e.srcFilePath,
    callerName: e.srcName,
    calleeFilePath: e.dstFilePath,
    calleeName: e.dstName,
    calleeQualifiedKey: e.dstQualifiedKey,
    confidence: e.confidence,
  }));
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
