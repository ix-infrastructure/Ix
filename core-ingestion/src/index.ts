import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
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
const _require = createRequire(import.meta.url);
function tryLoadGrammar(pkg: string): any {
  try { return _require(pkg); } catch { return null; }
}
const Kotlin = tryLoadGrammar('tree-sitter-kotlin');
const Swift = tryLoadGrammar('tree-sitter-swift');
const R = tryLoadGrammar('@davisvaughan/tree-sitter-r');

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
  importAliases?: Record<string, string>;
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
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
  ...(R ? { [SupportedLanguages.R]: R } : {}),
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
  'definition.macro':     'macro',
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

// Builtins to exclude from CALLS edges — split by language family to avoid
// suppressing valid method names in other languages (e.g. `filter` is a Python
// builtin but also a common ORM method; `warn`/`error` are JS console methods
// but also valid Python logging method names).

// Keywords and pseudo-variables that are never valid call targets in any language.
const SHARED_BUILTINS = new Set([
  'if', 'for', 'while', 'return', 'new', 'this', 'self',
  'undefined', 'null', 'true', 'false',
  'println',  // Scala/Java/Kotlin/Rust standard-output builtin — noise in any language
]);

// Python-specific builtins (bare function calls like `len(x)`, `range(n)`, etc.)
const PYTHON_BUILTINS = new Set([
  ...SHARED_BUILTINS,
  'print', 'len', 'range', 'int', 'str', 'float', 'list', 'dict',
  'set', 'tuple', 'type', 'isinstance', 'super', 'property', 'enumerate',
  'zip', 'map', 'filter', 'sorted', 'any', 'all', 'min', 'max', 'sum',
  'open', 'repr', 'abs', 'round', 'hash', 'id', 'callable', 'iter', 'next',
  'vars', 'dir', 'getattr', 'setattr', 'hasattr', 'delattr',
]);

// JavaScript/TypeScript-specific builtins
const JS_BUILTINS = new Set([
  ...SHARED_BUILTINS,
  'console', 'log', 'warn', 'error', 'debug', 'info',
  'module', 'exports',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON',
  'Math', 'Date', 'Error', 'Map', 'Set', 'Symbol',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'process', 'Buffer', 'global', 'window', 'document',
  'require', 'fetch', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
]);

const R_BUILTINS = new Set([
  ...SHARED_BUILTINS,
  'library', 'require', 'source',
  'print', 'cat', 'message', 'warning', 'stop', 'sprintf', 'paste', 'paste0',
  'c', 'list', 'vector', 'matrix', 'array', 'data.frame',
  'length', 'nrow', 'ncol', 'dim', 'names', 'colnames', 'rownames',
  'head', 'tail', 'subset', 'merge', 'rbind', 'cbind', 'order', 'sort',
  'apply', 'lapply', 'sapply', 'vapply', 'tapply', 'mapply',
  'sum', 'mean', 'median', 'sd', 'var', 'min', 'max', 'abs',
  'round', 'floor', 'ceiling', 'sqrt', 'exp', 'log', 'log10',
  'as.character', 'as.numeric', 'as.integer', 'as.logical', 'as.factor',
  'is.character', 'is.numeric', 'is.integer', 'is.logical', 'is.null', 'is.na',
  'seq', 'seq_len', 'seq_along', 'rep', 'which', 'match', 'any', 'all', 'ifelse',
  'read.csv', 'write.csv', 'readRDS', 'saveRDS', 'load', 'save',
]);

// Per-language BUILTINS lookup — falls back to shared for languages without a
// specific set (e.g. Java, Go, Rust) so they only skip obvious non-calls.
function builtinsForLanguage(lang: SupportedLanguages): Set<string> {
  switch (lang) {
    case SupportedLanguages.Python:
      return PYTHON_BUILTINS;
    case SupportedLanguages.JavaScript:
    case SupportedLanguages.TypeScript:
      return JS_BUILTINS;
    case SupportedLanguages.R:
      return R_BUILTINS;
    default:
      return SHARED_BUILTINS;
  }
}

/** Returns true if a grammar is installed for the given file's language. */
export function isGrammarSupported(filePath: string): boolean {
  const language = languageFromPath(filePath);
  if (!language) return false;
  if (language === SupportedLanguages.YAML || language === SupportedLanguages.Dockerfile || language === SupportedLanguages.SQL || language === SupportedLanguages.JSON || language === SupportedLanguages.TOML || language === SupportedLanguages.Markdown) return true;
  if (filePath.endsWith('.tsx')) return true; // TSX uses TypeScript.tsx, always available
  return GRAMMAR_MAP[language] !== undefined;
}

// ---------------------------------------------------------------------------
// Parser instance (reused across calls)
// ---------------------------------------------------------------------------

let _parser: Parser | null = null;
let _currentGrammar: any = null;
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

