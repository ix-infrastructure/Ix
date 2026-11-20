// Copyright 2026 Ix Infrastructure Inc.
import type { ParsedEntity, ParsedRelationship } from './index.js';
import type { ReceiverFacts, ReceiverType } from './receiver-types.js';

export interface FieldSite {
  line: number;
  /** Exact source text, only for literals or symbolic member values. */
  value?: string;
  value_kind?: 'literal' | 'member';
}

const types = new Set(['class_declaration', 'class', 'class_definition', 'interface_declaration', 'type_spec', 'enum_declaration', 'record_declaration']);
const functions = new Set(['method_definition', 'function_declaration', 'function_expression', 'generator_function', 'arrow_function', 'function_definition', 'method_declaration', 'constructor_declaration']);
const members = ['member_expression', 'attribute', 'selector_expression', 'field_access'];
const assignments = new Set(['assignment_expression', 'augmented_assignment_expression', 'assignment', 'augmented_assignment', 'assignment_statement']);
const fieldNodes = ['public_field_definition', 'field_definition', 'property_signature', 'field_declaration', 'required_parameter', 'optional_parameter'];

function enclosing(node: any, kinds: Set<string>): any {
  for (let p = node.parent; p; p = p.parent) if (kinds.has(p.type)) return p;
}
function typeText(node: any): string | undefined {
  if (!node) return;
  if (['type_annotation', 'pointer_type', 'type'].includes(node.type)) return typeText(node.firstNamedChild);
  if (['identifier', 'type_identifier', 'qualified_type', 'generic_type'].includes(node.type)) {
    const text = node.type === 'generic_type' ? node.childForFieldName('name')?.text : node.text;
    if (text && /^[\w$]+(?:\.[\w$]+)*$/.test(text) && !['any', 'unknown', 'object'].includes(text)) return text;
  }
}
function literal(value: any): Pick<FieldSite, 'value' | 'value_kind'> {
  if (!value || value.text.length > 256 || value.descendantsOfType('interpolation').length) return {};
  if (/^(?:string|interpreted_string_literal|raw_string_literal|int_literal|float_literal|integer|float|decimal_integer_literal|decimal_floating_point_literal|number|true|false|null|none|nil|character_literal|string_literal|boolean_literal|null_literal|rune_literal)$/.test(value.type)
    || (value.type === 'unary_expression' && /^[-+]\d/.test(value.text))) {
    return { value: value.text, value_kind: 'literal' };
  }
  if (members.includes(value.type) && /^[\w$]+(?:\.[\w$]+)+$/.test(value.text)) return { value: value.text, value_kind: 'member' };
  return {};
}

