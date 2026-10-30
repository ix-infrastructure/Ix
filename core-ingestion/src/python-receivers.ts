// Copyright 2026 Ix Infrastructure Inc.

import type { ReceiverFacts, ReceiverType } from './receiver-types.js';

type Binding = { at: number; type?: string; source?: 'import' | 'class' };
type Scope = { parent?: Scope; node: any; start: number; end: number; name?: string; bindings: Map<string, Binding[]>; owner?: Scope; fields: Map<string, string | undefined> };

/** Lexical facts only: assignments never establish a type by member name. */
export function collectPythonReceiverFacts(root: any, checkBudget: () => void): ReceiverFacts & { isBound(node: any): boolean } {
  const scopes: Scope[] = [];
  const heritage: Array<[string, string]> = [];
  const importedNames = new Set<string>();
  const concrete = (node: any): string | undefined => {
    if (node?.type === 'type') return concrete(node.firstNamedChild);
    if (node?.type === 'string') return /^["'][\w.]+["']$/.test(node.text) ? node.text.slice(1, -1) : undefined;
    return node && /^(identifier|attribute|dotted_name)$/.test(node.type) && /^[\w]+(?:\.[\w]+)*$/.test(node.text) ? node.text : undefined;
  };
  const bind = (scope: Scope, name: string, at: number, type?: string, source?: Binding['source']) => {
    const events = scope.bindings.get(name) ?? [];
    events.push({ at, type, source });
    scope.bindings.set(name, events);
  };
  const lookupName = (scope: Scope | undefined, name: string, at: number): string | undefined => {
    for (let s = scope; s; s = s.parent) {
      const events = s.bindings.get(name);
      if (events) return events.filter(e => e.at <= at).at(-1)?.type;
    }
  };
  const visibleType = (name: string | undefined, scope: Scope, at: number): string | undefined => {
    if (!name) return;
    const head = name.split('.')[0];
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const events = s.bindings.get(head);
      if (events) return events.filter(e => e.at <= at).at(-1)?.source ? name : undefined;
    }
    // Keep syntactic type hints for unresolved constructors, but never borrow
    // an import that only exists in another lexical scope.
    return importedNames.has(head) ? undefined : name;
  };
  const expressionType = (node: any, scope: Scope): string | undefined => {
    if (node?.type === 'call') {
      const fn = node.childForFieldName('function');
      const name = concrete(fn);
      if (!name) return;
      // A local parameter/assignment can shadow a constructor or import.
      return visibleType(name, scope, node.startIndex);
    }
    if (node?.type === 'identifier') return lookupName(scope, node.text, node.startIndex);
  };
  const setField = (owner: Scope, name: string, type?: string) => {
    // Conflicting writes (including unknown writes) invalidate the field.
    owner.fields.set(name, owner.fields.has(name) && owner.fields.get(name) !== type ? undefined : type);
  };
  const global: Scope = { node: root, start: 0, end: root.endIndex, bindings: new Map(), fields: new Map() };
  const frames = [global];
  const branches: Array<{ end: number; scope: Scope }> = [];
  const comprehensionTypes = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
  const inOuterIterable = (scope: Scope, node: any): boolean => {
    if (!comprehensionTypes.has(scope.node.type)) return false;
    const iterable = scope.node.namedChildren.find((c: any) => c.type === 'for_in_clause')?.childForFieldName('right');
    return iterable && iterable.startIndex <= node.startIndex && node.endIndex <= iterable.endIndex;
  };
  const branchTypes = new Set(['if_statement', 'for_statement', 'while_statement', 'try_statement', 'match_statement']);
  const bindTarget = (scope: Scope, target: any, at: number) => {
    if (target?.type === 'identifier') bind(scope, target.text, at);
    else if (target && /^(tuple_pattern|list_pattern|pattern_list|tuple|list|as_pattern_target)$/.test(target.type)) {
      for (const child of target.namedChildren) bindTarget(scope, child, at);
    }
  };
  const bindPattern = (scope: Scope, pattern: any, at: number) => {
    checkBudget();
    if (pattern.type === 'identifier') {
      if (pattern.text !== '_') bind(scope, pattern.text, at);
    } else if (pattern.type === 'dotted_name') {
      // A single name captures; a dotted name compares an existing value.
      if (pattern.namedChildCount === 1) bindPattern(scope, pattern.firstNamedChild, at);
    } else if (pattern.type === 'class_pattern' || pattern.type === 'keyword_pattern') {
      // Class names and keyword labels are references, not capture targets.
      for (const child of pattern.namedChildren.slice(1)) bindPattern(scope, child, at);
    } else if (pattern.type === 'dict_pattern') {
      // Mapping keys are value expressions; only values and **rest bind names.
      for (const value of pattern.childrenForFieldName('value')) bindPattern(scope, value, at);
      for (const child of pattern.namedChildren.filter((c: any) => c.type === 'splat_pattern')) bindPattern(scope, child, at);
    } else if (/^(case_pattern|as_pattern|splat_pattern|union_pattern|list_pattern|tuple_pattern)$/.test(pattern.type)) {
      for (const child of pattern.namedChildren) bindPattern(scope, child, at);
    }
  };
  const nodes = root.descendantsOfType(['class_definition', 'function_definition', 'lambda', 'assignment',
    'augmented_assignment', 'named_expression', ...comprehensionTypes, ...branchTypes, 'with_item', 'except_clause', 'case_clause', 'import_from_statement', 'import_statement', 'delete_statement']);
  for (const node of nodes) {
    if (node.type !== 'import_from_statement' && node.type !== 'import_statement') continue;
    for (const item of node.childrenForFieldName('name')) {
      const local = item.type === 'aliased_import' ? item.childForFieldName('alias')?.text : item.text.split('.')[0];
      if (local) importedNames.add(local);
    }
  }
  for (const node of nodes) {
    checkBudget();
    while (frames.length > 1 && frames.at(-1)!.end <= node.startIndex) frames.pop();
    while (branches.length && branches.at(-1)!.end <= node.startIndex) branches.pop();
    let current = frames.at(-1)!;
    // Only the first iterable is evaluated outside a comprehension's scope.
    while (current.parent && inOuterIterable(current, node)) current = current.parent;
    let scope = current;
    if (node.type === 'class_definition' || node.type === 'function_definition' || node.type === 'lambda' || comprehensionTypes.has(node.type)) {
      const isClass = node.type === 'class_definition';
      const name = node.childForFieldName('name')?.text;
      if (name) bind(current, name, node.startIndex, isClass ? name : undefined, isClass ? 'class' : undefined);
      scope = { node, start: node.startIndex, end: node.endIndex, name, parent: current, bindings: new Map(), fields: new Map(), owner: isClass ? undefined : current.owner };
      if (isClass) {
        scope.owner = scope;
        for (const base of node.childForFieldName('superclasses')?.namedChildren ?? []) {
          // Match heritage queries: Base[T] inherits the subscripted class.
          const type = concrete(base.type === 'subscript' ? base.childForFieldName('value') : base);
          if (type) heritage.push([name, type]);
        }
      } else if (comprehensionTypes.has(node.type)) {
        // The body precedes its for-clauses in the syntax tree. All iteration
        // targets shadow outer bindings throughout this separate Python scope.
        for (const clause of node.namedChildren.filter((c: any) => c.type === 'for_in_clause')) {
          bindTarget(scope, clause.childForFieldName('left'), 0);
        }
      } else {
        const params = node.childForFieldName('parameters');
        for (const param of params?.namedChildren ?? []) {
          const id = param.type === 'identifier' ? param : param.childForFieldName('name') ?? param.namedChildren.find((c: any) => c.type === 'identifier');
          if (id) bind(scope, id.text, 0, visibleType(concrete(param.childForFieldName('type')), current, node.startIndex));
        }
        // Only a direct instance/class method owns its first parameter.
        const first = params?.firstNamedChild;
        const firstName = first?.type === 'identifier' ? first.text : first?.childForFieldName('name')?.text;
        const decorators = node.parent?.type === 'decorated_definition' ? node.parent.namedChildren.filter((c: any) => c.type === 'decorator') : [];
        if (current.node.type === 'class_definition' && (firstName === 'self' || firstName === 'cls') && !decorators.some((d: any) => d.text === '@staticmethod')) {
          bind(scope, firstName, 0, current.name);
        }
      }
      scopes.push(scope);
      frames.push(scope);
    }
    if (branchTypes.has(node.type)) branches.push({ end: node.endIndex, scope });
    if (node.type === 'import_from_statement' || node.type === 'import_statement') {
      for (const item of node.childrenForFieldName('name')) {
        const local = item.type === 'aliased_import' ? item.childForFieldName('alias')?.text : item.text.split('.')[0];
        if (local) bind(scope, local, node.endIndex, node.type === 'import_from_statement' ? local : undefined, 'import');
      }
    }
    if (node.type === 'assignment' || node.type === 'augmented_assignment' || node.type === 'named_expression') {
      const conditional = branches.some(branch => branch.scope === scope);
      const left = node.childForFieldName('left') ?? node.childForFieldName('name');
      const value = node.childForFieldName('right') ?? node.childForFieldName('value');
      const type = conditional || node.type === 'augmented_assignment' ? undefined : visibleType(concrete(node.childForFieldName('type')), scope, node.startIndex) ?? expressionType(value, scope);
      if (left?.type === 'identifier') {
        if (scope.node.type === 'class_definition') setField(scope, left.text, type);
        else bind(scope, left.text, node.endIndex, type);
      } else if (left?.type === 'attribute' && scope.owner) {
        const object = left.childForFieldName('object');
        if (object?.text === 'self' && lookupName(scope, 'self', node.startIndex) === scope.owner.name) {
          const init = scope.name === '__init__';
          setField(scope.owner, left.childForFieldName('attribute').text, init ? type : undefined);
        }
      } else if (left) {
        for (const id of left.descendantsOfType('identifier')) bind(scope, id.text, node.endIndex);
      }
    }
    if (node.type === 'delete_statement') {
      for (const id of node.descendantsOfType('identifier')) bind(scope, id.text, node.endIndex);
    }
    if (node.type === 'for_statement') {
      bindTarget(scope, node.childForFieldName('left'), node.startIndex);
    }
    if (node.type === 'with_item') {
      const value = node.childForFieldName('value');
      if (value?.type === 'as_pattern') bindTarget(scope, value.childForFieldName('alias'), node.endIndex);
    }
    if (node.type === 'except_clause') {
      const value = node.childForFieldName('value');
      const alias = node.childForFieldName('alias') ?? (value?.type === 'as_pattern' ? value.childForFieldName('alias') : undefined);
      if (alias) bindTarget(scope, alias, alias.endIndex);
    }
    if (node.type === 'case_clause') {
      for (const pattern of node.namedChildren.filter((c: any) => c.type === 'case_pattern')) {
        bindPattern(scope, pattern, pattern.endIndex);
      }
    }
  }
  const scopeFor = (node: any): Scope => {
    const at = node.startIndex;
    let lo = 0, hi = scopes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (scopes[mid].start <= at) lo = mid + 1; else hi = mid;
    }
    let scope = scopes[lo - 1] ?? global;
    while (scope.parent && scope.end <= at) scope = scope.parent;
    while (scope.parent && inOuterIterable(scope, node)) scope = scope.parent;
    return scope;
  };
  const lookup = (node: any): ReceiverType => {
    const scope = scopeFor(node);
    if (node.type === 'identifier') return { type: lookupName(scope, node.text, node.startIndex) };
    if (node.type === 'attribute' && node.childForFieldName('object')?.text === 'self' && scope.owner &&
        lookupName(scope, 'self', node.startIndex) === scope.owner.name) {
      return { type: scope.owner.fields.get(node.childForFieldName('attribute').text) };
    }
    return {};
  };
  return {
    factories: [], heritage, typedNames: new Set(), lookup,
    isBound(node: any) {
      const head = node.text.split('.')[0];
      for (let s: Scope | undefined = scopeFor(node); s; s = s.parent) {
        const events = s.bindings.get(head);
        if (events) return events.filter(e => e.at <= node.startIndex).at(-1)?.source !== 'import';
      }
      // An import in a sibling function does not make this name available.
      return true;
    },
    receiverOfCall(nameNode: any, callNode?: any) {
      const member = callNode?.childForFieldName('function') ?? nameNode.parent;
      if (member?.type !== 'attribute') return;
      const object = member.childForFieldName('object');
      const type = lookup(object).type;
      return type ? { type, receiver: object.text } : undefined;
    },
  };
}
