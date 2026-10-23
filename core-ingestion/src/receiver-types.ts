// Copyright 2026 Ix Infrastructure Inc.

/** Conservative lexical inference. Unknown bindings deliberately stop lookup. */
export interface ReceiverType {
  type?: string;
  factory?: string;
}

export interface ReceiverFacts {
  factories: Array<[string, string]>;
  heritage: Array<[string, string]>;
  package?: string;
  /** Names some binding in the file gives a type or factory; no other name can resolve to one. */
  typedNames: ReadonlySet<string>;
  lookup(node: any): ReceiverType | undefined;
}

interface ReceiverBinding extends ReceiverType {
  available?: number;
  factoryNode?: any;
}

const classes = new Set(['class_definition', 'trait_definition', 'object_definition', 'class_declaration', 'abstract_class_declaration', 'class']);
const functions = new Set(['function_definition', 'function_declaration', 'method_declaration', 'method_definition', 'arrow_function', 'function_expression', 'func_literal', 'lambda_expression', 'method_signature', 'abstract_method_signature', 'function_signature']);
// Also the statements that own a binding of their own: Go `if x := …;`,
// `switch x := v.(type)`, Scala `case x: T =>` and `for (x <- xs)`.
// TypeScript functions that bind their own `this` (arrow functions do not).
const thisFunctions = new Set(['function_declaration', 'function_expression', 'generator_function', 'generator_function_declaration']);
const blocks = new Set(['block', 'statement_block', 'template_body', 'class_body', 'for_statement', 'for_in_statement', 'catch_clause',
  'if_statement', 'expression_switch_statement', 'type_switch_statement', 'case_clause', 'for_expression']);

const bindingTypes = ['variable_declarator', 'public_field_definition', 'var_spec', 'val_definition', 'var_definition', 'val_declaration', 'var_declaration'];
const parameterTypes = ['required_parameter', 'optional_parameter', 'parameter', 'class_parameter', 'parameter_declaration'];
const mutationTypes = ['assignment_expression', 'augmented_assignment_expression', 'assignment_statement', 'assignment', 'update_expression'];
// Node types whose `name` field is read, and every non-scope type visited.
const named = new Set(['type_alias_declaration', ...classes, ...functions, ...bindingTypes, ...parameterTypes]);
const visited = new Set([...named, ...mutationTypes, 'short_var_declaration', 'range_clause', 'for_in_statement', 'case_clause', 'enumerator',
  'type_switch_statement', 'catch_clause', 'infix_expression']);
const isScope = (type: string): boolean =>
  classes.has(type) || functions.has(type) || blocks.has(type) || type === 'class_static_block' || type === 'internal_module';
// Every node type the walk stops at: the scopes and the visited types.
const walkedTypes = [...new Set([...classes, ...functions, ...blocks, 'class_static_block', 'internal_module', ...visited])];

function typeName(node: any): string | undefined {
  if (!node) return;
  if (node.type === 'type_annotation' || node.type === 'pointer_type') return typeName(node.firstNamedChild);
  if (node.type === 'generic_type') return typeName(node.childForFieldName('name') ?? node.firstNamedChild);
  // Unions, tuples, structural types and type parameters are not a concrete receiver.
  if (/^(?:type_identifier|identifier|qualified_type|nested_type_identifier|stable_type_identifier)$/.test(node.type)) {
    const text = node.text.replace(/\s/g, '');
    if (/^[\w$]+(?:\.[\w$]+)*$/.test(text)) return text;
  }
}