function normalizeCapturedImport(rawValue: string, language: SupportedLanguages): string {
  const trimmed = rawValue.trim().replace(/\\\\/g, '/');
  const unwrapped = trimmed
    .replace(/^["'`<]/, '')
    .replace(/[>"'`]$/, '');

  if (language === SupportedLanguages.C || language === SupportedLanguages.CPlusPlus) {
    return unwrapped.replace(/^\.\/+/, '');
  }

  if (language === SupportedLanguages.Go) {
    return unwrapped.replace(/^\.+/, '');
  }

  const rawMod = unwrapped.split('/').filter((s: string) => s !== '*').pop() ?? unwrapped;
  return rawMod.replace(/^\.+/, '');
}

function fileEntityName(filePath: string): string {
  return nodePath.basename(filePath);
}

function looksLikeCppHeader(source: string): boolean {
  return /\bclass\s+[A-Za-z_]\w*\b/.test(source)
    || /\bnamespace\s+[A-Za-z_]\w*\b/.test(source)
    || /\btemplate\s*</.test(source)
    || /\busing\s+namespace\b/.test(source)
    || /\b(public|private|protected)\s*:/.test(source)
    || /\b(virtual|constexpr|typename|friend|operator)\b/.test(source)
    || /\b[A-Za-z_]\w*::[A-Za-z_]\w*/.test(source);
}

function detectLanguageForSource(filePath: string, source: string): SupportedLanguages | null {
  const language = languageFromPath(filePath);
  if (language === SupportedLanguages.C && filePath.toLowerCase().endsWith('.h') && looksLikeCppHeader(source)) {
    return SupportedLanguages.CPlusPlus;
  }
  return language;
}

function countSourceLines(source: string): number {
  let lineCount = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineCount++;
  }
  return lineCount;
}

function computeLineStarts(source: string): number[] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return lineStarts;
}

function parseYamlFile(filePath: string, source: string): FileParseResult {
  const language = SupportedLanguages.YAML;
  const fileName = nodePath.basename(filePath);
  const sourceLineCount = countSourceLines(source);
  const fileRole = classifyFileRole(filePath);
  const entities: ParsedEntity[] = [
    { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
  ];
  const chunks: ParsedChunk[] = [];
  const relationships: ParsedRelationship[] = [];
  const lineStarts = computeLineStarts(source);
  const lines = source.split(/\r?\n/);
  const stack: Array<{ indent: number; key: string }> = [];
  const keyLinePattern = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]+)\s*:.*$/;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = keyLinePattern.exec(line);
    if (!match) continue;

    const indent = match[1].replace(/\t/g, '  ').length;
    const listPrefixWidth = line.trimStart().startsWith('- ') ? 2 : 0;
    const effectiveIndent = indent + listPrefixWidth;
    const key = match[2];
    while (stack.length > 0 && effectiveIndent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    const lineNumber = index + 1;
    const lineStartOffset = lineStarts[index] ?? 0;
    const startByte = lineStartOffset + match[1].length + listPrefixWidth;
    const endByte = Math.max(startByte + key.length, lineStartOffset + line.length);

    entities.push({
      name: key,
      kind: 'config_entry',
      lineStart: lineNumber,
      lineEnd: lineNumber,
      language,
      container: parent?.key,
    });

    chunks.push({
      name: key,
      chunkKind: 'config_key',
      lineStart: lineNumber,
      lineEnd: lineNumber,
      startByte,
      endByte,
      contentHash: crypto.createHash('sha256').update(line).digest('hex'),
      language,
      container: parent?.key,
    });

    relationships.push({
      srcName: parent?.key ?? fileName,
      dstName: key,
      predicate: 'CONTAINS',
    });

    if (listPrefixWidth === 0) {
      stack.push({ indent: effectiveIndent, key });
    }
  }

  if (chunks.length === 0) {
    chunks.push({
      name: null,
      chunkKind: 'file_body',
      lineStart: 1,
      lineEnd: Math.max(sourceLineCount, 1),
      startByte: 0,
      endByte: source.length,
      contentHash: crypto.createHash('sha256').update(source).digest('hex'),
      language,
    });
  }

  return {
    filePath,
    language,
    entities,
    chunks,
    relationships,
    fileRole,
  };
}

function parseTomlFile(filePath: string, source: string): FileParseResult {
  const language = SupportedLanguages.TOML;
  const fileName = nodePath.basename(filePath);
  const sourceLineCount = countSourceLines(source);
  const fileRole = classifyFileRole(filePath);
  const entities: ParsedEntity[] = [
    { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
  ];
  const chunks: ParsedChunk[] = [];
  const relationships: ParsedRelationship[] = [];
  const lineStarts = computeLineStarts(source);
  const lines = source.split(/\r?\n/);

  // [table] or [[array-of-tables]] headers set the current section context.
  const tableHeaderPattern = /^\s*\[{1,2}([^\[\]]+)\]{1,2}\s*(?:#.*)?$/;
  // key = value lines (bare keys, quoted keys, dotted keys).
  // Quoted keys handled separately to avoid ReDoS from spaces overlapping with \s*.
  const keyPattern = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-][A-Za-z0-9_.-]*)\s*=/;

  let currentTable: string | null = null;
  const seenTablePaths = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const tableMatch = tableHeaderPattern.exec(line);
    if (tableMatch) {
      const tablePath = tableMatch[1].trim();
      currentTable = tablePath;
      const parts = tablePath.split('.');
      const lineNumber = i + 1;
      const startByte = lineStarts[i] ?? 0;

      // Emit intermediate nodes for each prefix segment (e.g. [a.b.c] → emit a, a.b)
      for (let p = 1; p < parts.length; p++) {
        const prefixPath = parts.slice(0, p).join('.');
        if (!seenTablePaths.has(prefixPath)) {
          seenTablePaths.add(prefixPath);
          const prefixKey = parts[p - 1];
          const prefixParent = p > 1 ? parts.slice(0, p - 1).join('.') : null;
          entities.push({
            name: prefixKey,
            kind: 'config_entry',
            lineStart: lineNumber,
            lineEnd: lineNumber,
            language,
            container: prefixParent ?? undefined,
          });
          relationships.push({
            srcName: prefixParent ?? fileName,
            dstName: prefixKey,
            predicate: 'CONTAINS',
          });
        }
      }

      const key = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts.slice(0, -1).join('.') : null;

      seenTablePaths.add(tablePath);
      entities.push({
        name: key,
        kind: 'config_entry',
        lineStart: lineNumber,
        lineEnd: lineNumber,
        language,
        container: parent ?? undefined,
      });
      chunks.push({
        name: key,
        chunkKind: 'config_key',
        lineStart: lineNumber,
        lineEnd: lineNumber,
        startByte,
        endByte: startByte + line.length,
        contentHash: crypto.createHash('sha256').update(line).digest('hex'),
        language,
        container: parent ?? undefined,
      });
      relationships.push({
        srcName: parent ?? fileName,
        dstName: key,
        predicate: 'CONTAINS',
      });
      continue;
    }

    const keyMatch = keyPattern.exec(line);
    if (keyMatch) {
      const key = keyMatch[1].trim().replace(/^["']|["']$/g, '');
      const lineNumber = i + 1;
      const startByte = lineStarts[i] ?? 0;

      entities.push({
        name: key,
        kind: 'config_entry',
        lineStart: lineNumber,
        lineEnd: lineNumber,
        language,
        container: currentTable ?? undefined,
      });
      chunks.push({
        name: key,
        chunkKind: 'config_key',
        lineStart: lineNumber,
        lineEnd: lineNumber,
        startByte,
        endByte: startByte + line.length,
        contentHash: crypto.createHash('sha256').update(line).digest('hex'),
        language,
        container: currentTable ?? undefined,
      });
      relationships.push({
        srcName: currentTable ?? fileName,
        dstName: key,
        predicate: 'CONTAINS',
      });
    }
  }

  if (chunks.length === 0) {
    chunks.push({
      name: null,
      chunkKind: 'file_body',
      lineStart: 1,
      lineEnd: Math.max(sourceLineCount, 1),
      startByte: 0,
      endByte: source.length,
      contentHash: crypto.createHash('sha256').update(source).digest('hex'),
      language,
    });
  }

  return { filePath, language, entities, chunks, relationships, fileRole };
}

function cleanHeadingName(raw: string): string {
  // 1. Strip VitePress anchor ID suffix {#...}
  // Use string methods to avoid ReDoS from overlapping \s* / [^}]+ quantifiers.
  let s = raw;
  const anchorStart = raw.lastIndexOf('{#');
  if (anchorStart !== -1) {
    const closeIdx = raw.indexOf('}', anchorStart + 2);
    if (closeIdx !== -1 && raw.slice(closeIdx + 1).trim() === '') {
      s = raw.slice(0, anchorStart).trimEnd();
    }
  }
  // 2. Unescape backslash-escaped angle brackets before HTML stripping
  s = s.replace(/\\</g, '\x01LT\x01').replace(/\\>/g, '\x01GT\x01');
  // 3. Protect inline code spans from HTML stripping
  const spans: string[] = [];
  s = s.replace(/`[^`]+`/g, (m) => { spans.push(m); return `\x00${spans.length - 1}\x00`; });
  // 4. Strip HTML tags (iteratively to handle split tags like <scr<x>ipt>).
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^>]+>/g, '');
  } while (s !== prev);
  // 5. Restore inline code spans and strip their backtick delimiters
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => spans[Number(i)].replace(/`/g, ''));
  // 6. Restore escaped angle brackets
  s = s.replace(/\x01LT\x01/g, '<').replace(/\x01GT\x01/g, '>');
  // 7. Strip VitePress stability markers (\* \*\* \*\*\*)
  s = s.replace(/\\\*+/g, '');
  // 8. Normalize whitespace
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function parseMarkdownFile(filePath: string, source: string): FileParseResult {
  const language = SupportedLanguages.Markdown;
  const fileName = nodePath.basename(filePath);
  const sourceLineCount = countSourceLines(source);
  const fileRole = classifyFileRole(filePath);
  const entities: ParsedEntity[] = [
    { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
  ];
  const chunks: ParsedChunk[] = [];
  const relationships: ParsedRelationship[] = [];
  const lineStarts = computeLineStarts(source);
  const lines = source.split(/\r?\n/);

  let startLine = 0;

  // Parse YAML frontmatter delimited by --- ... ---
  if (lines[0]?.trim() === '---') {
    let fmEnd = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === '---' || lines[j].trim() === '...') {
        fmEnd = j;
        break;
      }
    }
    if (fmEnd > 0) {
      startLine = fmEnd + 1;
      const endByte = (lineStarts[fmEnd] ?? 0) + lines[fmEnd].length;
      const fmContent = lines.slice(0, fmEnd + 1).join('\n');
      entities.push({ name: 'frontmatter', kind: 'frontmatter', lineStart: 1, lineEnd: fmEnd + 1, language });
      chunks.push({
        name: 'frontmatter',
        chunkKind: 'frontmatter',
        lineStart: 1,
        lineEnd: fmEnd + 1,
        startByte: 0,
        endByte,
        contentHash: crypto.createHash('sha256').update(fmContent).digest('hex'),
        language,
      });
      relationships.push({ srcName: fileName, dstName: 'frontmatter', predicate: 'CONTAINS' });
    }
  }

  // headingStack[level] = heading name currently active at that depth (1–6)
  const headingStack: (string | null)[] = [null, null, null, null, null, null, null];
  // \S[^\r\n]* requires content to start with non-whitespace, eliminating the
  // \s+/(.*\S) overlap that caused polynomial backtracking. Trailing whitespace
  // and closing ## markers are stripped in code below.
  const headingPattern = /^(#{1,6})[ \t]+(\S[^\r\n]*)$/;
  // Greedy .* with specific closing tag as anchor avoids (.*?)\s*$ overlap (ReDoS).
  const htmlHeadingPattern = /^<h([1-6])\b[^>]*>(.*)<\/h\1>/i;
  const headingLines: { level: number; name: string; lineNum: number; container: string | null }[] = [];

  // Bug 3 fix: track opening fence char+length so only matching delimiter closes the block
  let fenceState: { char: string; len: number } | null = null;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];

    // Toggle fenced code block — only close with same character and >= opening length
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (fenceMatch) {
      const matchChar = fenceMatch[1][0];
      const matchLen = fenceMatch[1].length;
      if (fenceState === null) {
        fenceState = { char: matchChar, len: matchLen };
      } else if (matchChar === fenceState.char && matchLen >= fenceState.len) {
        fenceState = null;
      }
      continue;
    }
    if (fenceState !== null) continue;

    const headingMatch = headingPattern.exec(line);
    const htmlHeadingMatch = headingMatch ? null : htmlHeadingPattern.exec(line.trim());

    // Bug 2 fix: detect setext-style headings (text line followed by === or --- underline)
    let setextLevel: number | null = null;
    if (!headingMatch && !htmlHeadingMatch && line.trim() !== '') {
      const nextLine = lines[i + 1];
      if (nextLine !== undefined) {
        if (/^=+\s*$/.test(nextLine)) setextLevel = 1;
        else if (/^-+\s*$/.test(nextLine)) setextLevel = 2;
      }
    }

    if (!headingMatch && !htmlHeadingMatch && setextLevel === null) continue;

    const level = headingMatch ? headingMatch[1].length : (htmlHeadingMatch ? Number(htmlHeadingMatch![1]) : setextLevel!);
    // Strip optional ATX closing markers (e.g. "Title ##") that (.*\S) now includes.
    // Use string walk instead of regex to avoid ReDoS on +#+$ backtracking.
    let atxRaw = headingMatch ? headingMatch[2].trimEnd() : null;
    if (atxRaw !== null && atxRaw[atxRaw.length - 1] === '#') {
      let i = atxRaw.length - 1;
      while (i >= 0 && atxRaw[i] === '#') i--;
      if (i >= 0 && (atxRaw[i] === ' ' || atxRaw[i] === '\t')) atxRaw = atxRaw.slice(0, i);
    }
    const rawName = atxRaw !== null ? atxRaw : (htmlHeadingMatch ? htmlHeadingMatch![2] : line.trim());
    const name = cleanHeadingName(rawName);
    if (!name) continue;
    const lineNum = i + 1;

    if (setextLevel !== null) i++; // skip the underline line

    // Find nearest ancestor at a shallower level
    let container: string | null = null;
    for (let l = level - 1; l >= 1; l--) {
      if (headingStack[l] !== null) {
        container = headingStack[l];
        break;
      }
    }

    // Reset all deeper levels when a heading resets scope
    for (let l = level; l <= 6; l++) headingStack[l] = null;
    headingStack[level] = name;

    entities.push({ name, kind: 'heading', lineStart: lineNum, lineEnd: lineNum, language, container: container ?? undefined });
    relationships.push({ srcName: container ?? fileName, dstName: name, predicate: 'CONTAINS' });
    headingLines.push({ level, name, lineNum, container });
  }

  // Build one section chunk per heading spanning to the line before the next heading at the same or
  // shallower level. This ensures parent sections contain their nested sub-sections' content.
  for (let h = 0; h < headingLines.length; h++) {
    const { level: currentLevel, name, lineNum, container } = headingLines[h];
    let nextLineNum = sourceLineCount;
    for (let k = h + 1; k < headingLines.length; k++) {
      if (headingLines[k].level <= currentLevel) {
        nextLineNum = headingLines[k].lineNum - 1;
        break;
      }
    }
    const startByte = lineStarts[lineNum - 1] ?? 0;
    const endByte = nextLineNum < lines.length ? (lineStarts[nextLineNum] ?? source.length) : source.length;
    const sectionContent = lines.slice(lineNum - 1, nextLineNum).join('\n');
    chunks.push({
      name,
      chunkKind: 'section',
      lineStart: lineNum,
      lineEnd: nextLineNum,
      startByte,
      endByte,
      contentHash: crypto.createHash('sha256').update(sectionContent).digest('hex'),
      language,
      container: container ?? undefined,
    });
  }

  // Bug 1 fix: emit file_body when no section chunks exist, regardless of frontmatter chunk
  if (headingLines.length === 0) {
    const bodyLineStart = startLine + 1;
    const bodyStartByte = lineStarts[startLine] ?? 0;
    const bodyContent = source.slice(bodyStartByte);
    chunks.push({
      name: null,
      chunkKind: 'file_body',
      lineStart: bodyLineStart,
      lineEnd: Math.max(sourceLineCount, 1),
      startByte: bodyStartByte,
      endByte: source.length,
      contentHash: crypto.createHash('sha256').update(bodyContent).digest('hex'),
      language,
    });
  }

  return { filePath, language, entities, chunks, relationships, fileRole };
}

