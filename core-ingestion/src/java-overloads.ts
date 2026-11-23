// Copyright 2026 Ix Infrastructure Inc.

// Use AST tokens rather than source text: comments, annotations, parameter names
// and formatting do not identify an overload. Keep types as written (no erasure).
function typeTokens(node: any): string {
  if (!node || ['annotation', 'marker_annotation', 'line_comment', 'block_comment'].includes(node.type)) return '';
  return node.childCount ? node.children.map(typeTokens).join('') : node.text;
}

function parameterType(parameter: any): string {
  if (parameter.type === 'spread_parameter') {
    const type = parameter.namedChildren.find((n: any) => !['modifiers', 'annotation', 'marker_annotation', 'variable_declarator', 'line_comment', 'block_comment'].includes(n.type));
    return `${typeTokens(type)}...`;
  }
  return typeTokens(parameter.childForFieldName('type')) + typeTokens(parameter.childForFieldName('dimensions'));
}

/** Only overload groups need new keys; other Java methods retain their ids. */
export function javaOverloadSignatures(matches: any[]): Map<number, string> {
  const groups = new Map<string, Map<number, any>>();
  for (const match of matches) {
    const definition = match.captures.find((c: any) => c.name === 'definition.method' || c.name === 'definition.constructor')?.node;
    if (!definition) continue;
    const name = definition.childForFieldName('name')?.text;
    const key = `${definition.parent?.id}:${name}`;
    const group = groups.get(key) ?? new Map<number, any>();
    group.set(definition.id, definition);
    groups.set(key, group);
  }
  const signatures = new Map<number, string>();
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    for (const definition of group.values()) {
      const parameters = definition.childForFieldName('parameters')?.namedChildren
        .filter((n: any) => n.type === 'formal_parameter' || n.type === 'spread_parameter') ?? [];
      signatures.set(definition.id, `(${parameters.map(parameterType).join(',')})`);
    }
  }
  return signatures;
}

/** Hints only: unknown expressions stay unknown rather than implying a type. */
export function javaArgumentTypes(call: any, lookup: (node: any) => { type?: string } | undefined): Array<string | null> {
  const typeOf = (node: any): string | null => {
    switch (node.type) {
      case 'string_literal': return 'String';
      case 'character_literal': return 'char';
      case 'true': case 'false': return 'boolean';
      case 'decimal_integer_literal': case 'hex_integer_literal': case 'octal_integer_literal': case 'binary_integer_literal':
        return /[lL]$/.test(node.text) ? 'long' : 'int';
      case 'decimal_floating_point_literal': case 'hex_floating_point_literal':
        return /[fF]$/.test(node.text) ? 'float' : 'double';
      case 'parenthesized_expression': return typeOf(node.firstNamedChild);
      case 'cast_expression': case 'object_creation_expression': return typeTokens(node.childForFieldName('type')) || null;
      case 'identifier': case 'field_access': return lookup(node)?.type ?? null;
      default: return null;
    }
  };
  return (call.childForFieldName('arguments')?.namedChildren ?? [])
    .filter((n: any) => n.type !== 'line_comment' && n.type !== 'block_comment').map(typeOf);
}

function signatureTypes(key: string): string[] {
  const text = key.slice(key.indexOf('(') + 1, -1);
  if (!text) return [];
  const types: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') depth++;
    if (text[i] === '>') depth--;
    if (text[i] === ',' && depth === 0) { types.push(text.slice(start, i)); start = i + 1; }
  }
  types.push(text.slice(start));
  return types;
}

const boxed: Record<string, string> = { boolean: 'Boolean', byte: 'Byte', short: 'Short', char: 'Character', int: 'Integer', long: 'Long', float: 'Float', double: 'Double' };
const widening: Record<string, string[]> = {
  byte: ['short', 'int', 'long', 'float', 'double'], short: ['int', 'long', 'float', 'double'],
  char: ['int', 'long', 'float', 'double'], int: ['long', 'float', 'double'], long: ['float', 'double'], float: ['double'],
};

/** Select only a unique applicable signature. This is not a Java type checker:
 * subtyping, generics and varargs expansion remain unresolved when ambiguous.
 */
export function selectJavaOverload(keys: string[], arguments_: Array<string | null>): string | undefined {
  const signatures = keys.map(key => ({ key, types: signatureTypes(key) }));
  // A varargs declaration can compete with a fixed-arity declaration. Without
  // Java's applicability phases, ignoring it could select an unrelated method.
  if (signatures.some(({ types }) => types.at(-1)?.endsWith('...') && arguments_.length >= types.length - 1)) return;
  const candidates = signatures.filter(({ types }) => types.length === arguments_.length);
  // A lone arity is sufficient even when an expression's type is unknown.
  if (candidates.length === 1) return candidates[0].key;
  if (arguments_.some(t => t === null)) return;
  const normalized = (type: string): string => type.replace(/^java\.lang\./, '');
  const exact = candidates.filter(({ types }) => types.every((t, i) => normalized(t) === normalized(arguments_[i]!)));
  if (exact.length === 1) return exact[0].key;
  // Java tries primitive widening before boxing. Within a phase, require one
  // candidate; do not invent a ranking for unknown reference conversions.
  for (const boxing of [false, true]) {
    const applicable = candidates.filter(({ types }) => types.every((t, i) => {
      const expected = normalized(t);
      const actual = normalized(arguments_[i]!);
      return expected === actual || (widening[actual] ?? []).includes(expected) || (boxing && boxed[actual] === expected);
    }));
    if (applicable.length) return applicable.length === 1 ? applicable[0].key : undefined;
  }
  return undefined;
}