export function collectReceiverFacts(root: any, language: string, checkBudget: () => void): ReceiverFacts {
  const scopes = new Map<number, Map<string, ReceiverBinding>>();
  const typeParameters = new Map<number, Set<string>>();
  const factories: Array<[string, string]> = [];
  const heritage: Array<[string, string]> = [];
  // Scope ancestors of the node being visited, innermost last. Tracking them
  // during the walk avoids a parent-chain walk per node.
  const frames: Array<{ node: any; type: string; end: number }> = [];
  const scopeOf = (classOnly = false): any => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const type = frames[i].type;
      if (classes.has(type) || (!classOnly && (functions.has(type) || blocks.has(type)))) return frames[i].node;
    }
    return root;
  };
  const functionScope = (): any => {
    // Static blocks and TypeScript namespaces also own their var declarations.
    for (let i = frames.length - 1; i >= 0; i--) {
      const type = frames[i].type;
      if (functions.has(type) || type === 'class_static_block' || type === 'internal_module') return frames[i].node;
    }
    return root;
  };
  const bind = (scope: any, name: string, info: ReceiverBinding): void => {
    if (!scopes.has(scope.id)) scopes.set(scope.id, new Map());
    scopes.get(scope.id)!.set(name, info);
  };
  const valueType = (value: any): ReceiverBinding => {
    if (!value) return {};
    if (value.type === 'new_expression') return { type: typeName(value.childForFieldName('constructor')) };
    if (value.type === 'instance_expression') return { type: typeName(value.firstNamedChild) };
    if (value.type === 'unary_expression' && value.text.startsWith('&')) return valueType(value.childForFieldName('operand'));
    if (value.type === 'composite_literal') return { type: typeName(value.childForFieldName('type')) };
    if (value.type === 'call_expression') {
      const fn = value.childForFieldName('function')?.text;
      if (fn && /^[\w$]+(?:\.[\w$]+)*$/.test(fn) && (language === 'scala' || /(?:^|\.)New\w+$/.test(fn))) {
        return { factory: fn, factoryNode: value.childForFieldName('function') };
      }
    }
    return {};
  };
  const mutations: any[] = [];
  // Every name a pattern binds. Scala pattern names start lowercase (an
  // uppercase one, or a dotted path, refers to an existing value).
  const bindPattern = (scope: any, pattern: any): void => {
    const pending = pattern ? [pattern] : [];
    while (pending.length) {
      const p = pending.pop()!;
      if (p.type === 'identifier' || p.type === 'shorthand_property_identifier_pattern') {
        if (language !== 'scala' || (/^[a-z_]/.test(p.text) && p.parent?.type !== 'stable_identifier')) bind(scope, p.text, {});
      } else pending.push(...p.namedChildren);
    }
  };
  const visit = (node: any, type: string): void => {
    const name = named.has(type) ? node.childForFieldName('name') : null;
    if (type === 'type_alias_declaration' && name) {
      const scope = scopeOf();
      const names = typeParameters.get(scope.id) ?? new Set<string>();
      names.add(name.text);
      typeParameters.set(scope.id, names);
    }
    if (classes.has(type) || functions.has(type)) {
      const generics = node.childForFieldName('type_parameters');
      if (generics) typeParameters.set(node.id, new Set(generics.namedChildren
        .map((p: any) => p.childForFieldName('name')?.text ?? p.firstNamedChild?.text)));
      const singleParameter = node.childForFieldName('parameter');
      if (singleParameter?.type === 'identifier') bind(node, singleParameter.text, {});
    }
    if (language === 'scala' && classes.has(type)) {
      const extend = node.childForFieldName('extend');
      for (const parent of extend?.namedChildren ?? []) {
        const parentType = typeName(parent);
        if (name && parentType) heritage.push([name.text, parentType]);
      }
      if (type === 'class_definition' && /^(?:(?:final|sealed|private|protected|abstract)\s+)*case\s+class\b/.test(node.text)) factories.push([name.text, name.text]);
    }
    if (language === 'go' && type === 'function_declaration') {
      const result = typeName(node.childForFieldName('result'));
      if (name && result) factories.push([name.text, result]);
    }
    if (language === 'scala' && type === 'function_definition' && name?.text === 'apply') {
      const owner = scopeOf(true);
      const body = node.childForFieldName('body');
      const result = typeName(node.childForFieldName('return_type')) ?? valueType(body).type;
      const ownerName = owner.childForFieldName('name')?.text;
      // Keep unknown/overloaded apply definitions as blockers, including case-class companions.
      if (ownerName && owner.type === 'object_definition') {
        factories.push([`${ownerName}.apply`, result ?? '']);
        factories.push([ownerName, result ?? '']);
      }
    }
    let binding: any;
    let owner = scopeOf();
    if (language === 'typescript' && type === 'variable_declarator' && node.parent?.type === 'variable_declaration') {
      owner = functionScope();
    }
    if (['function_definition', 'function_declaration'].includes(type) && name && owner !== root && !classes.has(owner.type) && !['template_body', 'class_body'].includes(owner.type)) {
      bind(owner, name.text, {});
    }
    const declares = bindingTypes.includes(type) || parameterTypes.includes(type);
    const annotation = declares ? node.childForFieldName('type') : null;
    const value = declares ? node.childForFieldName('value') : null;
    if (['variable_declarator', 'public_field_definition', 'var_spec'].includes(type)) binding = name;
    if (['val_definition', 'var_definition', 'val_declaration', 'var_declaration'].includes(type) && language === 'scala') binding = node.childForFieldName('pattern');
    if (parameterTypes.includes(type)) {
      binding = name ?? node.childForFieldName('pattern');
      // Parameter-list nodes are not scopes; owner is their enclosing function/class.
      owner = scopeOf(type === 'class_parameter');
      if (language === 'typescript' && node.children.some((n: any) => n.type === 'accessibility_modifier' || n.type === 'readonly')) {
        if (binding?.type === 'identifier') bind(scopeOf(true), binding.text, { type: typeName(annotation) });
      }
    }
    if (type === 'short_var_declaration') {
      const left = node.childForFieldName('left')?.namedChildren ?? [];
      const right = node.childForFieldName('right')?.namedChildren ?? [];
      for (let i = 0; i < left.length; i++) if (left[i].type === 'identifier') bind(owner, left[i].text, { ...(left.length === right.length ? valueType(right[i]) : {}), available: node.endIndex });
    }
    if (type === 'range_clause') for (const id of node.childForFieldName('left')?.namedChildren ?? []) {
      if (id.type === 'identifier') bind(owner, id.text, {});
    }
    // Binders whose type is not inferred still shadow an outer receiver.
    if (type === 'for_in_statement') {
      const declared = node.children.some((c: any) => ['const', 'let', 'var'].includes(c.type));
      // `for (x of xs)` without a declaration assigns an existing binding.
      if (!declared) mutations.push(node);
      else bindPattern(node.children.some((c: any) => c.type === 'var') ? functionScope() : node, node.childForFieldName('left'));
    }
    if (type === 'lambda_expression') bindPattern(node, node.childForFieldName('parameters'));
    if (type === 'case_clause') bindPattern(node, node.childForFieldName('pattern'));
    if (type === 'enumerator') {
      const forExpression = scopeOf();
      if (forExpression.type === 'for_expression') bindPattern(forExpression, node.firstNamedChild);
    }
    if (type === 'type_switch_statement') bindPattern(node, node.childForFieldName('alias'));
    if (type === 'catch_clause') {
      const parameter = node.childForFieldName('parameter');
      if (parameter?.type === 'identifier') bind(node, parameter.text, {});
    }
    if (binding) {
      const info = typeName(annotation) ? { type: typeName(annotation) } : valueType(value);
      const local = ['variable_declarator', 'val_definition', 'var_definition', 'var_spec'].includes(type) &&
        !['template_body', 'class_body'].includes(owner.type);
      if (local) Object.assign(info, { available: node.endIndex });
      if (binding.type === 'identifier' || binding.type === 'property_identifier') bind(owner, binding.text, info);
      else {
        // A destructured binding shadows outer values even when its type is unknown.
        const pending = [binding];
        while (pending.length) {
          const p = pending.pop()!;
          if (p.type === 'identifier' || p.type === 'shorthand_property_identifier_pattern') bind(owner, p.text, {});
          pending.push(...p.namedChildren);
        }
      }
      // Go permits several names with a single annotation.
      if (language === 'go') for (const child of node.childrenForFieldName('name')) bind(owner, child.text, info);
    }
    if (mutationTypes.includes(type)) mutations.push(node);
    // Scala `x += y` on a var is `x = x + y` (comparisons are not assignments).
    if (type === 'infix_expression' && /^[^=]*[^=<>!]=$/.test(node.childForFieldName('operator')?.text ?? '')) mutations.push(node);
  };
  // Only scopes and the node types in `visited` carry facts. tree-sitter finds
  // them natively, in document order, so no other node is ever materialized.
  // A node after a scope in that order is inside it unless it starts at or
  // past the scope's end; only a zero-width node at the end is ambiguous.
  const within = (frame: { node: any; end: number }, node: any): boolean => {
    if (node.startIndex !== frame.end) return node.startIndex < frame.end;
    if (node.endIndex !== frame.end) return false;
    for (let p = node.parent; p; p = p.parent) if (p.id === frame.node.id) return true;
    return false;
  };
  for (const node of root.descendantsOfType(walkedTypes)) {
    // Types are matched by name, and `class` is also a keyword.
    if (!node.isNamed) continue;
    checkBudget();
    while (frames.length && !within(frames[frames.length - 1], node)) frames.pop();
    const type: string = node.type;
    visit(node, type);
    if (isScope(type)) frames.push({ node, type, end: node.endIndex });
  }
  const lookupName = (node: any, name: string, field = false): ReceiverType | undefined => {
    for (let p = node; p; p = p.parent) {
      // A non-arrow function or an object-literal method gives `this` a
      // value of its own, not the enclosing class instance.
      if (field && (thisFunctions.has(p.type) || (p.type === 'method_definition' && p.parent?.type !== 'class_body'))) return;
      if (field && !classes.has(p.type) && !['template_body', 'class_body'].includes(p.type)) continue;
      // A bare TypeScript name never refers to a field or parameter property.
      if (!field && language === 'typescript' && (classes.has(p.type) || p.type === 'class_body')) continue;
      const bindings = scopes.get(p.id);
      if (bindings?.has(name)) {
        const info = bindings.get(name)!;
        if (info.available !== undefined && info.available > node.startIndex) return {};
        if (info.type) for (let scope = node; scope; scope = scope.parent) {
          if (typeParameters.get(scope.id)?.has(info.type)) return {};
        }
        return info;
      }
      // A Scala anonymous class (`new T { … }`) is its own `this`.
      if (field && (classes.has(p.type) || (p.type === 'template_body' && !classes.has(p.parent?.type)))) return;
    }
  };
  // Package/companion return facts apply only when the call still names that
  // factory. A local variable, parameter or function can shadow its spelling.
  for (const bindings of scopes.values()) for (const info of bindings.values()) {
    if (info.factory && info.factoryNode && lookupName(info.factoryNode, info.factory.split('.')[0]) !== undefined) delete info.factory;
  }
  // Without dataflow, a reassigned binding is unknown throughout its scope.
  for (const node of mutations) {
    // Every name the target assigns: `x`, Go `x, y`, and destructuring
    // `[x] = …` / `({ a: x, y } = …)`. A member or index target (`o.x = …`)
    // assigns no binding.
    const pending = [node.childForFieldName('left') ?? node.childForFieldName('argument')];
    while (pending.length) {
      const id = pending.pop();
      if (!id || ['member_expression', 'subscript_expression', 'field_expression', 'selector_expression', 'index_expression'].includes(id.type)) continue;
      if (id.type === 'identifier' || id.type === 'shorthand_property_identifier_pattern') {
        const info = lookupName(node, id.text);
        if (info) { delete info.type; delete info.factory; }
      } else if (id.type === 'pair_pattern') pending.push(id.childForFieldName('value'));
      else pending.push(...id.namedChildren);
    }
  }
  const typedNames = new Set<string>();
  for (const bindings of scopes.values()) for (const [name, info] of bindings) if (info.type || info.factory) typedNames.add(name);
  return {
    factories, heritage, typedNames,
    // Chained Scala clauses (`package a` then `package b`) declare package `a.b`.
    package: language === 'scala'
      ? root.namedChildren.filter((node: any) => node.type === 'package_clause')
        .map((node: any) => node.childForFieldName('name')?.text).filter(Boolean).join('.') || undefined
      : language === 'go' ? root.namedChildren.find((node: any) => node.type === 'package_clause')?.firstNamedChild?.text : undefined,
    // A name no binding gives a type or factory skips the scope walk: it
    // cannot resolve to one, whatever binds it.
    lookup(node: any): ReceiverType | undefined {
      if (node.type === 'identifier') {
        const name = node.text;
        return typedNames.has(name) ? lookupName(node, name) : {};
      }
      if (node.type === 'member_expression' && node.childForFieldName('object')?.type === 'this') {
        const name = node.childForFieldName('property')?.text;
        return (typedNames.has(name) ? lookupName(node, name, true) : undefined) ?? {};
      }
      if (node.type === 'field_expression' && node.childForFieldName('value')?.text === 'this') {
        const name = node.childForFieldName('field')?.text;
        return (typedNames.has(name) ? lookupName(node, name, true) : undefined) ?? {};
      }
    },
  };
}

/**
 * The inferred receiver of a member call, given the call's member-name node:
 * `dep.run()` (TS), `dep.run()` (Scala), `dep.Run()` (Go). Only a receiver with
 * an inferred type or factory counts; `receiver` is its source text.
 */
export function callReceiver(nameNode: any, facts: ReceiverFacts): (ReceiverType & { receiver: string }) | undefined {
  if (facts.typedNames.size === 0) return;
  const member = nameNode.parent;
  const field = member?.type === 'member_expression' ? 'object'
    : member?.type === 'field_expression' ? 'value'
      : member?.type === 'selector_expression' ? 'operand' : undefined;
  const call = member?.parent;
  if (!field || call?.type !== 'call_expression' || call.childForFieldName('function')?.id !== member.id) return;
  const receiver = member.childForFieldName(field);
  if (!receiver || receiver.id === nameNode.id) return;
  const info = facts.lookup(receiver);
  return info?.type || info?.factory ? { type: info.type, factory: info.factory, receiver: receiver.text } : undefined;
}
