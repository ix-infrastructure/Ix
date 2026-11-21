// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { ParsedEntity } from './index.js';

import type { BehavioralWriteV1, BehaviorSpan as Span, BehaviorGuard, BehaviorCoverage, BehaviorCutReason as CutReason, BehaviorV1 } from './schema.js';

type Node = Parser.SyntaxNode;
type Arm = BehaviorGuard['arm'];
type ConditionKey = BehaviorGuard['conditionKey'];

export interface BehaviorWrite extends Omit<BehavioralWriteV1, 'id' | 'slotId'> {
  ownerKey: string;
  declaringKey: string;
  duplicateOrdinal: number;
}

export interface BehaviorLimits {
  visits: number;
  depth: number;
  writes: number;
  bytes: number;
}

export const behaviorLimits: Readonly<BehaviorLimits> = {
  visits: 32_768, depth: 48, writes: 256, bytes: 196_608,
};

export type BehavioralEvidence = BehaviorCoverage & { writes: BehaviorWrite[] };

/** Exact query captures of the structural entity, kept only while the tree is live. */
export interface BehaviorDefinition {
  entity: ParsedEntity;
  node: Node;
  name: Node;
}

function hash(tuple: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

function siteTuple(write: BehaviorWrite) {
  return [
    ['string', write.observed.to.value],
    write.observed.guards.map(g => [g.conditionKey, g.arm]),
  ];
}

/** The caller supplies Ix's existing symbolNodeId in the file's workspace/member context. */
export function bindBehaviorIds(write: BehaviorWrite, nodeId: (key: string) => string) {
  const slotId = hash(['ix-slot/1', nodeId(write.declaringKey), write.slotKind, write.slotName]);
  const id = hash(['ix-write/1', nodeId(write.ownerKey), slotId, ...siteTuple(write), write.duplicateOrdinal]);
  return { slotId, id };
}

/** Bind only verified sites to the emitting file's existing graph namespace. */
export function behaviorByOwner(evidence: BehavioralEvidence, nodeId: (key: string) => string): Map<string, BehaviorV1> {
  const byOwner = new Map<string, BehaviorV1>();
  const { writes, ...coverage } = evidence;
  for (const write of writes) {
    let envelope = byOwner.get(write.ownerKey);
    if (!envelope) {
      envelope = { ...coverage, writes: [] };
      byOwner.set(write.ownerKey, envelope);
    }
    const { slotKind, slotName, observed, inferred } = write;
    envelope.writes.push({ ...bindBehaviorIds(write, nodeId), slotKind, slotName, observed, inferred });
  }
  return byOwner;
}

class Cut extends Error {
  constructor(readonly reason: CutReason) { super(reason); }
}

class Budget {
  private visits = 0;
  private nextClockCheck = 1;
  constructor(readonly limits: BehaviorLimits, private deadline: number) {}
  visit(depth = 0) {
    if (++this.visits > this.limits.visits) throw new Cut('visits');
    if (depth > this.limits.depth) throw new Cut('depth');
    if (this.visits >= this.nextClockCheck) {
      if (performance.now() >= this.deadline) throw new Cut('deadline');
      this.nextClockCheck = this.visits + 64;
    }
  }
  // Bound the native binding's child-array allocation, including very wide blocks.
  children(node: Node, named = true): Node[] {
    this.visits += named ? node.namedChildCount : node.childCount;
    if (this.visits > this.limits.visits) throw new Cut('visits');
    return named ? node.namedChildren : node.children;
  }
}

const slotNames = new Set(['status', 'state', 'phase']);
/** Cheap rejection only. Comments can occur on either side of the assignment operator. */
export function firstBehaviorCandidate(source: string): number {
  return source.search(/\b(?:state|status|phase)\s*(?:\/[*/]|=\s*["'/])/);
}

const scopeBoundary = new Set(['arrow_function', 'function_expression', 'function_declaration',
  'generator_function', 'generator_function_declaration', 'method_definition', 'class',
  'class_declaration', 'abstract_class_declaration']);

function span(node: Node): Span {
  const { startPosition: a, endPosition: b } = node;
  return [a.row + 1, a.column, b.row + 1, b.column];
}

function topLevel(node: Node): boolean {
  const parent = node.parent;
  return parent?.type === 'program' || (parent?.type === 'export_statement' && parent.parent?.type === 'program');
}

/** Simple quoted strings. Skip legacy escapes and line continuations rather than guess a value. */
function stringValue(node: Node | null): string | undefined {
  if (node?.type !== 'string') return;
  if (node.endIndex - node.startIndex > 130) throw new Cut('literalLength');
  const raw = node.text.slice(1, -1);
  if (!raw.includes('\\')) return raw;
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '"': '"', "'": "'", '\\': '\\' };
  let supported = true;
  const value = raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g,
    (_, point, unit, byte, char: string) => {
      if (char === undefined) {
        const n = parseInt(point ?? unit ?? byte, 16);
        if (n <= 0x10ffff) return String.fromCodePoint(n);
      } else if (Object.hasOwn(escapes, char)) return escapes[char];
      supported = false;
      return '';
    });
  return supported ? value : undefined;
}

function operand(node: Node | null): string | undefined {
  if (node?.type === 'identifier' && node.endIndex - node.startIndex <= 1024) return node.text;
  if (node?.type === 'member_expression' && node.childForFieldName('object')?.type === 'this' &&
      node.childForFieldName('property')?.type === 'property_identifier' && !node.childForFieldName('optional_chain')) {
    const property = node.childForFieldName('property')!;
    if (property.endIndex - property.startIndex <= 1024) return 'this.' + property.text;
  }
}

function comparedName(node: Node | null): string | undefined {
  const direct = operand(node);
  if (direct !== undefined) return direct;
  const object = node?.childForFieldName('object');
  const property = node?.childForFieldName('property');
  if (node?.type === 'member_expression' && !node.childForFieldName('optional_chain') &&
      object?.type === 'identifier' && property?.type === 'property_identifier') {
    return object.text + '.' + property.text;
  }
}

function firstCode(node: Node, budget: Budget): Node | undefined {
  return budget.children(node).find(n => !n.isExtra);
}

function unwrap(node: Node | null, budget: Budget): Node | null {
  while (node?.type === 'parenthesized_expression') {
    budget.visit();
    node = firstCode(node, budget) ?? null;
  }
  return node;
}

interface Condition {
  expression: string;
  span: Span;
  key: ConditionKey;
  operand?: string;
  equalValue?: string;
}

function condition(node: Node, budget: Budget): Condition {
  if (node.endIndex - node.startIndex > 1024) throw new Cut('conditionLength');
  const expr = unwrap(node, budget)!;
  const base = { expression: node.text, span: span(node) };
  let comparedOperand = comparedName(expr);
  if (expr.type === 'binary_expression') {
    const op = expr.childForFieldName('operator')?.type;
    if (op && ['===', '!==', '==', '!='].includes(op)) {
      const left = unwrap(expr.childForFieldName('left'), budget);
      const right = unwrap(expr.childForFieldName('right'), budget);
      const rightValue = stringValue(right);
      const value = rightValue ?? stringValue(left);
      if (value !== undefined) comparedOperand = comparedName(rightValue !== undefined ? left : right);
      if (op === '===' && comparedOperand && value !== undefined) {
        return { ...base, key: ['strictEqual', comparedOperand, ['string', value]], operand: comparedOperand, equalValue: value };
      }
    }
  }
  const tokens: string[][] = [];
  function tokenize(n: Node, depth: number) {
    budget.visit(depth);
    if (n.isExtra) return;
    if (n.type === 'string') {
      const value = stringValue(n);
      tokens.push(value === undefined ? ['rawString', n.text] : ['string', value]);
    } else if (!n.childCount) tokens.push([n.type, n.text]);
    else for (const child of budget.children(n, false)) tokenize(child, depth + 1);
  }
  tokenize(expr, 0);
  return { ...base, key: ['tokens', hash(tokens)], operand: comparedOperand };
}

interface Owner {
  key: string;
  classKey?: string;
  fn: Node;
  body: Node;
}

function callable(def: BehaviorDefinition, key: string, classes: Map<number, string>, budget: Budget): Owner | undefined {
  const { node, name, entity } = def;
  let fn = node;
  let classKey: string | undefined;
  if (entity.kind === 'method' && node.type === 'method_definition') {
    const cls = node.parent?.parent;
    classKey = cls ? classes.get(cls.id) : undefined;
    if (!classKey || classKey !== entity.container || node.childForFieldName('name')?.id !== name.id) return;
    if (budget.children(node, false).some(c => ['static', 'get', 'set', '*'].includes(c.type))) return;
  } else if (entity.kind === 'function' && !entity.container) {
    if (node.type === 'function_declaration') {
      if (!topLevel(node) || node.childForFieldName('name')?.id !== name.id) return;
    } else {
      const decl = name.parent;
      const statement = decl?.parent;
      if (decl?.type !== 'variable_declarator' || !statement || !topLevel(statement) ||
          (node.id !== statement.id && (node.type !== 'export_statement' || node.id !== statement.parent?.id))) return;
      const value = decl.childForFieldName('value');
      if (!value || !['arrow_function', 'function_expression'].includes(value.type)) return;
      fn = value;
    }
  } else return;
  const body = fn.childForFieldName('body');
  if (body?.type === 'statement_block') return { key, classKey, fn, body };
}

/** Prove a unique, direct-body let before accepting any write to that local. */
function localBindings(owner: Owner, statements: Node[], budget: Budget): Map<string, number> {
  const candidates = new Map<string, number>();
  const declarations = new Set<number>();
  for (const stmt of statements) {
    budget.visit();
    if (stmt.type !== 'lexical_declaration' || stmt.childForFieldName('kind')?.type !== 'let') continue;
    for (const decl of budget.children(stmt)) {
      budget.visit();
      const name = decl.childForFieldName('name');
      if (name?.type !== 'identifier' || !slotNames.has(name.text)) continue;
      if (candidates.has(name.text)) candidates.set(name.text, Infinity);
      else candidates.set(name.text, decl.endIndex);
      declarations.add(name.id);
    }
  }
  if (!candidates.size) return candidates;
  function exclude(pattern: Node | null, depth: number) {
    if (!pattern) return;
    budget.visit(depth);
    if (pattern.type.includes('identifier')) {
      // Escaped binding names may spell a candidate name at runtime.
      if (pattern.text.includes('\\')) candidates.clear();
      else candidates.delete(pattern.text);
    } else for (const child of budget.children(pattern)) exclude(child, depth + 1);
  }
  function scan(node: Node, depth: number) {
    budget.visit(depth);
    if (scopeBoundary.has(node.type)) {
      exclude(node.childForFieldName('name'), depth);
      return;
    }
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      if (name && !declarations.has(name.id)) exclude(name, depth);
    } else if (node.type === 'catch_clause') exclude(node.childForFieldName('parameter'), depth);
    else if (node.type === 'for_in_statement') exclude(node.childForFieldName('left'), depth);
    else if (node.type === 'enum_declaration' || node.type === 'internal_module') exclude(node.childForFieldName('name'), depth);
    if (candidates.size) for (const child of budget.children(node)) scan(child, depth + 1);
  }
  exclude(owner.fn.childForFieldName('parameters') ?? owner.fn.childForFieldName('parameter'), 0);
  exclude(owner.fn.childForFieldName('name'), 0);
  scan(owner.body, 0);
  return candidates;
}

interface EnclosingGuard { expression: Node; condition?: Condition; arm: Arm }

function analyzeOwner(owner: Owner, hasLet: boolean, budget: Budget, emit: (write: BehaviorWrite) => void) {
  const statements = budget.children(owner.body);
  const locals = hasLet ? localBindings(owner, statements, budget) : new Map<string, number>();
  if (!owner.classKey && !locals.size) return;
  const guards: EnclosingGuard[] = [];
  const ordinals = new Map<string, number>();

  function assignment(node: Node, firstInArm: boolean) {
    const left = node.childForFieldName('left');
    const target = operand(left);
    if (!target) return;
    const field = left?.type === 'member_expression';
    const slotName = field ? target.slice(5) : target;
    if (!slotNames.has(slotName)) return;
    if (field ? !owner.classKey : node.startIndex < (locals.get(slotName) ?? Infinity)) return;
    const value = stringValue(node.childForFieldName('right'));
    if (value === undefined) return;
    // Only fingerprint predicates that actually control an accepted write.
    const observedGuards = guards.map(g => {
      const c = g.condition ??= condition(g.expression, budget);
      return { expression: c.expression, span: c.span, conditionKey: c.key, arm: g.arm,
        sameSlot: c.operand === undefined ? null : c.operand === target };
    });
    const last = guards.at(-1);
    const prior = firstInArm && last?.arm === 'then' && last.condition?.operand === target ? last.condition.equalValue : undefined;
    const write: BehaviorWrite = {
      ownerKey: owner.key, declaringKey: field ? owner.classKey! : owner.key,
      slotKind: field ? 'instanceField' : 'local', slotName, duplicateOrdinal: 0,
      observed: { to: { kind: 'string', value }, assignment: span(node), guards: observedGuards },
      inferred: prior === undefined ? { from: 'unknown' } : {
        from: { kind: 'string', value: prior }, basis: 'direct-same-slot-equality', guardIndex: guards.length - 1,
      },
    };
    const fingerprint = JSON.stringify([write.slotKind, slotName, ...siteTuple(write)]);
    write.duplicateOrdinal = ordinals.get(fingerprint) ?? 0;
    ordinals.set(fingerprint, write.duplicateOrdinal + 1);
    emit(write);
  }

  function walk(stmt: Node, depth: number, firstInArm: boolean) {
    budget.visit(depth);
    if (stmt.type === 'statement_block') {
      for (const child of budget.children(stmt)) {
        if (child.isExtra || child.type === 'empty_statement') continue;
        walk(child, depth + 1, firstInArm);
        firstInArm = false;
      }
    } else if (stmt.type === 'if_statement') {
      const test = stmt.childForFieldName('condition');
      const expression = test && firstCode(test, budget);
      if (!expression) return;
      const then = stmt.childForFieldName('consequence')!;
      const guard: EnclosingGuard = { expression, arm: 'then' };
      guards.push(guard);
      walk(then, depth + 1, true);
      const clause = stmt.childForFieldName('alternative');
      const other = clause && firstCode(clause, budget);
      if (other) {
        guard.arm = 'else';
        walk(other, depth + 1, true);
      }
      guards.pop();
    } else if (stmt.type === 'expression_statement') {
      const expr = firstCode(stmt, budget);
      if (expr?.type === 'assignment_expression') assignment(expr, firstInArm);
    }
  }
  for (const stmt of statements) walk(stmt, 0, false);
}

export function extractBehavior(
  entities: ParsedEntity[], definitions: BehaviorDefinition[], source: string, firstCandidate: number, deadline: number,
  qualifiedKey: (entity: ParsedEntity) => string,
): BehavioralEvidence | undefined {
  const writes: BehaviorWrite[] = [];
  const budget = new Budget(behaviorLimits, deadline);
  let bytes = 1; // Each record adds its JSON bytes and one array delimiter.
  try {
    // Complete the uniqueness check before emitting anything. Overlapping export
    // and lexical query captures of the identical name node describe one symbol.
    const names = new Map<ParsedEntity, number>();
    for (const def of definitions) {
      budget.visit();
      names.set(def.entity, def.name.id);
    }
    const keys = new Map<string, number | null>();
    for (const entity of entities) {
      budget.visit();
      const key = qualifiedKey(entity);
      const name = names.get(entity) ?? null;
      keys.set(key, keys.has(key) && keys.get(key) !== name ? null : name);
    }
    const unique = definitions.filter(d => keys.get(qualifiedKey(d.entity)) === d.name.id);
    const classes = new Map<number, string>();
    for (const d of unique) {
      if (d.entity.kind === 'class' && !d.entity.container && topLevel(d.node) &&
          ['class_declaration', 'abstract_class_declaration'].includes(d.node.type)) classes.set(d.node.id, d.entity.name);
    }
    const hasLet = /\blet\b/.test(source);
    const seen = new Set<number>();
    for (const def of unique.sort((a, b) => a.name.startIndex - b.name.startIndex)) {
      budget.visit();
      if (seen.has(def.name.id)) continue;
      const owner = callable(def, qualifiedKey(def.entity), classes, budget);
      if (!owner) continue;
      seen.add(def.name.id);
      // Ownership uniqueness is already proven across the whole file. The direct assignment
      // must occur inside this exact body. Disjoint later bodies need only a source-text scan.
      if (firstCandidate >= owner.body.endIndex || (firstCandidate < owner.body.startIndex &&
          firstBehaviorCandidate(source.slice(owner.body.startIndex, owner.body.endIndex)) < 0)) continue;
      analyzeOwner(owner, hasLet, budget, write => {
        if (writes.length >= behaviorLimits.writes) throw new Cut('writes');
        bytes += Buffer.byteLength(JSON.stringify(write)) + 1;
        if (bytes > behaviorLimits.bytes) throw new Cut('bytes');
        writes.push(write);
      });
    }
    return writes.length ? { coverage: 'complete', writes } : undefined;
  } catch (error) {
    if (error instanceof Cut) return { coverage: 'partial', cutReason: error.reason, writes };
    // A grammar/binding failure in optional analysis must preserve structural parsing.
    return { coverage: 'partial', cutReason: 'unavailable', writes: [] };
  }
}
