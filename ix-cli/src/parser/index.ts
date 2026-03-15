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
  'require', 'module', 'exports', 'undefined', 'null', 'true', 'false',
  'if', 'for', 'while', 'return', 'new', 'this', 'self',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON',
  'Math', 'Date', 'Error', 'Map', 'Set', 'Symbol',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'process', 'Buffer', 'global', 'window', 'document',
]);

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
    const query = grammar.query(queries);
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
      const captureNames = match.captures.map((c: any) => c.name);

      // Definition captures: name + definition.*
      const defCapture = match.captures.find((c: any) =>
        c.name.startsWith('definition.')
      );
      const nameCapture = match.captures.find((c: any) => c.name === 'name');

      if (defCapture && nameCapture) {
        const kind = DEFINITION_KIND_MAP[defCapture.name] ?? 'function';
        const name = nameCapture.node.text;
        if (!name || name.length === 0) continue;

        const defNode = defCapture.node;
        const lineStart = defNode.startPosition.row + 1;
        const lineEnd = defNode.endPosition.row + 1;

        entities.push({ name, kind, lineStart, lineEnd, language });

        if (kind === 'class' || kind === 'interface' || kind === 'trait') {
          classRanges.push({ name, start: lineStart, end: lineEnd });
        }

        // Containment: file CONTAINS or class CONTAINS
        const enclosing = findEnclosing(classRanges, lineStart, name);
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
        if (importPath.length > 0) {
          const modName = importPath.split('/').pop() ?? importPath;
          entities.push({ name: modName, kind: 'module', lineStart: importSource.node.startPosition.row + 1, lineEnd: importSource.node.startPosition.row + 1, language });
          relationships.push({ srcName: fileName, dstName: modName, predicate: 'IMPORTS' });
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
  return best?.name ?? null;
}
