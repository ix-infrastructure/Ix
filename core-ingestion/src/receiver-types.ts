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
const blocks = new Set(['block', 'statement_block', 'template_body', 'class_body', 'for_statement', 'for_in_statement', 'catch_clause',
  'if_statement', 'expression_switch_statement', 'type_switch_statement', 'case_clause', 'for_expression']);

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
  const scopeOf = (node: any, classOnly = false): any => {
    for (let p = node.parent; p; p = p.parent) {
      if (classes.has(p.type) || (!classOnly && (functions.has(p.type) || blocks.has(p.type)))) return p;
    }
    return root;
  };
  const functionScope = (node: any): any => {
    // Static blocks and TypeScript namespaces also own their var declarations.
    for (let p = node.parent; p; p = p.parent) {
      if (functions.has(p.type) || p.type === 'class_static_block' || p.type === 'internal_module') return p;
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
  const stack = [root];
  while (stack.length) {
    checkBudget();
    const node = stack.pop()!;
    const name = node.childForFieldName('name');
    if (node.type === 'type_alias_declaration' && name) {
      const scope = scopeOf(node);
      const names = typeParameters.get(scope.id) ?? new Set<string>();
      names.add(name.text);
      typeParameters.set(scope.id, names);
    }
    if (classes.has(node.type) || functions.has(node.type)) {
      const generics = node.childForFieldName('type_parameters');
      if (generics) typeParameters.set(node.id, new Set(generics.namedChildren
        .map((p: any) => p.childForFieldName('name')?.text ?? p.firstNamedChild?.text)));
      const singleParameter = node.childForFieldName('parameter');
      if (singleParameter?.type === 'identifier') bind(node, singleParameter.text, {});
    }
    if (language === 'scala' && classes.has(node.type)) {
      const extend = node.childForFieldName('extend');
      for (const parent of extend?.namedChildren ?? []) {
        const type = typeName(parent);
        if (name && type) heritage.push([name.text, type]);
      }
      if (node.type === 'class_definition' && /^(?:(?:final|sealed|private|protected|abstract)\s+)*case\s+class\b/.test(node.text)) factories.push([name.text, name.text]);
    }
    if (language === 'go' && node.type === 'function_declaration') {
      const result = typeName(node.childForFieldName('result'));
      if (name && result) factories.push([name.text, result]);
    }
    if (language === 'scala' && node.type === 'function_definition' && name?.text === 'apply') {
      const owner = scopeOf(node, true);
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
    let owner = scopeOf(node);
    if (language === 'typescript' && node.type === 'variable_declarator' && node.parent?.type === 'variable_declaration') {
      owner = functionScope(node);
    }
    if (['function_definition', 'function_declaration'].includes(node.type) && name && owner !== root && !classes.has(owner.type) && !['template_body', 'class_body'].includes(owner.type)) {
      bind(owner, name.text, {});
    }
    let annotation = node.childForFieldName('type');
    let value = node.childForFieldName('value');
    if (['variable_declarator', 'public_field_definition', 'var_spec'].includes(node.type)) binding = name;
    if (['val_definition', 'var_definition', 'val_declaration', 'var_declaration'].includes(node.type) && language === 'scala') binding = node.childForFieldName('pattern');
    if (['required_parameter', 'optional_parameter', 'parameter', 'class_parameter', 'parameter_declaration'].includes(node.type)) {
      binding = name ?? node.childForFieldName('pattern');
      // Parameter-list nodes are not scopes; owner is their enclosing function/class.
      owner = scopeOf(node, node.type === 'class_parameter');
      if (language === 'typescript' && node.children.some((n: any) => n.type === 'accessibility_modifier' || n.type === 'readonly')) {
        if (binding?.type === 'identifier') bind(scopeOf(node, true), binding.text, { type: typeName(annotation) });
      }
    }
    if (node.type === 'short_var_declaration') {
      const left = node.childForFieldName('left')?.namedChildren ?? [];
      const right = node.childForFieldName('right')?.namedChildren ?? [];
      for (let i = 0; i < left.length; i++) if (left[i].type === 'identifier') bind(owner, left[i].text, { ...(left.length === right.length ? valueType(right[i]) : {}), available: node.endIndex });
    }
    if (node.type === 'range_clause') for (const id of node.childForFieldName('left')?.namedChildren ?? []) {
      if (id.type === 'identifier') bind(owner, id.text, {});
    }
    // Binders whose type is not inferred still shadow an outer receiver.
    if (node.type === 'for_in_statement') {
      const declared = node.children.some((c: any) => ['const', 'let', 'var'].includes(c.type));
      // `for (x of xs)` without a declaration assigns an existing binding.
      if (!declared) mutations.push(node);
      else bindPattern(node.children.some((c: any) => c.type === 'var') ? functionScope(node) : node, node.childForFieldName('left'));
    }
    if (node.type === 'lambda_expression') bindPattern(node, node.childForFieldName('parameters'));
    if (node.type === 'case_clause') bindPattern(node, node.childForFieldName('pattern'));
    if (node.type === 'enumerator') {
      const forExpression = scopeOf(node);
      if (forExpression.type === 'for_expression') bindPattern(forExpression, node.firstNamedChild);
    }
    if (node.type === 'type_switch_statement') bindPattern(node, node.childForFieldName('alias'));
    if (node.type === 'catch_clause') {
      const parameter = node.childForFieldName('parameter');
      if (parameter?.type === 'identifier') bind(node, parameter.text, {});
    }
    if (binding) {
      const info = typeName(annotation) ? { type: typeName(annotation) } : valueType(value);
      const local = ['variable_declarator', 'val_definition', 'var_definition', 'var_spec'].includes(node.type) &&
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
    if (['assignment_expression', 'assignment_statement', 'assignment', 'update_expression'].includes(node.type)) mutations.push(node);
    stack.push(...[...node.namedChildren].reverse());
  }
  const lookupName = (node: any, name: string, field = false): ReceiverType | undefined => {
    for (let p = node; p; p = p.parent) {
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
      if (field && classes.has(p.type)) return;
    }
  };
  // Package/companion return facts apply only when the call still names that
  // factory. A local variable, parameter or function can shadow its spelling.
  for (const bindings of scopes.values()) for (const info of bindings.values()) {
    if (info.factory && info.factoryNode && lookupName(info.factoryNode, info.factory.split('.')[0]) !== undefined) delete info.factory;
  }
  // Without dataflow, a reassigned binding is unknown throughout its scope.
  for (const node of mutations) {
    const left = node.childForFieldName('left') ?? node.childForFieldName('argument');
    for (const id of left?.type === 'expression_list' ? left.namedChildren : [left]) {
      if (id?.type !== 'identifier') continue;
      const info = lookupName(node, id.text);
      if (info) { delete info.type; delete info.factory; }
    }
  }
  return {
    factories, heritage,
    package: language === 'scala'
      ? root.namedChildren.find((node: any) => node.type === 'package_clause')?.childForFieldName('name')?.text
      : language === 'go' ? root.namedChildren.find((node: any) => node.type === 'package_clause')?.firstNamedChild?.text : undefined,
    lookup(node: any): ReceiverType | undefined {
      if (node.type === 'identifier') return lookupName(node, node.text);
      if (node.type === 'member_expression' && node.childForFieldName('object')?.type === 'this') {
        return lookupName(node, node.childForFieldName('property')?.text, true) ?? {};
      }
      if (node.type === 'field_expression' && node.childForFieldName('value')?.text === 'this') {
        return lookupName(node, node.childForFieldName('field')?.text, true) ?? {};
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