function parseDockerfileFile(filePath: string, source: string): FileParseResult {
  const language = SupportedLanguages.Dockerfile;
  const fileName = nodePath.basename(filePath);
  const sourceLineCount = countSourceLines(source);
  const fileRole = classifyFileRole(filePath);
  const entities: ParsedEntity[] = [
    { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
  ];
  const chunks: ParsedChunk[] = [];
  const relationships: ParsedRelationship[] = [];
  const lines = source.split(/\r?\n/);
  const lineStarts = computeLineStarts(source);
  const stageNames: string[] = [];
  let pending = '';
  let logicalStartLine = 1;

  const pushChunk = (
    name: string | null,
    chunkKind: string,
    lineStart: number,
    lineEnd: number,
    startByte: number,
    endByte: number,
    content: string,
    container?: string,
  ) => {
    chunks.push({
      name,
      chunkKind,
      lineStart,
      lineEnd,
      startByte,
      endByte,
      contentHash: crypto.createHash('sha256').update(content).digest('hex'),
      language,
      container,
    });
  };

  const addInstruction = (instructionLine: string, lineStart: number, lineEnd: number) => {
    const trimmed = instructionLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const instructionMatch = /^([A-Z]+)\b(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (!instructionMatch) return;

    const keyword = instructionMatch[1].toUpperCase();
    const argument = (instructionMatch[2] ?? '').trim();
    const startByte = lineStarts[lineStart - 1] ?? 0;
    const endByte = lineEnd < lines.length
      ? (lineStarts[lineEnd] ?? source.length) - 1
      : source.length;

    if (keyword === 'FROM') {
      const fromMatch = /^([^\s]+)(?:\s+AS\s+([A-Za-z0-9._-]+))?/i.exec(argument);
      const baseImage = fromMatch?.[1] ?? argument;
      const stageName = fromMatch?.[2] ?? `stage-${stageNames.length}`;
      stageNames.push(stageName);

      entities.push({
        name: stageName,
        kind: 'config',
        lineStart,
        lineEnd,
        language,
      });
      relationships.push({
        srcName: fileName,
        dstName: stageName,
        predicate: 'CONTAINS',
      });
      pushChunk(stageName, 'build_stage', lineStart, lineEnd, startByte, endByte, instructionLine);

      if (baseImage) {
        entities.push({
          name: baseImage,
          kind: 'module',
          lineStart,
          lineEnd,
          language,
          container: stageName,
        });
        relationships.push({
          srcName: stageName,
          dstName: baseImage,
          predicate: 'IMPORTS',
        });
      }
      return;
    }

    const scope = stageNames[stageNames.length - 1];
    const entityName =
      keyword === 'COPY' || keyword === 'ADD'
        ? `${keyword.toLowerCase()}:${argument.split(/\s+/).find(token => token.length > 0) ?? keyword.toLowerCase()}`
        : keyword.toLowerCase();

    entities.push({
      name: entityName,
      kind: 'config_entry',
      lineStart,
      lineEnd,
      language,
      container: scope,
    });
    relationships.push({
      srcName: scope ?? fileName,
      dstName: entityName,
      predicate: 'CONTAINS',
    });
    pushChunk(entityName, 'docker_instruction', lineStart, lineEnd, startByte, endByte, instructionLine, scope);

    if (keyword === 'COPY') {
      const fromFlag = /--from=([^\s]+)/i.exec(argument)?.[1];
      if (fromFlag) {
        relationships.push({
          srcName: scope ?? fileName,
          dstName: fromFlag,
          predicate: 'IMPORTS',
        });
      }
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmedEnd = line.trimEnd();
    const lineContent = pending ? `${pending}\n${line}` : line;
    if (!pending) logicalStartLine = index + 1;

    if (trimmedEnd.endsWith('\\')) {
      pending = lineContent.slice(0, lineContent.lastIndexOf('\\')).trimEnd();
      continue;
    }

    addInstruction(lineContent, logicalStartLine, index + 1);
    pending = '';
  }

  if (pending) {
    addInstruction(pending, logicalStartLine, lines.length);
  }

  if (chunks.length === 0) {
    pushChunk(null, 'file_body', 1, Math.max(sourceLineCount, 1), 0, source.length, source);
  }

  return {
    filePath,
    language,
    entities,
    chunks,
    relationships,
    fileRole,
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Strip -- line comments and /* block comments *\/ from SQL source. */
function stripSqlComments(source: string): string {
  // Block comments: use indexOf to avoid ReDoS from regex backtracking
  let result = '';
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf('/*', i);
    if (start === -1) { result += source.slice(i); break; }
    result += source.slice(i, start);
    const end = source.indexOf('*/', start + 2);
    if (end === -1) { result += source.slice(start).replace(/[^\n]/g, ' '); break; }
    result += source.slice(start, end + 2).replace(/[^\n]/g, ' ');
    i = end + 2;
  }
  // Line comments: [^\n]* is always linear (no backtracking possible)
  return result.replace(/--[^\n]*/g, match => ' '.repeat(match.length));
}

/** Extract unquoted table/view names following FROM, JOIN variants, INTO, UPDATE, REFERENCES. */
function extractSqlTableRefs(sql: string): string[] {
  const refs = new Set<string>();
  // FROM tbl, JOIN tbl, INTO tbl, UPDATE tbl, REFERENCES tbl
  const refPattern =
    /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|INTO|UPDATE|REFERENCES)\s+([A-Za-z0-9_.`"[\]]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = refPattern.exec(sql)) !== null) {
    refs.add(m[1].replace(/[`"[\]]/g, ''));
  }
  return [...refs];
}

function parseJsonFile(filePath: string, source: string): FileParseResult {
  const language = SupportedLanguages.JSON;
  const fileName = nodePath.basename(filePath);
  const sourceLineCount = countSourceLines(source);
  const fileRole = classifyFileRole(filePath);
  const entities: ParsedEntity[] = [
    { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
  ];
  const chunks: ParsedChunk[] = [];
  const relationships: ParsedRelationship[] = [];

  // Walk the parsed JSON value, emitting one entity+chunk per object key.
  // `path` is the fully qualified key ancestry for the current object.
  const walk = (
    value: unknown,
    path: string,
    lineHint: number,
  ): void => {
    if (value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, path, lineHint);
      }
      return;
    }

    for (const key of Object.keys(value as Record<string, unknown>)) {
      const fullPath = path ? `${path}.${key}` : key;
      entities.push({
        name: key,
        kind: 'config_entry',
        lineStart: lineHint,
        lineEnd: lineHint,
        language,
        container: path || undefined,
      });
      chunks.push({
        name: key,
        chunkKind: 'config_key',
        lineStart: lineHint,
        lineEnd: lineHint,
        startByte: 0,
        endByte: 0,
        contentHash: crypto
          .createHash('sha256')
          .update(`${fullPath}=${JSON.stringify((value as Record<string, unknown>)[key])}`)
          .digest('hex'),
        language,
        container: path || undefined,
      });
      relationships.push({
        srcName: path || fileName,
        dstName: key,
        predicate: 'CONTAINS',
      });
      walk((value as Record<string, unknown>)[key], fullPath, lineHint);
    }
  };

  try {
    const parsed: unknown = JSON.parse(source);
    walk(parsed, '', 1);
  } catch {
    // Unparseable JSON: fall through to file_body chunk below
  }

  if (chunks.length === 0) {
    chunks.push({
      name: null,
      chunkKind: 'file_body',
      lineStart: 1,
      lineEnd: Math.max(sourceLineCount, 1),
      startByte: 0,
      endByte: source.length,
      contentHash: crypto.createHash('sha256').update(source).digest('hex'),
      language,
    });
  }

  return { filePath, language, entities, chunks, relationships, fileRole };
}

function parseSqlFile(filePath: string, source: string): FileParseResult {
  const language = SupportedLanguages.SQL;
  const fileName = nodePath.basename(filePath);
  const sourceLineCount = countSourceLines(source);
  const fileRole = classifyFileRole(filePath);
  const entities: ParsedEntity[] = [
    { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
  ];
  const chunks: ParsedChunk[] = [];
  const relationships: ParsedRelationship[] = [];
  const lineStarts = computeLineStarts(source);
  const lines = source.split(/\r?\n/);
  const stripped = stripSqlComments(source);
  const strippedLines = stripped.split(/\r?\n/);

  // Matches: CREATE [OR REPLACE] [TEMP[ORARY]] [UNIQUE] <TYPE> [IF NOT EXISTS] <name>
  const createRe =
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|PROC|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_.`"[\]]+)/i;

  // For INDEX ... ON tableName
  const indexOnRe = /\bON\s+([A-Za-z0-9_.`"[\]]+)/i;

  let statementLines: number[] = [];  // line indices (0-based) belonging to current statement
  let currentCreate: { kind: string; name: string; lineStart: number } | null = null;

  const flushStatement = (endLineIdx: number) => {
    if (!currentCreate) return;
    const lineEnd = endLineIdx + 1;
    const startByte = lineStarts[currentCreate.lineStart - 1] ?? 0;
    const endByte =
      lineEnd < lines.length ? (lineStarts[lineEnd] ?? source.length) - 1 : source.length;
    const statementText = strippedLines
      .slice(currentCreate.lineStart - 1, lineEnd)
      .join('\n');
    const rawContent = lines.slice(currentCreate.lineStart - 1, lineEnd).join('\n');

    const objType = currentCreate.kind.toUpperCase();
    const entityKind =
      objType === 'TABLE' ? 'table'
      : objType === 'VIEW' ? 'view'
      : objType === 'INDEX' ? 'config_entry'
      : 'function'; // FUNCTION, PROCEDURE, PROC, TRIGGER
    const chunkKind =
      objType === 'TABLE' ? 'create_table'
      : objType === 'VIEW' ? 'create_view'
      : objType === 'INDEX' ? 'create_index'
      : objType === 'TRIGGER' ? 'create_trigger'
      : 'create_function';

    entities.push({
      name: currentCreate.name,
      kind: entityKind,
      lineStart: currentCreate.lineStart,
      lineEnd,
      language,
    });
    chunks.push({
      name: currentCreate.name,
      chunkKind,
      lineStart: currentCreate.lineStart,
      lineEnd,
      startByte,
      endByte,
      contentHash: crypto.createHash('sha256').update(rawContent).digest('hex'),
      language,
    });
    relationships.push({ srcName: fileName, dstName: currentCreate.name, predicate: 'CONTAINS' });

    if (objType === 'INDEX') {
      // REFERENCES the table the index is ON
      const onMatch = indexOnRe.exec(statementText);
      if (onMatch) {
        relationships.push({
          srcName: currentCreate.name,
          dstName: onMatch[1].replace(/[`"[\]]/g, ''),
          predicate: 'REFERENCES',
        });
      }
    } else if (objType !== 'TABLE') {
      // Views, functions, procedures, triggers: extract table refs from body
      for (const ref of extractSqlTableRefs(statementText)) {
        if (ref !== currentCreate.name) {
          relationships.push({ srcName: currentCreate.name, dstName: ref, predicate: 'REFERENCES' });
        }
      }
    }

    currentCreate = null;
  };

  for (let i = 0; i < strippedLines.length; i++) {
    const line = strippedLines[i];

    if (!currentCreate) {
      const m = createRe.exec(line);
      if (m) {
        currentCreate = {
          kind: m[1],
          name: m[2].replace(/[`"[\]]/g, ''),
          lineStart: i + 1,
        };
      }
    }

    if (currentCreate && /;/.test(line)) {
      flushStatement(i);
    }
  }

  if (chunks.length === 0) {
    chunks.push({
      name: null,
      chunkKind: 'file_body',
      lineStart: 1,
      lineEnd: Math.max(sourceLineCount, 1),
      startByte: 0,
      endByte: source.length,
      contentHash: crypto.createHash('sha256').update(source).digest('hex'),
      language,
    });
  }

  return { filePath, language, entities, chunks, relationships, fileRole };
}

// ---------------------------------------------------------------------------
// Rust: cfg macro unwrapping
// ---------------------------------------------------------------------------

/**
 * Blanks out feature-gating macro wrappers in Rust source so that the items
 * inside become visible to tree-sitter as top-level declarations.
 *
 * Replaces `cfg_rt! { ... }` (and similar) with the body contents in-place,
 * preserving every character position and line number so that entity line
 * numbers remain accurate.
 */
// Pre-compiled for blanking macro headers (preserves newlines, replaces all else with space)
const _blankNonNewline = /[^\n]/g;

function unwrapRustCfgMacros(source: string): string {
  const re = /\bcfg_(?:rt_multi_thread|not_rt|rt|io|time|sync|net|fs|process|signal)!\s*\{/g;
  // Collect edit regions before mutating anything
  const edits: Array<[number, number, number]> = []; // [macroStart, openBrace, closeBrace]
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const openBrace = m.index + m[0].length - 1;
    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        if (--depth === 0) { closeBrace = i; break; }
      }
    }
    if (closeBrace !== -1) edits.push([m.index, openBrace, closeBrace]);
  }
  if (edits.length === 0) return source;

  // Build result from slices — avoids O(n) split('') allocation of N small string objects
  const parts: string[] = [];
  let pos = 0;
  for (const [macroStart, openBrace, closeBrace] of edits) {
    if (macroStart > pos) parts.push(source.slice(pos, macroStart));
    // Blank macro name + opening brace (preserve newlines)
    parts.push(source.slice(macroStart, openBrace + 1).replace(_blankNonNewline, ' '));
    pos = openBrace + 1;
    // Keep everything inside the braces unchanged
    if (closeBrace > pos) parts.push(source.slice(pos, closeBrace));
    // Blank closing brace
    parts.push(' ');
    pos = closeBrace + 1;
  }
  if (pos < source.length) parts.push(source.slice(pos));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

export function parseFile(filePath: string, source: string): FileParseResult | null {
  const language = detectLanguageForSource(filePath, source);
  if (!language) return null;
  if (language === SupportedLanguages.YAML) return parseYamlFile(filePath, source);
  if (language === SupportedLanguages.Dockerfile) return parseDockerfileFile(filePath, source);
  if (language === SupportedLanguages.SQL) return parseSqlFile(filePath, source);
  if (language === SupportedLanguages.JSON) return parseJsonFile(filePath, source);
  if (language === SupportedLanguages.TOML) return parseTomlFile(filePath, source);
  if (language === SupportedLanguages.Markdown) return parseMarkdownFile(filePath, source);

  // TypeScript TSX uses a separate grammar
  const isTsx = filePath.endsWith('.tsx');
  const grammar = isTsx ? TypeScript.tsx : GRAMMAR_MAP[language];
  if (!grammar) return null;

  const queries = LANGUAGE_QUERIES[language];
  if (!queries) return null;

  try {
    const parser = getParser();
    if (grammar !== _currentGrammar) {
      parser.setLanguage(grammar);
      _currentGrammar = grammar;
    }
    // tree-sitter-java cannot parse array-type annotations on varargs params
    // (e.g. `@Nullable Object @Nullable ... args`). The second annotation causes
    // error recovery to truncate the enclosing class_declaration, orphaning all
    // subsequent methods. Strip any @Annotation immediately before `...` in-memory
    // so the class body parses correctly.
    let parseSource = language === SupportedLanguages.Java
      ? source.replace(/@\w+\s*(?=\.\.\.)/g, '')
      : source;

    // Rust: unwrap feature-gating macros (cfg_rt! { ... }, cfg_io! { ... }, etc.)
    // These macros are transparent pass-throughs — their bodies contain normal items
    // that tree-sitter cannot see because they are parsed as raw token_tree nodes.
    // We blank out the macro call and matching closing brace in-place (preserving
    // character positions and line numbers) so the inner items become top-level.
    if (language === SupportedLanguages.Rust) {
      parseSource = unwrapRustCfgMacros(parseSource);
    }
    const tree = parser.parse(parseSource, undefined, { bufferSize: parseSource.length + 1 });
    const cacheKey = isTsx ? 'tsx' as const : language;
    const query = getCachedQuery(cacheKey, grammar, queries);
    const matches = query.matches(tree.rootNode);

    // Pre-partition matches so each pass only iterates its relevant subset.
    // Pass 1: definitions, heritage, and language-specific type hints.
    // Pass 2: imports, calls, type references.
    // Without this, every definition match does 5 useless find() calls in pass 2,
    // and every call match does 4 useless find() calls in pass 1.
    const pass1Matches: any[] = [];
    const pass2Matches: any[] = [];
    for (const m of matches) {
      let isPass1 = false;
      for (const c of m.captures) {
        const n = c.name;
        if (n.startsWith('definition.') || n.startsWith('heritage.') ||
            n === '_typed_param_scope' || n === '_assign_scope' || n === '_typed_var_scope') {
          isPass1 = true;
          break;
        }
      }
      (isPass1 ? pass1Matches : pass2Matches).push(m);
    }

    const fileName = nodePath.basename(filePath);
    const sourceLineCount = countSourceLines(source);

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
    // Python: map function name → (param name → declared type) for typed-parameter qualifier substitution
    const paramTypeMap = new Map<string, Map<string, string>>();
    // Python: map function name → (variable name → assigned type) for untyped-param qualifier substitution
    const assignTypeMap = new Map<string, Map<string, string>>();
    // C/C++: map enclosing scope → (variable/member name → declared type)
    const declaredTypeMap = new Map<string, Map<string, string>>();
    // Import aliases keyed by the in-file alias name (Go explicit aliases, etc.).
    const importAliases: Record<string, string> = {};

    // --- First pass: collect definitions ---
    for (const match of pass1Matches) {
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

        // Containment: file CONTAINS or class CONTAINS.
        // For Go methods the receiver type IS the container — methods are defined
        // outside the struct body so findEnclosing() always returns null for them.
        // The receiver.type capture (emitted by the Go method queries) overrides this.
        const enclosing = findEnclosing(classRanges, lineStart, name);
        const receiverCapture = match.captures.find((c: any) => c.name === 'receiver.type');
        // heritageClassCapture is set by the Go interface method query, where @heritage.class
        // captures the interface name and serves as the container (like receiver.type for structs).
        const heritageClassCapture = match.captures.find((c: any) => c.name === 'heritage.class');
        const effectiveContainer = (receiverCapture && kind === 'method')
          ? receiverCapture.node.text
          : (heritageClassCapture && kind === 'method')
          ? heritageClassCapture.node.text
          : (enclosing ?? undefined);

        entities.push({
          name,
          kind,
          lineStart,
          lineEnd,
          language,
          container: effectiveContainer,
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

        if (effectiveContainer) {
          relationships.push({ srcName: effectiveContainer, dstName: name, predicate: 'CONTAINS' });
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

      // Python typed parameters: build paramTypeMap for qualifier substitution in the second pass.
      // Maps function name → (param name → declared type) so that e.g. `query: Query` lets us
      // rewrite `query.filter(...)` → `Query.filter` when building effectiveCallee.
      if (language === SupportedLanguages.Python) {
        const typedParamScope = match.captures.find((c: any) => c.name === '_typed_param_scope');
        const typedParamName = match.captures.find((c: any) => c.name === '_typed_param_name');
        const typedParamType = match.captures.find((c: any) => c.name === '_typed_param_type');
        if (typedParamScope && typedParamName && typedParamType) {
          const funcName = typedParamScope.node.childForFieldName?.('name')?.text as string | undefined;
          if (funcName) {
            if (!paramTypeMap.has(funcName)) paramTypeMap.set(funcName, new Map());
            paramTypeMap.get(funcName)!.set(typedParamName.node.text, typedParamType.node.text);
          }
          continue;
        }

        // Assignment tracking: x = SomeClass() or x = Model.objects.method()
        const assignScope = match.captures.find((c: any) => c.name === '_assign_scope');
        const assignLhs = match.captures.find((c: any) => c.name === '_assign_lhs');
        const assignRhsType = match.captures.find((c: any) => c.name === '_assign_rhs_type');
        if (assignScope && assignLhs && assignRhsType) {
          // Only track PascalCase RHS names (constructors by convention).
          // Lowercase function calls like `select(...)` or `create_engine(...)` are skipped
          // to avoid cross-module false edges (e.g. orm.query → select.where in SQLAlchemy).
          const rhsName = assignRhsType.node.text;
          if (/^[A-Z]/.test(rhsName)) {
            const funcName = assignScope.node.childForFieldName?.('name')?.text as string | undefined;
            if (funcName) {
              if (!assignTypeMap.has(funcName)) assignTypeMap.set(funcName, new Map());
              assignTypeMap.get(funcName)!.set(assignLhs.node.text, rhsName);
            }
          }
          continue;
        }
      }

      // C/C++ typed declarations: capture local vars, parameters, and fields so that
      // member calls like current->Get(...) can be rewritten to Version.Get.
      if (language === SupportedLanguages.C || language === SupportedLanguages.CPlusPlus) {
        const typedVarScope = match.captures.find((c: any) => c.name === '_typed_var_scope');
        const typedVarName = match.captures.find((c: any) => c.name === '_typed_var_name');
        const typedVarType = match.captures.find((c: any) => c.name === '_typed_var_type');
        if (typedVarScope && typedVarName && typedVarType) {
          const line = typedVarScope.node.startPosition.row + 1;
          const scope =
            findEnclosingFunction(entities, line)
            ?? findEnclosing(classRanges, line, '')
            ?? fileName;
          if (!declaredTypeMap.has(scope)) declaredTypeMap.set(scope, new Map());
          declaredTypeMap.get(scope)!.set(typedVarName.node.text, typedVarType.node.text);
          continue;
        }
      }
    }

    // --- Second pass: calls and imports ---
    for (const match of pass2Matches) {
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
        const modName = normalizeCapturedImport(importSource.node.text, language);
        const importAlias = match.captures.find((c: any) => c.name === 'import.alias')?.node.text;
        if (importAlias && modName && importAlias !== '.' && importAlias !== '_') {
          importAliases[importAlias] = modName;
        }
        if (modName.length > 0 && modName !== '*') {
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
        if (!callee || callee.length <= 1) continue;

        // If a _qualifier capture is present (field_expression / stable_identifier
        // patterns like NodeKind.Decision, or Python attribute calls like
        // Session.execute), emit the fully qualified name so that resolution can use
        // the qualifier to break ties between same-named symbols in different files.
        // BUILTINS filtering is skipped for attribute calls: method names like
        // `filter` or `map` are Python builtins when called bare, but are valid
        // user-defined method calls when invoked as `query.filter(...)`.
        const qualifierCapture = match.captures.find((c: any) => c.name === '_qualifier');
        if (builtinsForLanguage(language).has(callee) && !qualifierCapture) continue;

        // For Python: skip calls that are decorator applications.
        // When a method is decorated (e.g. @util.deprecated(...)), the call sits at the
        // class-body line before the def, so findEnclosingFunction misses the method and
        // the caller falls back to the enclosing class — producing false edges like
        // Table → deprecated.  Decorator application is not an architectural CALLS edge.
        if (language === SupportedLanguages.Python) {
          let isDecoratorCall = false;
          let anc = callName.node.parent;
          while (anc) {
            if (anc.type === 'decorator') { isDecoratorCall = true; break; }
            if (anc.type === 'module' || anc.type === 'function_definition' || anc.type === 'class_definition') break;
            anc = anc.parent;
          }
          if (isDecoratorCall) continue;
        }

        // Find enclosing function/method for the call; fall back to enclosing class
        // (e.g. calls in val/lazy val body at class level) before falling back to file.
        const callLine = callName.node.startPosition.row + 1;
        const caller = findEnclosingFunction(entities, callLine)
          ?? findEnclosing(classRanges, callLine, '')
          ?? fileName;

        const scope = caller;
        if (!seenCalls.has(scope)) seenCalls.set(scope, new Set());
        const seen = seenCalls.get(scope)!;

        const effectiveCallee = (() => {
          if (!qualifierCapture) {
            // Python: if the callee is a local alias for a class, substitute the class name.
            // e.g. engineclass = base.Engine; engineclass(pool, ...) → Engine(pool, ...)
            if (language === SupportedLanguages.Python) {
              const funcName = findEnclosingFunction(entities, callLine);
              if (funcName) {
                const typeForAssign = assignTypeMap.get(funcName)?.get(callee);
                if (typeForAssign) return typeForAssign;
              }
            }
            return callee;
          }
          let qualifier = qualifierCapture.node.text;
          // Python: 'self'/'cls' always refers to the enclosing class — substitute it
          // so the edge reads 'Query.filter' instead of 'self.filter', enabling
          // same-file resolution without type inference.
          if (language === SupportedLanguages.Python && (qualifier === 'self' || qualifier === 'cls')) {
            const enclosingClass = findEnclosing(classRanges, callLine, '');
            if (enclosingClass) qualifier = enclosingClass;
          } else if (qualifier === 'this') {
            // JS/TS: 'this' inside a class method refers to the enclosing class.
            // Substitute so e.g. `this.save()` → `Document.save` instead of `this.save`.
            const enclosingClass = findEnclosing(classRanges, callLine, '');
            if (enclosingClass) qualifier = enclosingClass;
          } else if (language === SupportedLanguages.Python) {
            // Typed-parameter substitution: if the qualifier is a param with a declared type,
            // use the type name so e.g. `query.filter(...)` → `Query.filter`.
            // Also check assignTypeMap for variables assigned from constructor/ORM calls.
            const funcName = findEnclosingFunction(entities, callLine);
            if (funcName) {
              const typeForParam = paramTypeMap.get(funcName)?.get(qualifier);
              const typeForAssign = assignTypeMap.get(funcName)?.get(qualifier);
              if (typeForParam) qualifier = typeForParam;
              else if (typeForAssign) qualifier = typeForAssign;
            }
          } else if (language === SupportedLanguages.C || language === SupportedLanguages.CPlusPlus) {
            const funcName = findEnclosingFunction(entities, callLine) ?? fileName;
            const className = findEnclosing(classRanges, callLine, '')
              ?? (funcName.includes('.') ? funcName.slice(0, funcName.lastIndexOf('.')) : undefined);
            const typeForDecl =
              declaredTypeMap.get(funcName)?.get(qualifier)
              ?? (className ? declaredTypeMap.get(className)?.get(qualifier) : undefined)
              ?? declaredTypeMap.get(fileName)?.get(qualifier);
            if (typeForDecl) qualifier = typeForDecl;
          }
          return `${qualifier}.${callee}`;
        })();

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

        // Prefer the enclosing function/method so parameter and return-type references
        // point back to the actual caller. Fall back to class, then file.
        const refLine = refType.node.startPosition.row + 1;
        const src = findEnclosingFunction(entities, refLine)
          ?? findEnclosing(classRanges, refLine, typeName)
          ?? fileName;

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

    return {
      filePath,
      language,
      entities,
      chunks,
      relationships,
      importAliases: Object.keys(importAliases).length > 0 ? importAliases : undefined,
      fileRole: classifyFileRole(filePath, source),
    };
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
  preferredQKey?: string,
): string | null {
  const qks = [...new Set(fileQKeys.get(filePath)?.get(plainName) ?? [])];
  if (preferredQKey && qks.includes(preferredQKey)) return preferredQKey;
  return qks.length === 1 ? qks[0] : null;
}

// ---------------------------------------------------------------------------
// Global resolution index — pre-scan for cross-batch edge resolution
// ---------------------------------------------------------------------------

export interface GlobalResolutionIndex {
  fileHasSymbol:    Map<string, Set<string>>;
  fileQKeys:        Map<string, Map<string, string[]>>;
  symbolToFiles:    Map<string, string[]>;
  stemToFiles:      Map<string, string[]>;
  dirToIndexFiles:  Map<string, string[]>;
  packageToFiles:   Map<string, string[]>;
  goPkgDirToFiles:  Map<string, string[]>;
  goPkgPathToFiles: Map<string, string[]>;
}

/**
 * Build a GlobalResolutionIndex from a list of file paths (and optional source
 * texts for entity extraction). Covers the entire repository so that each
 * streaming batch can resolve edges pointing to files outside the batch.
 */
export function buildGlobalResolutionIndex(
  filePaths: string[],
  sources?: Map<string, string>,
): GlobalResolutionIndex {
  const stemToFiles = new Map<string, string[]>();
  const dirToIndexFiles = new Map<string, string[]>();
  const packageToFiles = new Map<string, string[]>();
  const goPkgDirToFiles = new Map<string, string[]>();
  const goPkgPathToFiles = new Map<string, string[]>();

  for (const fp of filePaths) {
    const ext = nodePath.extname(fp);
    const stem = nodePath.basename(fp, ext);

    // stemToFiles
    const stemList = stemToFiles.get(stem) ?? [];
    stemList.push(fp);
    stemToFiles.set(stem, stemList);

    // dirToIndexFiles
    if (stem === 'index') {
      const dirName = nodePath.basename(nodePath.dirname(fp));
      const dirList = dirToIndexFiles.get(dirName) ?? [];
      dirList.push(fp);
      dirToIndexFiles.set(dirName, dirList);
    }

    // packageToFiles (Scala/Java)
    if (ext === '.scala' || ext === '.java') {
      const dir = nodePath.dirname(fp);
      const parts = dir.split(/[/\\]/);
      const maxDepth = Math.min(8, parts.length);
      for (let i = parts.length - 1; i >= parts.length - maxDepth; i--) {
        const pkg = parts.slice(i).join('.');
        const list = packageToFiles.get(pkg) ?? [];
        list.push(fp);
        packageToFiles.set(pkg, list);
      }
    }

    // goPkgDirToFiles / goPkgPathToFiles (Go)
    if (ext === '.go') {
      const dirName = nodePath.basename(nodePath.dirname(fp));
      const goDirList = goPkgDirToFiles.get(dirName) ?? [];
      goDirList.push(fp);
      goPkgDirToFiles.set(dirName, goDirList);

      const parts = nodePath.dirname(fp).replace(/\\/g, '/').split('/').filter(Boolean);
      const maxDepth = Math.min(8, parts.length);
      for (let i = parts.length - 1; i >= parts.length - maxDepth; i--) {
        const pkgPath = parts.slice(i).join('/');
        const pkgList = goPkgPathToFiles.get(pkgPath) ?? [];
        pkgList.push(fp);
        goPkgPathToFiles.set(pkgPath, pkgList);
      }
    }
  }

  // Entity maps (built from sources if provided, via fast regex scan)
  const fileQKeys = new Map<string, Map<string, string[]>>();
  const fileHasSymbol = new Map<string, Set<string>>();
  const symbolToFiles = new Map<string, string[]>();

  if (sources) {
    const pkgRe = /^package\s+(\w+)/m;
    const typeRe = /^type\s+([A-Z]\w*)\s+/gm;
    const funcRe = /^func\s+([A-Z]\w*)\s*[(\[]/gm;
    const methodRe = /^func\s+\([^)]+\)\s+([A-Z]\w*)\s*[(\[]/gm;

    for (const [fp, src] of sources) {
      if (nodePath.extname(fp) !== '.go') continue;

      const qkMap = new Map<string, string[]>();

      // Package name — critical for qualifier-assisted REFERENCES resolution
      const pkgMatch = pkgRe.exec(src);
      if (pkgMatch) {
        const name = pkgMatch[1];
        qkMap.set(name, [name]);
      }

      // Exported types (struct/interface/aliases/type defs)
      typeRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = typeRe.exec(src)) !== null) {
        const name = m[1];
        if (!qkMap.has(name)) qkMap.set(name, [name]);
      }

      // Exported top-level functions
      funcRe.lastIndex = 0;
      while ((m = funcRe.exec(src)) !== null) {
        const name = m[1];
        if (!qkMap.has(name)) qkMap.set(name, [name]);
      }

      // Exported methods (receiver form)
      methodRe.lastIndex = 0;
      while ((m = methodRe.exec(src)) !== null) {
        const name = m[1];
        if (!qkMap.has(name)) qkMap.set(name, [name]);
      }

      if (qkMap.size > 0) {
        fileQKeys.set(fp, qkMap);
        fileHasSymbol.set(fp, new Set(qkMap.keys()));
      }
    }

    // R: scan function definitions (name <- function(...))
    // Enables cross-batch Tier-3 resolution for large R repos (>500 files).
    const rFuncRe = /^([a-zA-Z_.][a-zA-Z0-9_.]*)\s*<-\s*function/gm;
    for (const [fp, src] of sources) {
      const ext = nodePath.extname(fp).toLowerCase();
      if (ext !== '.r') continue;
      const qkMap = new Map<string, string[]>();
      rFuncRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rFuncRe.exec(src)) !== null) {
        const name = m[1];
        if (!qkMap.has(name)) qkMap.set(name, [name]);
      }
      if (qkMap.size > 0) {
        fileQKeys.set(fp, qkMap);
        fileHasSymbol.set(fp, new Set(qkMap.keys()));
      }
    }

    for (const [fp, symbols] of fileHasSymbol) {
      for (const sym of symbols) {
        const list = symbolToFiles.get(sym) ?? [];
        list.push(fp);
        symbolToFiles.set(sym, list);
      }
    }
  }

  return {
    fileHasSymbol,
    fileQKeys,
    symbolToFiles,
    stemToFiles,
    dirToIndexFiles,
    packageToFiles,
    goPkgDirToFiles,
    goPkgPathToFiles,
  };
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
export function resolveEdges(
  results: FileParseResult[],
  stats?: {
    importLookups: number; transitiveLookups: number; globalFallbacks: number;
    globalCandidateTotal: number; resolvedImport: number; resolvedTransitive: number;
    resolvedGlobal: number; resolvedQualifier: number; skippedSameFile: number; skippedAmbiguous: number;
  },
  globalIndex?: GlobalResolutionIndex,
): ResolvedEdge[] {
  // Provide a default no-op stats bag when caller passes none (backward compat).
  if (!stats) stats = {
    importLookups: 0, transitiveLookups: 0, globalFallbacks: 0,
    globalCandidateTotal: 0, resolvedImport: 0, resolvedTransitive: 0,
    resolvedGlobal: 0, resolvedQualifier: 0, skippedSameFile: 0, skippedAmbiguous: 0,
  };
  // fileQKeys: seed from global index (cross-batch files), then batch entries override.
  // Mirrors the entityQKey computation in buildPatch so nodeIds match exactly.
  const fileQKeys = globalIndex
    ? new Map<string, Map<string, string[]>>(globalIndex.fileQKeys)
    : new Map<string, Map<string, string[]>>();
  for (const r of results) {
    const qkMap = new Map<string, string[]>();
    for (const e of r.entities) {
      if (e.kind === 'file' || e.kind === 'module') continue;
      const qk = qualifiedKey(e);
      const list = qkMap.get(e.name) ?? [];
      list.push(qk);
      qkMap.set(e.name, list);
    }
    fileQKeys.set(r.filePath, qkMap);  // overrides global entry if present
  }

  // fileHasSymbol: rebuilt from merged fileQKeys so per-batch overrides take effect.
  const fileHasSymbol = new Map<string, Set<string>>();
  for (const [fp, qkMap] of fileQKeys) {
    fileHasSymbol.set(fp, new Set(qkMap.keys()));
  }

  // resultsByPath: O(1) lookup replacing results.find() in transitive import loop
  const resultsByPath = new Map<string, FileParseResult>(results.map(r => [r.filePath, r]));

  // symbolToFiles: rebuilt from merged fileHasSymbol (not seeded directly — per-batch
  // overrides can change which files define a symbol).
  const symbolToFiles = new Map<string, string[]>();
  for (const [fp, symbols] of fileHasSymbol) {
    for (const sym of symbols) {
      const list = symbolToFiles.get(sym) ?? [];
      list.push(fp);
      symbolToFiles.set(sym, list);
    }
  }

  // fileLanguage: filePath → SupportedLanguages (fast language lookup without re-calling languageFromPath)
  const fileLanguage = new Map<string, SupportedLanguages>();
  for (const r of results) {
    fileLanguage.set(r.filePath, r.language);
  }

  // stemToFiles: seed from global index, then add batch entries.
  const stemToFiles = globalIndex
    ? new Map<string, string[]>(globalIndex.stemToFiles)
    : new Map<string, string[]>();
  for (const r of results) {
    const stem = nodePath.basename(r.filePath, nodePath.extname(r.filePath));
    const list = stemToFiles.get(stem) ?? [];
    if (!list.includes(r.filePath)) list.push(r.filePath);
    stemToFiles.set(stem, list);
  }

  // dirToIndexFiles: seed from global index, then add batch entries.
  const dirToIndexFiles = globalIndex
    ? new Map<string, string[]>(globalIndex.dirToIndexFiles)
    : new Map<string, string[]>();
  for (const r of results) {
    const stem = nodePath.basename(r.filePath, nodePath.extname(r.filePath));
    if (stem === 'index') {
      const dirName = nodePath.basename(nodePath.dirname(r.filePath));
      const list = dirToIndexFiles.get(dirName) ?? [];
      if (!list.includes(r.filePath)) list.push(r.filePath);
      dirToIndexFiles.set(dirName, list);
    }
  }

  // packageToFiles: seed from global index, then add batch entries.
  // e.g. "ix.memory.model" → all .scala files under .../ix/memory/model/
  const packageToFiles = globalIndex
    ? new Map<string, string[]>(globalIndex.packageToFiles)
    : new Map<string, string[]>();
  for (const r of results) {
    const ext = nodePath.extname(r.filePath);
    if (ext !== '.scala' && ext !== '.java') continue;
    const dir = nodePath.dirname(r.filePath);
    const parts = dir.split(/[/\\]/);
    const maxDepth = Math.min(8, parts.length);
    for (let i = parts.length - 1; i >= parts.length - maxDepth; i--) {
      const pkg = parts.slice(i).join('.');
      const list = packageToFiles.get(pkg) ?? [];
      if (!list.includes(r.filePath)) list.push(r.filePath);
      packageToFiles.set(pkg, list);
    }
  }

  // goPkgDirToFiles / goPkgPathToFiles: seed from global index, then add batch entries.
  const goPkgDirToFiles = globalIndex
    ? new Map<string, string[]>(globalIndex.goPkgDirToFiles)
    : new Map<string, string[]>();
  const goPkgPathToFiles = globalIndex
    ? new Map<string, string[]>(globalIndex.goPkgPathToFiles)
    : new Map<string, string[]>();
  for (const r of results) {
    if (nodePath.extname(r.filePath) !== '.go') continue;
    const dirName = nodePath.basename(nodePath.dirname(r.filePath));
    const list = goPkgDirToFiles.get(dirName) ?? [];
    if (!list.includes(r.filePath)) list.push(r.filePath);
    goPkgDirToFiles.set(dirName, list);
    const parts = nodePath.dirname(r.filePath).replace(/\\/g, '/').split('/').filter(Boolean);
    const maxDepth = Math.min(8, parts.length);
    for (let i = parts.length - 1; i >= parts.length - maxDepth; i--) {
      const pkgPath = parts.slice(i).join('/');
      const pkgList = goPkgPathToFiles.get(pkgPath) ?? [];
      if (!pkgList.includes(r.filePath)) pkgList.push(r.filePath);
      goPkgPathToFiles.set(pkgPath, pkgList);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  function normalizeImportTarget(modName: unknown): string {
    if (typeof modName === 'string') return modName;
    if (modName == null) return '';
    return String(modName);
  }

  /** Resolve a module name to matching file paths in the batch. */
  function modNameToFiles(modName: unknown, excludeFp: string): string[] {
    const normalizedModName = normalizeImportTarget(modName);
    if (!normalizedModName) return [];
    const fps: string[] = [];
    // Strip leading non-word chars for bare aliases: '@components' → 'components'
    const candidates = [normalizedModName];
    const stripped = normalizedModName.replace(/^[^a-zA-Z0-9_]+/, '');
    if (stripped && stripped !== normalizedModName) candidates.push(stripped);
    // Strip file extensions so "explain.js" resolves to the "explain" stem
    // (TS/JS ESM imports use .js extensions that map to .ts source files)
    const noExt = normalizedModName.replace(/\.(js|ts|mjs|cjs|jsx|tsx|py|scala|java|c|cc|cpp|cxx|h|hh|hpp|hxx)$/, '');
    if (noExt !== normalizedModName && noExt && !candidates.includes(noExt)) candidates.push(noExt);
    const pathBasename = nodePath.posix.basename(normalizedModName);
    if (pathBasename && !candidates.includes(pathBasename)) candidates.push(pathBasename);
    const pathBasenameNoExt = nodePath.posix.basename(noExt);
    if (pathBasenameNoExt && !candidates.includes(pathBasenameNoExt)) candidates.push(pathBasenameNoExt);
    // For dotted paths (Scala/Java: 'ix.memory.model.Edge'), also try last segment
    const lastDot = normalizedModName.lastIndexOf('.');
    if (lastDot !== -1) {
      const lastSegment = normalizedModName.slice(lastDot + 1);
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
    for (const fp of packageToFiles.get(normalizedModName) ?? []) {
      if (fp !== excludeFp && !fps.includes(fp)) fps.push(fp);
    }
    // Go package directory resolution: "etcdserver" → all .go files in .../etcdserver/
    // The last segment of a Go import path is the package directory name, not a file stem.
    for (const fp of goPkgDirToFiles.get(normalizedModName) ?? []) {
      if (fp !== excludeFp && !fps.includes(fp)) fps.push(fp);
    }
    const slashParts = normalizedModName.replace(/\\/g, '/').split('/').filter(Boolean);
    const maxSlashDepth = Math.min(8, slashParts.length);
    for (let i = 0; i < maxSlashDepth; i++) {
      const suffix = slashParts.slice(slashParts.length - 1 - i).join('/');
      for (const fp of goPkgPathToFiles.get(suffix) ?? []) {
        if (fp !== excludeFp && !fps.includes(fp)) fps.push(fp);
      }
    }
    return fps;
  }

  function goImportSuffixes(modName: unknown): string[] {
    const normalizedModName = normalizeImportTarget(modName);
    if (!normalizedModName) return [];
    const parts = normalizedModName.replace(/\\/g, '/').split('/').filter(Boolean);
    const suffixes: string[] = [];
    const maxDepth = Math.min(8, parts.length);
    for (let i = 0; i < maxDepth; i++) {
      suffixes.push(parts.slice(parts.length - 1 - i).join('/'));
    }
    return suffixes;
  }

  function pickGoPackageAnchor(files: string[]): string | null {
    if (files.length === 0) return null;
    const nonTestFiles = files.filter(fp => !fp.endsWith('_test.go'));
    const pool = nonTestFiles.length > 0 ? nonTestFiles : files;
    const dirName = nodePath.basename(nodePath.dirname(pool[0])).toLowerCase();

    const exactStemMatch = pool.filter(fp => candidateStem(fp) === dirName);
    if (exactStemMatch.length === 1) return exactStemMatch[0];

    const ranked = [...pool].sort((a, b) => {
      const aResult = resultsByPath.get(a);
      const bResult = resultsByPath.get(b);
      const aImports = aResult?.relationships.filter(rel => rel.predicate === 'IMPORTS').length ?? 0;
      const bImports = bResult?.relationships.filter(rel => rel.predicate === 'IMPORTS').length ?? 0;
      if (aImports !== bImports) return bImports - aImports;

      // Fall back to global index entity count for cross-batch files (not in resultsByPath).
      // fileQKeys is seeded from buildGlobalResolutionIndex which pre-scans exported
      // types/functions via regex, so substantive files like instance.go score higher
      // than package-doc stubs like doc.go (which only has the package name).
      const aEntities = aResult?.entities.length ?? fileQKeys.get(a)?.size ?? 0;
      const bEntities = bResult?.entities.length ?? fileQKeys.get(b)?.size ?? 0;
      if (aEntities !== bEntities) return bEntities - aEntities;

      return a.localeCompare(b);
    });
    return ranked[0] ?? null;
  }

  function narrowGoImportCandidates(
    srcFilePath: string,
    modName: unknown,
    importMatches: string[],
    pickFromSingleDir: (files: string[]) => string[],
  ): string[] {
    const suffixes = goImportSuffixes(modName);
    const scored = importMatches.map(fp => {
      const dirPath = nodePath.dirname(fp).replace(/\\/g, '/');
      let bestSuffixLen = -1;
      for (const suffix of suffixes) {
        if (dirPath === suffix || dirPath.endsWith(`/${suffix}`)) {
          if (suffix.length > bestSuffixLen) bestSuffixLen = suffix.length;
        }
      }
      return { fp, bestSuffixLen };
    });

    const bestSuffixLen = Math.max(...scored.map(item => item.bestSuffixLen));
    const narrowed = bestSuffixLen >= 0
      ? scored.filter(item => item.bestSuffixLen === bestSuffixLen).map(item => item.fp)
      : importMatches;

    const dirGroups = new Map<string, string[]>();
    for (const fp of narrowed) {
      const key = nodePath.dirname(fp).replace(/\\/g, '/');
      const list = dirGroups.get(key) ?? [];
      list.push(fp);
      dirGroups.set(key, list);
    }

    if (dirGroups.size === 1) return pickFromSingleDir([...dirGroups.values()][0]);
    return narrowed;
  }

  function resolveImportTargets(srcFilePath: string, srcLanguage: SupportedLanguages, modName: unknown): string[] {
    const importMatches = modNameToFiles(modName, srcFilePath);
    if (srcLanguage !== SupportedLanguages.Go || importMatches.length <= 1) return importMatches;
    return narrowGoImportCandidates(srcFilePath, modName, importMatches, files => {
      const anchor = pickGoPackageAnchor(files);
      return anchor ? [anchor] : [];
    });
  }

  function resolveImportQualifierTargets(srcFilePath: string, srcLanguage: SupportedLanguages, modName: unknown): string[] {
    const importMatches = modNameToFiles(modName, srcFilePath);
    if (srcLanguage !== SupportedLanguages.Go || importMatches.length <= 1) return importMatches;
    return narrowGoImportCandidates(srcFilePath, modName, importMatches, files => files);
  }

  function tokenizeSymbolParts(value: string): string[] {
    return value
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  const GENERIC_RESOLUTION_TOKENS = new Set([
    'run', 'job', 'file', 'files', 'table', 'tables', 'output', 'outputs',
    'input', 'inputs', 'background',
  ]);

  function candidateStem(filePath: string): string {
    return nodePath.basename(filePath, nodePath.extname(filePath)).toLowerCase();
  }

  function pickCallerAlignedCandidate(
    matches: string[],
    srcName: string,
    dstName: string,
  ): { chosen: string | null; best: Array<{ fp: string; overlap: number }> } | null {
    if (matches.length === 0) return null;
    const srcTokens = new Set(
      tokenizeSymbolParts(srcName).filter(token => !GENERIC_RESOLUTION_TOKENS.has(token)),
    );
    const overlapScores = matches.map(fp => {
      const qKeys = fileQKeys.get(fp)?.get(dstName) ?? [];
      const candidateTokens = new Set<string>(tokenizeSymbolParts(candidateStem(fp)));
      for (const qKey of qKeys) {
        for (const token of tokenizeSymbolParts(qKey)) candidateTokens.add(token);
      }
      let overlap = 0;
      for (const token of candidateTokens) {
        if (!GENERIC_RESOLUTION_TOKENS.has(token) && srcTokens.has(token)) overlap++;
      }
      return { fp, overlap };
    });
    const maxOverlap = Math.max(...overlapScores.map(x => x.overlap));
    if (maxOverlap <= 0) return null;
    const bestMatches = overlapScores.filter(x => x.overlap === maxOverlap);
    return {
      chosen: bestMatches.length === 1 ? bestMatches[0].fp : null,
      best: bestMatches,
    };
  }

  function narrowCCandidates(
    matches: string[],
    srcFilePath: string,
    srcLanguage: SupportedLanguages,
    srcName: string,
    dstName: string,
  ): string[] {
    if (matches.length <= 1) return matches;

    // C# partial class narrowing: multiple files may define the same class via
    // partial class (e.g. JsonReader.cs + JsonReader.Async.cs both define JsonReader).
    // Prefer the canonical file whose stem exactly matches the destination class name
    // over variant files that have additional dot-segments in the stem.
    if (srcLanguage === SupportedLanguages.CSharp) {
      const dstNameLower = dstName.toLowerCase();
      const canonicalMatches = matches.filter(fp => candidateStem(fp) === dstNameLower);
      if (canonicalMatches.length === 1) return canonicalMatches;
    }

    if (srcLanguage === SupportedLanguages.Java) {
      const srcParts = srcFilePath.replace(/\\/g, '/').split('/');
      const withProximity = matches.map(fp => {
        const fpParts = fp.replace(/\\/g, '/').split('/');
        let common = 0;
        while (common < srcParts.length && common < fpParts.length && srcParts[common] === fpParts[common]) {
          common++;
        }
        return { fp, common };
      });
      const maxCommon = Math.max(...withProximity.map(x => x.common));
      const proximityMatches = withProximity.filter(x => x.common === maxCommon).map(x => x.fp);
      if (proximityMatches.length === 1) return proximityMatches;
    }

    if (srcLanguage !== SupportedLanguages.C && srcLanguage !== SupportedLanguages.CPlusPlus) return matches;

    let narrowed = matches;
    const implExts = ['.c', '.cpp', '.cc', '.cxx'];
    const implMatches = narrowed.filter(fp => implExts.some(ext => fp.endsWith(ext)));
    if (implMatches.length === 1) narrowed = implMatches;

    if (narrowed.length <= 1) return narrowed;

    const srcParts = srcFilePath.replace(/\\/g, '/').split('/');
    const withProximity = narrowed.map(fp => {
      const fpParts = fp.replace(/\\/g, '/').split('/');
      let common = 0;
      while (common < srcParts.length && common < fpParts.length && srcParts[common] === fpParts[common]) {
        common++;
      }
      return { fp, common };
    });
    const maxCommon = Math.max(...withProximity.map(x => x.common));
    const proximityMatches = withProximity.filter(x => x.common === maxCommon).map(x => x.fp);
    if (proximityMatches.length === 1) return proximityMatches;

    const callerAligned = pickCallerAlignedCandidate(narrowed, srcName, dstName);
    if (callerAligned?.chosen) return [callerAligned.chosen];

    const callerAlignedCandidates = pickCallerAlignedCandidate(matches, srcName, dstName);
    if (callerAlignedCandidates?.best) {
      const implAlignedMatches = callerAlignedCandidates.best
        .map(match => match.fp)
        .filter(fp => ['.c', '.cpp', '.cc', '.cxx'].some(ext => fp.endsWith(ext)));
      if (implAlignedMatches.length === 1) return implAlignedMatches;
    }

    return narrowed;
  }

  // ── Main resolution loop ───────────────────────────────────────────


  function fileDefinesQualifiedMember(filePath: string, qualifierPart: string, memberPart: string): boolean {
    const qks = fileQKeys.get(filePath)?.get(memberPart) ?? [];
    return qks.includes(`${qualifierPart}.${memberPart}`);
  }

  const resolved: ResolvedEdge[] = [];

  for (const result of results) {
    const srcFilePath = result.filePath;
    const srcLanguage = result.language;
    const srcSymbols = fileHasSymbol.get(srcFilePath)!;

    // Build the set of file paths this file explicitly imports.
    const importedFilePaths = new Set<string>();
    for (const rel of result.relationships) {
      if (rel.predicate !== 'IMPORTS') continue;
      for (const fp of resolveImportTargets(srcFilePath, srcLanguage, rel.dstName)) {
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
        for (const transitiveFp of resolveImportTargets(fp, fpResult.language, rel.dstName)) {
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
        if (result.language === SupportedLanguages.Scala || result.language === SupportedLanguages.Java) {
          const dstName = rel.dstName;
          const lastDot = dstName.lastIndexOf('.');
          if (lastDot !== -1) {
            const entityName = dstName.slice(lastDot + 1);
            if (entityName && entityName !== '_') {
              const pkgPath = dstName.slice(0, lastDot);
              const pkgFiles = packageToFiles.get(pkgPath) ?? [];
              const matchFiles = pkgFiles.filter(fp => fp !== srcFilePath && fileHasSymbol.get(fp)?.has(entityName));
              if (matchFiles.length === 1) {
                const fp = matchFiles[0];
                const dstQualifiedKey = bestQKey(fileQKeys, fp, entityName);
                if (dstQualifiedKey !== null) {
                  resolved.push({ srcFilePath, srcName: rel.srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: 'IMPORTS', confidence: 0.9 });
                  stats.resolvedImport++;
                  continue;
                }
              }
            }
          }
        }

        const importMatches = resolveImportTargets(srcFilePath, result.language, rel.dstName);
        if (importMatches.length === 1) {
          const fp = importMatches[0];
          resolved.push({
            srcFilePath,
            srcName: rel.srcName,
            dstFilePath: fp,
            dstName: rel.dstName,
            dstQualifiedKey: fileEntityName(fp),
            predicate: 'IMPORTS',
            confidence: 0.9,
          });
          stats.resolvedImport++;
          continue;
        } else if (importMatches.length > 1) {
          stats.skippedAmbiguous++;
          continue;
        }
        // importMatches.length === 0: if dstName is a PascalCase symbol (class/function name
        // captured via import.name from "from X import ClassName"), fall through to Tier 2/3
        // symbol resolution so the edge connects to the actual class node rather than a file.
        if (srcLanguage !== SupportedLanguages.Python || !/^[A-Z]/.test(rel.dstName)) continue;
        // fall through to Tier 1b → Tier 2 → Tier 3 below
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
          const aliasedImportMatches =
            srcLanguage === SupportedLanguages.Go
              ? resolveImportQualifierTargets(srcFilePath, srcLanguage, result.importAliases?.[qualifierPart] ?? '')
              : [];
          // Try import-scoped qualifier first
          const qualifierSearchPool = aliasedImportMatches.length > 0
            ? aliasedImportMatches
            : [...importedFilePaths];
          const qualImportMatches: string[] = [];
          for (const fp of qualifierSearchPool) {
            if (fileDefinesQualifiedMember(fp, qualifierPart, memberPart) || fileHasSymbol.get(fp)?.has(qualifierPart)) {
              qualImportMatches.push(fp);
            }
          }
          if (qualImportMatches.length === 0 && aliasedImportMatches.length > 0) {
            for (const fp of aliasedImportMatches) {
              if (fileHasSymbol.get(fp)?.has(memberPart)) qualImportMatches.push(fp);
            }
          }
          if (qualImportMatches.length === 1) {
            const qfp = qualImportMatches[0];
            const preferredQKey = aliasedImportMatches.length > 0 ? undefined : `${qualifierPart}.${memberPart}`;
            if (fileHasSymbol.get(qfp)?.has(memberPart)) {
              const dstQualifiedKey = bestQKey(fileQKeys, qfp, memberPart, preferredQKey);
              if (dstQualifiedKey !== null) {
                // dstName must match rel.dstName so buildPatchWithResolution can look it up
                resolved.push({ srcFilePath, srcName, dstFilePath: qfp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.9 });
              }
            }
            continue;
          }
          // Global qualifier fallback — check files that define the qualified member
          const qualGlobalMatches = results
            .map(r => r.filePath)
            .filter(fp => fp !== srcFilePath && fileDefinesQualifiedMember(fp, qualifierPart, memberPart));
          if (qualGlobalMatches.length === 1) {
            const qfp = qualGlobalMatches[0];
            if (fileHasSymbol.get(qfp)?.has(memberPart)) {
              const dstQualifiedKey = bestQKey(fileQKeys, qfp, memberPart, `${qualifierPart}.${memberPart}`);
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
      const narrowedImportMatches = narrowCCandidates(importMatches, srcFilePath, srcLanguage, srcName, dstName);

      if (narrowedImportMatches.length === 1) {
        const fp = narrowedImportMatches[0];
        const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
        if (dstQualifiedKey === null) continue; // ambiguous — do not emit bad nodeId
        resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.9 });
        continue;
      }
      // Tier 2.5: transitive import-scoped (confidence 0.8) — one re-export hop away
      const transitiveMatches: string[] = [];
      for (const fp of transitiveFilePaths) {
        if (fileHasSymbol.get(fp)?.has(dstName)) transitiveMatches.push(fp);
      }
      const narrowedTransitiveMatches = narrowCCandidates(transitiveMatches, srcFilePath, srcLanguage, srcName, dstName);

      if (narrowedTransitiveMatches.length === 1) {
        const fp = narrowedTransitiveMatches[0];
        const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
        if (dstQualifiedKey === null) continue;
        resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.8 });
        continue;
      }
      // Tier 3: global fallback (confidence 0.5) — uses inverted symbol index
      // instead of scanning all files.
      // Skip for C/C++ REFERENCES: struct/type references that don't resolve via the
      // import chain come from system headers (e.g. <net/if.h>) and must not be
      // linked to an in-repo definition of the same name.
      if (rel.predicate === 'REFERENCES' &&
          (srcLanguage === SupportedLanguages.C || srcLanguage === SupportedLanguages.CPlusPlus)) {
        continue;
      }
      stats.globalFallbacks++;
      const candidates = symbolToFiles.get(dstName) ?? [];
      let globalMatches = candidates.filter(fp => fp !== srcFilePath && fileLanguage.get(fp) === srcLanguage);
      const importHint = pickCallerAlignedCandidate(importMatches, srcName, dstName)?.chosen
        ?? pickCallerAlignedCandidate(transitiveMatches, srcName, dstName)?.chosen;
      if (importHint) {
        const hintedStem = candidateStem(importHint);
        const stemMatches = globalMatches.filter(fp => candidateStem(fp) === hintedStem);
        if (stemMatches.length > 0) globalMatches = stemMatches;
      }
      stats.globalCandidateTotal += globalMatches.length;

      const resolvedMatches = narrowCCandidates(globalMatches, srcFilePath, srcLanguage, srcName, dstName);

      if (resolvedMatches.length === 1) {
        const fp = resolvedMatches[0];
        const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
        if (dstQualifiedKey === null) continue; // ambiguous — do not emit bad nodeId
        resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.5 });
        stats.resolvedGlobal++;
        continue;
      }
      if (narrowedImportMatches.length > 1 || narrowedTransitiveMatches.length > 1 || resolvedMatches.length > 1) {
        stats.skippedAmbiguous++;
      }
      // 0 or >1 matches after all tiers — leave as dangling edge, do not emit
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
