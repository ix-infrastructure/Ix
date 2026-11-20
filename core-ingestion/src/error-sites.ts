// Copyright 2026 Ix Infrastructure Inc.

import type { ParsedEntity } from './index.js';

export interface ErrorSite {
  errorType: string;
  /** All dynamic values use the same searchable placeholder. */
  messageTemplate?: string;
  functionName?: string;
  container?: string;
  functionLine?: number;
  line: number;
}

export function normalizeMessage(text: string): string {
  return text.replace(/%%/g, '\u0000')
    .replace(/%(?:\([^)]+\)|\d+\$|\[\d+\])?[-+#0 ]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[a-zA-Z]/g, '{}')
    .replace(/\$\{[^}]*\}|\{(?:[\w.[\]]*(?:![rsa])?(?::[^{}]*)?)\}/g, '{}')
    .replaceAll('\u0000', '%').replace(/\s+/g, ' ').trim();
}

/** Match a rendered message, requiring enough literal content to be specific. */
export function messageMatches(template: string, text: string): boolean {
  const parts = template.split('{}');
  if (parts.join('').replace(/\W/g, '').length < 12) return false;
  const rendered = text.replace(/[^\S\n]+/g, ' ');
  // Track possible literal endpoints instead of regex backtracking. Repeated
  // placeholders/literals in a long report must not cause exponential work.
  let positions = new Set<number>();
  const first = parts[0];
  for (let start = rendered.indexOf(first); start !== -1 && start <= rendered.length;
    start = rendered.indexOf(first, start + 1)) {
    if (start === 0 || !/\w/.test(rendered[start - 1])) positions.add(start + first.length);
    if (start === rendered.length) break;
  }
  for (const literal of parts.slice(1)) {
    const next = new Set<number>();
    for (const end of positions) {
      const newline = rendered.slice(end, end + 257).indexOf('\n');
      const limit = Math.min(end + 256, newline < 0 ? rendered.length : end + newline);
      const window = rendered.slice(end, limit + literal.length);
      for (let offset = window.indexOf(literal); offset !== -1 && end + offset <= limit;
        offset = window.indexOf(literal, offset + 1)) {
        next.add(end + offset + literal.length);
        if (offset === window.length) break;
      }
    }
    positions = next;
    if (!positions.size) return false;
  }
  return [...positions].some(end => end === rendered.length || !/\w/.test(rendered[end]));
}

/** Tree traversal, so comments and unrelated string literals never become sites. */
export function extractErrorSites(root: any, entities: ParsedEntity[], language: string, checkBudget: () => void): ErrorSite[] {
  if (!['typescript', 'javascript', 'python', 'go', 'java'].includes(language.toLowerCase())) return [];
  const sites: ErrorSite[] = [];
  const functions = entities.filter(e => e.kind === 'function' || e.kind === 'method');
  const message = (node: any, allowCall = false): string | undefined => {
    if (!node) return undefined;
    if (['string', 'string_literal', 'template_string', 'interpreted_string_literal', 'raw_string_literal'].includes(node.type)) {
      // Work from the literal's children, replacing interpolations before
      // stripping quotes. This also handles nested expressions in f-strings.
      let raw = node.text as string;
      const interpolations = node.namedChildren.filter((c: any) => /interpolation|template_substitution/.test(c.type));
      for (const c of [...interpolations].reverse()) {
        const start = c.startIndex - node.startIndex;
        raw = raw.slice(0, start) + '{}' + raw.slice(c.endIndex - node.startIndex);
      }
      raw = raw.replace(/^[rubf]*(?:"""|'''|["'`])/i, '').replace(/(?:"""|'''|["'`])$/, '');
      raw = raw.replace(/\\n|\\r|\\t/g, ' ').replace(/\\([\\"'`])/g, '$1');
      return raw;
    }
    // Formatting wrappers (String.format, .format, %, fmt.Errorf) and
    // concatenations: keep literal fragments and replace dynamic operands.
    if (node.type === 'binary_expression' || node.type === 'binary_operator') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      const op = node.childForFieldName('operator')?.text;
      if (op === '%') return message(left);
      if (op === '+') {
        const a = message(left), b = message(right);
        return a !== undefined || b !== undefined ? (a ?? '{}') + (b ?? '{}') : undefined;
      }
    }
    if (/call|method_invocation|object_creation|new_expression/.test(node.type)) {
      const callee = node.childForFieldName('function');
      if (callee?.type === 'attribute' && callee.childForFieldName('attribute')?.text === 'format') {
        return message(callee.childForFieldName('object'));
      }
      const name = callee?.text ?? [node.childForFieldName('object')?.text, node.childForFieldName('name')?.text].filter(Boolean).join('.');
      if (!allowCall && !/^(?:fmt\.Errorf|String\.format|errors\.New)$/.test(name)) return undefined;
      const args = node.childForFieldName('arguments') ?? node.namedChildren.find((c: any) => /argument_list|arguments/.test(c.type));
      return message(args?.namedChildren[0]);
    }
    return undefined;
  };
  const stack = [root];
  while (stack.length) {
    checkBudget();
    const node = stack.pop();
    let errorType: string | undefined;
    let argument: any;
    if (node.type === 'throw_statement' || node.type === 'raise_statement') {
      const value = node.namedChildren[0];
      const callee = value?.childForFieldName('constructor') ?? value?.childForFieldName('function') ?? value?.childForFieldName('type');
      errorType = callee?.text ?? (/^[\w.]+$/.test(value?.text ?? '') ? value.text : undefined);
      argument = value;
    } else if (/^(call|call_expression|method_invocation)$/.test(node.type)) {
      const callee = node.childForFieldName('function')?.text
        ?? [node.childForFieldName('object')?.text, node.childForFieldName('name')?.text].filter(Boolean).join('.');
      if (/^(?:panic|errors\.New|fmt\.Errorf)$/.test(callee) || /(?:^|\.)(?:error|warn|warning)$/i.test(callee)) {
        errorType = callee;
        argument = node;
      }
    }
    if (errorType) {
      const line = node.startPosition.row + 1;
      const owner = functions.filter(e => e.lineStart <= line && line <= e.lineEnd)
        .sort((a, b) => (a.lineEnd - a.lineStart) - (b.lineEnd - b.lineStart) || b.lineStart - a.lineStart)[0];
      const rawMessage = message(argument, true);
      const template = rawMessage === undefined ? undefined : normalizeMessage(rawMessage);
      sites.push({ errorType, ...(template ? { messageTemplate: template } : {}),
        ...(owner ? { functionName: owner.name, functionLine: owner.lineStart, ...(owner.container ? { container: owner.container } : {}) } : {}), line });
    }
    // Tree-sitter materializes this array on every access; cache it before
    // looping or a block with thousands of statements becomes quadratic.
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return sites;
}
