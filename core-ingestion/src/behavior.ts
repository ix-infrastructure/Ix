// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { ParsedEntity } from './index.js';

import type { BehavioralWriteV1, BehaviorSpan as Span, BehaviorGuard, BehaviorFrame, BehaviorLiteral, BehaviorCoverage, BehaviorCutReason as CutReason, BehaviorV1 } from './schema.js';

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
  const tuple: unknown[] = [
    [write.observed.to.kind, write.observed.to.value],
    write.observed.guards.map(g => [g.conditionKey, g.arm]),
  ];
  const frames = write.observed.controlFlow;
  if (frames?.length) tuple.push(frames.map(f => f.kind === 'try'
    ? [f.kind, f.form, f.arm, f.guardDepth] : [f.kind, f.headerKey, f.guardDepth]));
  return tuple;
}

/** The caller supplies Ix's existing symbolNodeId in the file's workspace/member context. */
export function bindBehaviorIds(write: BehaviorWrite, nodeId: (key: string) => string) {
  const slotId = hash(['ix-slot/1', nodeId(write.declaringKey), write.slotKind, write.slotName]);
  const domain = write.observed.controlFlow?.length ? 'ix-flow-write/1' : 'ix-write/1';
  const id = hash([domain, nodeId(write.ownerKey), slotId, ...siteTuple(write), write.duplicateOrdinal]);
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

const booleanSlots = new Set(['dead', 'destroyed', 'running', 'queued', 'stopped']);
// A comment may separate this, the dot, the name or the operator. Let those
// prefixes through; only tree-sitter can accept a write.
const booleanCandidate = /\bthis\s*(?:\/[*/]|\.\s*(?:\/[*/]|(?:dead|destroyed|running|queued|stopped)\s*(?:\/[*/]|=\s*(?:true\b|false\b|\/))))/;
export function firstBooleanCandidate(source: string): number {
  return source.search(booleanCandidate);
}

function booleanLiteral(n: Node | null): Extract<BehaviorLiteral, {kind: 'boolean'}> | undefined {
  if (n?.type === 'true' || n?.type === 'false') return { kind: 'boolean', value: n.type === 'true' };
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
  equalValue?: BehaviorLiteral;
}

function condition(node: Node, budget: Budget, boolean: boolean): Condition {
  if (node.endIndex - node.startIndex > 1024) throw new Cut('conditionLength');
  const expr = unwrap(node, budget)!;
  const base = { expression: node.text, span: span(node) };
  let comparedOperand = comparedName(expr);
  if (boolean && expr.type === 'unary_expression' && expr.childForFieldName('operator')?.type === '!') {
    comparedOperand = comparedName(unwrap(expr.childForFieldName('argument'), budget));
  }
  if (expr.type === 'binary_expression') {
    const op = expr.childForFieldName('operator')?.type;
    if (op && ['===', '!==', '==', '!='].includes(op)) {
      const left = unwrap(expr.childForFieldName('left'), budget);
      const right = unwrap(expr.childForFieldName('right'), budget);
      if (boolean) {
        const rightValue = booleanLiteral(right);
        const value = rightValue ?? booleanLiteral(left);
        if (value) {
          comparedOperand = comparedName(rightValue ? left : right);
          if (op === '===' && comparedOperand) return { ...base, key: ['strictEqual', comparedOperand, ['boolean', value.value]],
            operand: comparedOperand, equalValue: value };
        }
      } else {
        const rightValue = stringValue(right);
        const value = rightValue ?? stringValue(left);
        if (value !== undefined) comparedOperand = comparedName(rightValue !== undefined ? left : right);
        if (op === '===' && comparedOperand && value !== undefined) {
          return { ...base, key: ['strictEqual', comparedOperand, ['string', value]], operand: comparedOperand, equalValue: { kind: 'string', value } };
        }
      }
    }
  }
  return { ...base, key: ['tokens', tokenHash([expr], budget)], operand: comparedOperand };
}

function tokenHash(nodes: Node[], budget: Budget): string {
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
  for (const node of nodes) tokenize(node, 0);
  return hash(tokens);
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

// A sibling's early return qualifies a declared slot. It is never a guard on the writer.
function directFlag(test: Node | null, budget: Budget): string | undefined {
  let expr = unwrap(test, budget);
  if (expr?.type === 'unary_expression' && expr.childForFieldName('operator')?.type === '!') {
    expr = unwrap(expr.childForFieldName('argument'), budget);
  }
  const name = operand(expr);
  return name?.startsWith('this.') ? name.slice(5) : undefined;
}

function gateFields(test: Node | null, budget: Budget): string[] {
  const expr = unwrap(test, budget);
  const op = expr?.type === 'binary_expression' && expr.childForFieldName('operator')?.type;
  if (op === '&&' || op === '===') {
    const left = unwrap(expr!.childForFieldName('left'), budget);
    const right = unwrap(expr!.childForFieldName('right'), budget);
    if (op === '&&') {
      const a = directFlag(left, budget), b = directFlag(right, budget);
      return a && b ? [a, b] : [];
    }
    const field = booleanLiteral(left) ? operand(right) : booleanLiteral(right) ? operand(left) : undefined;
    return field?.startsWith('this.') ? [field.slice(5)] : [];
  }
  const field = directFlag(expr, budget);
  return field ? [field] : [];
}

function hasWork(stmt: Node, budget: Budget): boolean {
  // Restrict the witness to an invocation/construction after the return. A pair
  // of alternative display literals alone does not establish a lifecycle gate.
  let value: Node | null | undefined;
  if (stmt.type === 'return_statement' || stmt.type === 'expression_statement') value = firstCode(stmt, budget);
  if (stmt.type === 'lexical_declaration') {
    return budget.children(stmt).some(d => {
      const v = d.childForFieldName('value');
      return v?.type === 'call_expression' || v?.type === 'new_expression';
    });
  }
  return value?.type === 'call_expression' || value?.type === 'new_expression';
}

// Early exits in the pilot either abandon work or return an already-resolved
// promise. A display selector can return a literal and then call a formatter.
function operationalReturn(stmt: Node, budget: Budget): boolean {
  if (stmt.childForFieldName('alternative')) return false;
  let arm = stmt.childForFieldName('consequence');
  if (arm?.type === 'statement_block') {
    arm = budget.children(arm).filter(n => !n.isExtra && n.type !== 'empty_statement').at(-1) ?? null;
  }
  if (arm?.type !== 'return_statement') return false;
  const value = firstCode(arm, budget);
  if (!value) return true;
  if (value.type !== 'call_expression' || value.childForFieldName('arguments')?.type !== 'arguments' ||
      budget.children(value, false).some(c => c.type === '?.' || c.type === 'optional_chain')) return false;
  return comparedName(value.childForFieldName('function')) === 'Promise.resolve';
}

// In boolean-only files a necessary condition can be checked cheaply before
// indexing every definition. The lexical scan can only reject; the sibling
// ownership, predicate and following-work checks still use verified AST nodes.
function hasPotentialGate(source: string, root: Node, budget: Budget): boolean {
  for (const match of source.matchAll(/\bif\b/g)) {
    budget.visit();
    const token = root.descendantForIndex(match.index, match.index + 2);
    const stmt = token.parent;
    if (token.type === 'if' && stmt?.type === 'if_statement' &&
        stmt.parent?.parent?.type === 'method_definition' && operationalReturn(stmt, budget)) return true;
  }
  return false;
}

function witnesses(body: Node, owners: Owner[], source: string, budget: Budget): Map<string, Set<string>> {
  const fields = new Map<string, Set<string>>();
  const seen = new Set<string>();
  if (body.parent?.childForFieldName('decorator')) return fields;
  for (const member of budget.children(body)) {
    if (member.type === 'decorator') return new Map();
    const name = member.childForFieldName('name') ?? member.childForFieldName('property');
    if (!name) continue;
    // Computed or escaped names could redeclare an otherwise eligible slot.
    if (name.type === 'computed_property_name' || name.type === 'string' || name.endIndex - name.startIndex > 1024 || name.text.includes('\\')) return new Map();
    if (name.text === 'constructor') {
      const params = member.childForFieldName('parameters');
      for (const param of params ? budget.children(params) : []) {
        if (budget.children(param).some(c => c.type === 'accessibility_modifier' || c.type === 'readonly')) {
          const binding = param.childForFieldName('pattern');
          if (!binding || binding.type !== 'identifier' || binding.text.includes('\\')) return new Map();
          fields.delete(binding.text);
          seen.add(binding.text);
        }
      }
    }
    if (!booleanSlots.has(name.text)) continue;
    const field = name.type === 'property_identifier' &&
      ['field_definition', 'public_field_definition'].includes(member.type) &&
      booleanLiteral(member.childForFieldName('value')) &&
      !budget.children(member, false).some(c => ['static', 'decorator', 'accessor', 'declare', 'abstract'].includes(c.type));
    if (field && !seen.has(name.text)) fields.set(name.text, new Set());
    else fields.delete(name.text);
    seen.add(name.text);
  }
  if (!fields.size) return fields;
  for (const owner of owners) {
    const text = source.slice(owner.body.startIndex, owner.body.endIndex);
    if (!text.includes('return') || !text.includes('if')) continue;
    let laterWork = false;
    for (const stmt of budget.children(owner.body).reverse()) {
      budget.visit();
      if (laterWork && stmt.type === 'if_statement' && operationalReturn(stmt, budget)) {
        for (const slot of gateFields(stmt.childForFieldName('condition'), budget)) fields.get(slot)?.add(owner.key);
      }
      laterWork ||= hasWork(stmt, budget);
    }
  }
  for (const [slot, readers] of fields) if (!readers.size) fields.delete(slot);
  return fields;
}

interface EnclosingGuard { expression: Node; condition?: Condition; arm: Arm }

interface FrameRegion { statement: Node; body: Node; arm: 'body' | 'catch' | 'finally'; guardDepth: number; fact?: BehaviorFrame }

// Materialize and fingerprint a bounded header only when a verified write needs it.
function frameFact(region: FrameRegion, budget: Budget): BehaviorFrame {
  if (region.fact) return region.fact;
  const {statement, body, guardDepth, arm} = region;
  const base = {span: span(statement), body: span(body), guardDepth};
  if (statement.type === 'try_statement') {
    const form = statement.childForFieldName('handler')
      ? (statement.childForFieldName('finalizer') ? 'catchFinally' : 'catch') : 'finally';
    return region.fact = {...base, kind:'try', form, arm};
  }
  const kind = statement.type === 'while_statement' ? 'while' : 'for';
  const children = budget.children(statement, false);
  const condition = statement.childForFieldName('condition');
  const close = kind === 'while' ? condition : children.find(c => c.type === ')');
  if (!close) throw new Cut('unavailable');
  if (close.endIndex - statement.startIndex > 1024) throw new Cut('conditionLength');
  const expression = kind === 'while' ? firstCode(close, budget) :
    condition?.type === 'empty_statement' ? null : condition;
  if (kind === 'while' && !expression) throw new Cut('unavailable');
  const header: Span = [base.span[0], base.span[1], close.endPosition.row + 1, close.endPosition.column];
  return region.fact = {...base, kind, header,
    headerKey: tokenHash(children.filter(c => c.endIndex <= close.endIndex), budget),
    test: expression ? {expression:expression.text, span:span(expression)} : null};
}

function analyzeOwner(owner: Owner, hasLet: boolean, budget: Budget, emit: (write: BehaviorWrite) => void, deferred: (() => void)[], fields?: Map<string, Set<string>>, booleanBody?: string) {
  const statements = budget.children(owner.body);
  const locals = hasLet ? localBindings(owner, statements, budget) : new Map<string, number>();
  if (!owner.classKey && !locals.size) return;
  const guards: EnclosingGuard[] = [];
  const frames: FrameRegion[] = [];
  const ordinals = new Map<string, number>();

  function assignment(node: Node, firstInArm: boolean) {
    const left = node.childForFieldName('left');
    const target = operand(left);
    if (!target) return;
    const field = left?.type === 'member_expression';
    const slotName = field ? target.slice(5) : target;
    let to: BehaviorLiteral;
    if (fields) {
      const readers = fields.get(slotName);
      if (!field || !readers?.size || (readers.size === 1 && readers.has(owner.key))) return;
      const literal = booleanLiteral(node.childForFieldName('right'));
      if (!literal) return;
      to = literal;
    } else {
      if (!slotNames.has(slotName)) return;
      if (field ? !owner.classKey : node.startIndex < (locals.get(slotName) ?? Infinity)) return;
      const value = stringValue(node.childForFieldName('right'));
      if (value === undefined) return;
      to = { kind: 'string', value };
    }
    // Only fingerprint predicates that actually control an accepted write.
    const observedGuards = guards.map(g => {
      const c = g.condition ??= condition(g.expression, budget, fields !== undefined);
      return { expression: c.expression, span: c.span, conditionKey: c.key, arm: g.arm,
        sameSlot: c.operand === undefined ? null : c.operand === target };
    });
    const last = guards.at(-1);
    const prior = firstInArm && guards.length > (frames.at(-1)?.guardDepth ?? 0) && last?.arm === 'then' && last.condition?.operand === target ? last.condition.equalValue : undefined;
    const write: BehaviorWrite = {
      ownerKey: owner.key, declaringKey: field ? owner.classKey! : owner.key,
      slotKind: field ? 'instanceField' : 'local', slotName, duplicateOrdinal: 0,
      observed: { to, assignment: span(node), guards: observedGuards, controlFlow: frames.map(f => frameFact(f, budget)) },
      inferred: prior === undefined ? { from: 'unknown' } : {
        from: prior, basis: 'direct-same-slot-equality', guardIndex: guards.length - 1,
      },
    };
    const fingerprint = JSON.stringify([write.slotKind, slotName, ...siteTuple(write)]);
    write.duplicateOrdinal = ordinals.get(fingerprint) ?? 0;
    ordinals.set(fingerprint, write.duplicateOrdinal + 1);
    emit(write);
  }

  // Statements are visited in lexical order. Skip string-only subtrees without
  // traversing them again in the boolean pass. Earlier statements still consume
  // the first-in-arm position, even when they cannot contain a boolean write.
  const matcher = booleanBody === undefined ? undefined : new RegExp(booleanCandidate, 'g');
  let next = matcher?.exec(booleanBody!);
  function walk(stmt: Node, depth: number, firstInArm: boolean) {
    budget.visit(depth);
    if (matcher && !frames.length) {
      const start = stmt.startIndex - owner.body.startIndex;
      while (next && next.index < start) next = matcher.exec(booleanBody!);
      if (!next || next.index >= stmt.endIndex - owner.body.startIndex) return;
    }
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
    } else if (stmt.type === 'while_statement' || stmt.type === 'for_statement' || stmt.type === 'try_statement') {
      if (frames.length) walkRegions(stmt, depth);
      else {
        // Drain these roots only after every legacy owner has had its original budget priority.
        // Capture the lexical arm now: the if walker reuses its guard for the else branch.
        const enclosing = guards.map(g => ({...g}));
        deferred.push(() => {
          guards.push(...enclosing);
          walkRegions(stmt, depth);
          guards.length = 0;
        });
      }
    } else if (stmt.type === 'expression_statement') {
      const expr = firstCode(stmt, budget);
      if (expr?.type === 'assignment_expression') assignment(expr, firstInArm);
    }
  }
  function walkRegions(statement: Node, depth: number) {
    function visit(body: Node | null, arm: FrameRegion['arm']) {
      if (!body) throw new Cut('unavailable');
      frames.push({statement, body, arm, guardDepth:guards.length});
      walk(body, depth + 1, false);
      frames.pop();
    }
    visit(statement.childForFieldName('body'), 'body');
    if (statement.type === 'try_statement') {
      const handler = statement.childForFieldName('handler');
      if (handler) visit(handler.childForFieldName('body'), 'catch');
      const finalizer = statement.childForFieldName('finalizer');
      if (finalizer) visit(finalizer.childForFieldName('body'), 'finally');
    }
  }
  for (const stmt of statements) walk(stmt, 0, false);
}

export function extractBehavior(
  entities: ParsedEntity[], definitions: BehaviorDefinition[], source: string, firstCandidate: number, deadline: number,
  qualifiedKey: (entity: ParsedEntity) => string, firstBoolean = -1,
): BehavioralEvidence | undefined {
  const writes: BehaviorWrite[] = [];
  const budget = new Budget(behaviorLimits, deadline);
  let bytes = 1; // Each record adds its JSON bytes and one array delimiter.
  try {
    if (firstCandidate < 0 && firstBoolean >= 0 &&
        (!definitions.length || !hasPotentialGate(source, definitions[0].node.tree.rootNode, budget))) return;
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
    const deferred: (() => void)[] = [];
    const hasLet = /\blet\b/.test(source);
    const seen = new Set<number>();
    const classOwners = new Map<string, Owner[]>();
    function emit(write: BehaviorWrite) {
      if (writes.length >= behaviorLimits.writes) throw new Cut('writes');
      bytes += Buffer.byteLength(JSON.stringify(write)) + 1;
      if (bytes > behaviorLimits.bytes) throw new Cut('bytes');
      writes.push(write);
    }
    for (const def of unique.sort((a, b) => a.name.startIndex - b.name.startIndex)) {
      budget.visit();
      if (seen.has(def.name.id)) continue;
      const owner = callable(def, qualifiedKey(def.entity), classes, budget);
      if (!owner) continue;
      seen.add(def.name.id);
      if (firstBoolean >= 0 && owner.classKey) {
        let siblings = classOwners.get(owner.classKey);
        if (!siblings) classOwners.set(owner.classKey, siblings = []);
        siblings.push(owner);
      }
      if (firstCandidate < 0 || firstCandidate >= owner.body.endIndex || (firstCandidate < owner.body.startIndex &&
          firstBehaviorCandidate(source.slice(owner.body.startIndex, owner.body.endIndex)) < 0)) continue;
      analyzeOwner(owner, hasLet, budget, emit, deferred);
    }
    // Preserve legacy string records first under shared visit, byte and write caps.
    for (const siblings of classOwners.values()) {
      const writers = siblings.filter(({body}) => firstBoolean < body.endIndex &&
        (firstBoolean >= body.startIndex || firstBooleanCandidate(source.slice(body.startIndex, body.endIndex)) >= 0));
      if (!writers.length) continue;
      const fields = witnesses(writers[0].fn.parent!, siblings, source, budget);
      if (fields.size) for (const writer of writers) analyzeOwner(writer, false, budget, emit, deferred, fields,
        source.slice(writer.body.startIndex, writer.body.endIndex));
    }
    for (const visit of deferred) visit();
    return writes.length ? { coverage: 'complete', writes } : undefined;
  } catch (error) {
    if (error instanceof Cut) return { coverage: 'partial', cutReason: error.reason, writes };
    // A grammar/binding failure in optional analysis must preserve structural parsing.
    return { coverage: 'partial', cutReason: 'unavailable', writes };
  }
}