/** Additive, conservative field extraction. No relationship may resolve by bare name. */
export function collectFieldAccesses(root: any, language: string, entities: ParsedEntity[], relationships: ParsedRelationship[], facts: ReceiverFacts | undefined, checkBudget: () => void): void {
  if (!['typescript', 'javascript', 'python', 'go', 'java'].includes(language)) return;
  if (language === 'java') for (const ctor of root.descendantsOfType('constructor_declaration')) {
    const method = entities.find(e => e.kind === 'method' && e.lineStart === ctor.startPosition.row + 1 && e.lineEnd === ctor.endPosition.row + 1);
    const owner = enclosing(ctor, types)?.childForFieldName('name')?.text;
    if (method && owner && !method.container) {
      // Existing Java constructors share their class's unqualified key. Add a
      // distinct method endpoint for def-use without changing CALLS identities.
      entities.push({ ...method, name: '<init>', container: owner });
      relationships.push({ srcName: owner, dstName: '<init>', predicate: 'CONTAINS' });
    }
  }
  const known = new Set(entities.map(e => `${e.container ?? ''}.${e.name}`));
  const fields = new Set<string>();
  const addField = (owner: string | undefined, name: any): void => {
    if (!owner || !name || !/^[\w$]+$/.test(name.text)) return;
    const key = `${owner}.${name.text}`;
    fields.add(key);
    if (known.has(key)) return;
    known.add(key);
    entities.push({ name: name.text, kind: 'field', container: owner, language, lineStart: name.startPosition.row + 1, lineEnd: name.endPosition.row + 1 });
    relationships.push({ srcName: owner, dstName: name.text, predicate: 'CONTAINS' });
  };
  const ownerOf = (node: any): string | undefined => {
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'class_body' && p.parent?.type === 'object_creation_expression') return;
      if (types.has(p.type)) return p.childForFieldName('name')?.text;
    }
  };
  const pythonBindings = new Map<number, Map<string, ReceiverType>>();
  const pythonLookup = (node: any): ReceiverType => {
    if (node?.type !== 'identifier') return {};
    const scope = enclosing(node, functions);
    if (!scope) return {};
    let bindings = pythonBindings.get(scope.id);
    if (!bindings) {
      bindings = new Map();
      const params = scope.childForFieldName('parameters');
      for (const p of params?.namedChildren ?? []) {
        const id = p.type === 'identifier' ? p : p.childForFieldName('name') ?? p.firstNamedChild;
        if (id?.type === 'identifier') bindings.set(id.text, { type: typeText(p.childForFieldName('type')) });
      }
      // `self`/`cls` only when actually bound as the first parameter of a method.
      const first = params?.firstNamedChild;
      if (first?.type === 'identifier' && ['self', 'cls'].includes(first.text) && enclosing(scope, types)
        && !enclosing(scope, functions) && !scope.parent?.namedChildren.some((n: any) => n.type === 'decorator' && /^@(?:\w+\.)?staticmethod\b/.test(n.text))) bindings.set(first.text, { type: ownerOf(scope) });
      const assigned = new Map<string, ReceiverType[]>();
      const inferredConstructors = new Map<ReceiverType, string>();
      for (const a of scope.descendantsOfType(['assignment', 'augmented_assignment', 'named_expression', 'for_statement', 'with_item'])) {
        if (enclosing(a, functions)?.id !== scope.id) continue;
        const lhs = a.childForFieldName('left') ?? a.childForFieldName('name') ?? a.childForFieldName('alias');
        if (lhs?.type !== 'identifier') {
          const pending = lhs ? [lhs] : [];
          while (pending.length) {
            const part = pending.pop();
            if (part.type === 'identifier') assigned.set(part.text, [{}, {}]);
            else if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern'].includes(part.type)) pending.push(...part.namedChildren);
          }
          continue;
        }
        const rhs = a.childForFieldName('right');
        const ctor = rhs?.type === 'call' ? rhs.childForFieldName('function') : undefined;
        const info = { type: typeText(a.childForFieldName('type')) ?? (ctor?.type === 'identifier' && /^[A-Z]/.test(ctor.text) ? ctor.text : undefined) };
        if (!typeText(a.childForFieldName('type')) && ctor?.type === 'identifier') inferredConstructors.set(info, ctor.text);
        const list = assigned.get(lhs.text) ?? [];
        list.push(info);
        assigned.set(lhs.text, list);
      }
      for (const [info, ctor] of inferredConstructors) if (bindings.has(ctor) || assigned.has(ctor)) delete info.type;
      for (const [name, values] of assigned) bindings.set(name, values.length === 1 ? values[0] : {});
      pythonBindings.set(scope.id, bindings);
    }
    return bindings.get(node.text) ?? {};
  };
  const receiver = (node: any): ReceiverType => {
    if (!node) return {};
    if (language === 'python') return pythonLookup(node);
    if (node.type === 'this' && language !== 'java') {
      // A nested ordinary JS function owns a different `this`; arrows inherit it.
      for (let p = node.parent; p; p = p.parent) {
        if (['object', 'function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration'].includes(p.type)) return {};
        if (types.has(p.type)) return { type: p.childForFieldName('name')?.text };
      }
      return {};
    }
    return facts?.lookup(node) ?? {};
  };
  const accesses = root.descendantsOfType(members);
  // Declared fields, including Go struct fields and Java multi-declarations.
  for (const node of root.descendantsOfType(fieldNodes)) {
    checkBudget();
    const owner = ownerOf(node);
    if (['required_parameter', 'optional_parameter'].includes(node.type)) {
      const method = enclosing(node, functions);
      if (language === 'typescript' && method?.childForFieldName('name')?.text === 'constructor'
        && node.children.some((c: any) => c.type === 'accessibility_modifier' || c.text === 'readonly')) addField(owner, node.childForFieldName('pattern'));
      continue;
    }
    if (language === 'java') {
      for (const decl of node.namedChildren.filter((c: any) => c.type === 'variable_declarator')) addField(owner, decl.childForFieldName('name'));
    } else if (language === 'go') {
      for (const name of node.childrenForFieldName('name')) addField(owner, name);
    } else addField(owner, node.childForFieldName('name'));
  }
  if (language === 'python') for (const node of root.descendantsOfType('assignment')) {
    const owner = enclosing(node, types);
    const fn = enclosing(node, functions);
    if (owner && (!fn || fn.startIndex < owner.startIndex)) addField(owner.childForFieldName('name')?.text, node.childForFieldName('left'));
  }
  // Dynamic own fields are declarations only for a proven `this`/`self` receiver.
  for (const node of accesses) {
    const object = node.childForFieldName('object') ?? node.childForFieldName('operand');
    const name = node.childForFieldName('property') ?? node.childForFieldName('attribute') ?? node.childForFieldName('field');
    const parent = node.parent;
    if (['javascript', 'python'].includes(language) && object && ['this', 'self', 'cls'].includes(object.text) && assignments.has(parent?.type) && parent.childForFieldName('left')?.id === node.id) {
      addField(receiver(object).type, name);
    }
  }
  const functionEntities = new Map<string, ParsedEntity[]>();
  for (const e of entities) if (e.kind === 'method' || e.kind === 'function') {
    const key = `${e.lineStart}:${e.lineEnd}`;
    const list = functionEntities.get(key) ?? [];
    list.push(e);
    functionEntities.set(key, list);
  }
  const grouped = new Map<string, ParsedRelationship>();
  const sitesSeen = new Map<ParsedRelationship, Set<string>>();
  const emit = (node: any, name: string, info: ReceiverType, write: boolean, value?: any): void => {
    if (!info.type && !info.factory) return;
    const fn = enclosing(node, functions);
    if (!fn) return;
    const candidates = functionEntities.get(`${fn.startPosition.row + 1}:${fn.endPosition.row + 1}`) ?? [];
    const functionName = fn.type === 'constructor_declaration' ? '<init>' : fn.childForFieldName('name')?.text
      ?? fn.parent?.childForFieldName('name')?.text;
    const named = candidates.filter(e => e.name === functionName && (!e.container || e.container === ownerOf(fn)));
    const entity = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!entity) return;
    const srcName = entity.container ? `${entity.container}.${entity.name}` : entity.name;
    const predicate = write ? 'WRITES' : 'READS';
    const chain = (info.chain ?? []).map(method => `.${method}()`).join('');
    const dstName = `${info.type ?? info.factory}${chain}.${name}`;
    const key = `${srcName}\0${predicate}\0${dstName}`;
    let rel = grouped.get(key);
    if (!rel) {
      rel = { srcName, dstName, predicate, receiverOnly: true, receiverType: info.type, receiverFactory: info.factory, ...(info.chain ? { receiverChain: info.chain } : {}), fieldSites: [] };
      grouped.set(key, rel);
      sitesSeen.set(rel, new Set());
      relationships.push(rel);
    }
    const site = { line: node.startPosition.row + 1, ...(write ? literal(value) : {}) };
    const siteKey = `${site.line}\0${site.value ?? ''}`;
    if (!sitesSeen.get(rel)!.has(siteKey)) {
      sitesSeen.get(rel)!.add(siteKey);
      rel.fieldSites!.push(site);
    }
  };
  const visitAccess = (node: any, name: any, info: ReceiverType): void => {
    if (!name || !/^[\w$]+$/.test(name.text)) return;
    const parent = node.parent?.type === 'expression_list' ? node.parent.parent : node.parent;
    const lhs = parent?.childForFieldName('left');
    const targets = lhs?.type === 'expression_list' ? lhs.namedChildren : [lhs];
    const index = targets.findIndex((n: any) => n?.id === node.id);
    const write = assignments.has(parent?.type) && index >= 0;
    const update = ['update_expression', 'inc_statement', 'dec_statement'].includes(parent?.type);
    const rhs = parent?.childForFieldName('right');
    const value = rhs?.type === 'expression_list' ? (rhs.namedChildCount === targets.length ? rhs.namedChild(index) : undefined) : rhs;
    const compound = parent?.type.includes('augmented') || (write && (parent.childForFieldName('operator')?.text ?? parent.children.find((c: any) => !c.isNamed && /=$/.test(c.text))?.text) !== '=');
    if (write || update) emit(node, name.text, info, true, compound || update ? undefined : value);
    if (!write || compound || update) emit(node, name.text, info, false);
  };
  for (const node of accesses) {
    checkBudget();
    const object = node.childForFieldName('object') ?? node.childForFieldName('operand');
    const name = node.childForFieldName('property') ?? node.childForFieldName('attribute') ?? node.childForFieldName('field');
    visitAccess(node, name, receiver(object));
  }
  if (language === 'java') {
    // Java permits implicit-this field access. A local/parameter of the same name
    // suppresses it for the entire function; conservatively skip shadowed uses.
    const locals = new Map<number, Set<string>>();
    for (const node of root.descendantsOfType('identifier')) {
      const owner = ownerOf(node);
      if (!owner || !fields.has(`${owner}.${node.text}`)) continue;
      const fn = enclosing(node, functions);
      if (!fn) continue;
      const parent = node.parent;
      if (['formal_parameter', 'scoped_identifier', 'object_creation_expression'].includes(parent?.type)) continue;
      if (parent?.type === 'field_access' && parent.childForFieldName('field')?.id === node.id) continue;
      if (['method_invocation', 'variable_declarator'].includes(parent?.type) && parent.childForFieldName('name')?.id === node.id) continue;
      let names = locals.get(fn.id);
      if (!names) {
        names = new Set<string>();
        for (const decl of fn.descendantsOfType(['formal_parameter', 'catch_formal_parameter', 'variable_declarator', 'enhanced_for_statement', 'resource', 'type_pattern', 'lambda_expression'])) {
          const name = decl.childForFieldName('name');
          if (name) names.add(name.text);
          if (decl.type === 'lambda_expression') {
            const params = decl.childForFieldName('parameters');
            if (params?.type === 'identifier') names.add(params.text);
            for (const id of params?.descendantsOfType('identifier') ?? []) names.add(id.text);
          }
          if (decl.type === 'type_pattern') for (const id of decl.descendantsOfType('identifier')) names.add(id.text);
        }
        locals.set(fn.id, names);
      }
      if (!names.has(node.text)) visitAccess(node, node, { type: owner });
    }
  }
  if (language === 'typescript' || language === 'javascript') for (const node of root.descendantsOfType('pair')) {
    const object = node.parent;
    const decl = object?.parent;
    // Only a directly typed object literal, never an object inferred by key names.
    if (decl?.type !== 'variable_declarator' || decl.childForFieldName('value')?.id !== object.id) continue;
    const key = node.childForFieldName('key');
    if (key?.type === 'property_identifier') emit(node, key.text, { type: typeText(decl.childForFieldName('type')) }, true, node.childForFieldName('value'));
  }
  if (language === 'go') for (const node of root.descendantsOfType('keyed_element')) {
    checkBudget();
    const composite = enclosing(node, new Set(['composite_literal']));
    const key = node.childForFieldName('key')?.firstNamedChild;
    const value = node.childForFieldName('value')?.firstNamedChild;
    if (key?.type === 'identifier') emit(node, key.text, { type: typeText(composite?.childForFieldName('type')) }, true, value);
  }
}
