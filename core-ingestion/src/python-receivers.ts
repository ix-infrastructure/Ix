// Copyright 2026 Ix Infrastructure Inc.

import type { ReceiverFacts, ReceiverType } from './receiver-types.js';

/**
 * Python receiver inference. Lexical facts only: a name gets a type from a
 * constructor call, an annotation, `self`/`cls` in a method, or a field that
 * `__init__` (or the class body) types consistently. Anything uncertain (a
 * conditional assignment, a conflicting write, a rebinding the scan cannot
 * type) leaves the receiver untyped, and the call keeps only its usual
 * name-based relationships.
 *
 * Types are written so that resolution needs no import facts of its own (a
 * stored summary carries none for Python):
 *   - a class of this file: its bare name (`Target`);
 *   - an imported class: `<module>.<Name>`, the module as Python would look it
 *     up, relative dots kept (`pkg.model.Target`, `.model.Target`, `..Target`).
 */

/**
 * A type, or how to compute it once the whole file is scanned: a lookup made
 * during the scan cannot see a class defined further down.
 */
type LazyType = string | (() => string | undefined) | undefined;
type Binding = { at: number; type: LazyType; source?: 'import' | 'class'; target?: string };
type Scope = { parent?: Scope; node: any; start: number; end: number; name?: string; bindings: Map<string, Binding[]>; owner?: Scope; fields: Map<string, LazyType[]> };

/** `from <module> import <name>`: the dotted path of `name`. */
function joinModule(module: string, name: string): string {
  return /^\.*$/.test(module) ? `${module}${name}` : `${module}.${name}`;
}

export function collectPythonReceiverFacts(root: any, checkBudget: () => void): ReceiverFacts {
  const scopes: Scope[] = [];
  const heritage: Array<[string, string]> = [];
  /** Each class's bases by its node start, typed once the scan is done. */
  const basesByClass = new Map<number, { name?: string; bases: Array<() => string | undefined> }>();
  /** Local names some import binds anywhere in the file, with what each binds. */
  const importTargets = new Map<string, Set<string>>();
  const concrete = (node: any): string | undefined => {
    if (node?.type === 'type') return concrete(node.firstNamedChild);
    if (node?.type === 'string') return /^["'][\w.]+["']$/.test(node.text) ? node.text.slice(1, -1) : undefined;
    return node && /^(identifier|attribute|dotted_name)$/.test(node.type) && /^\w+(?:\.\w+)*$/.test(node.text) ? node.text : undefined;
  };
  const bind = (scope: Scope, name: string, at: number, type?: LazyType, source?: Binding['source'], target?: string) => {
    const events = scope.bindings.get(name) ?? [];
    events.push({ at, type, source, target });
    scope.bindings.set(name, events);
  };
  const evaluating = new Set<() => string | undefined>();
  const resolved = new Map<() => string | undefined, string | undefined>();
  /** Set once the scan is done: from then on a computed lazy type is final. */
  let scanned = false;
  const resolve = (type: LazyType): string | undefined => {
    if (typeof type !== 'function') return type;
    if (resolved.has(type)) return resolved.get(type);
    // A self-referential chain (`a = b` where `b = a`) types nothing.
    if (evaluating.has(type)) return;
    evaluating.add(type);
    try {
      const value = type();
      if (scanned) resolved.set(type, value);
      return value;
    } finally { evaluating.delete(type); }
  };
  const deferredScope = (s: Scope): boolean => s.node.type === 'function_definition' || s.node.type === 'lambda';
  const sameBinding = (a: Binding, b: Binding): boolean => a === b ||
    (a.source === b.source && a.target === b.target && a.source !== undefined && resolve(a.type) === resolve(b.type));
  /**
   * The binding of `name` at `at`. A function body runs after its enclosing
   * scopes have finished binding, and an annotation names the class it means:
   * from there (`deferred`), a name an enclosing scope binds one way only
   * (`class Later:` below the function) is that binding wherever it is. A
   * name bound several ways stays positional.
   */
  const latest = (scope: Scope | undefined, name: string, at: number, deferred = false): { found: boolean; binding?: Binding } => {
    for (let s = scope; s; s = s.parent) {
      // A method does not see the names its class body binds.
      if (deferred && s.node.type === 'class_definition') continue;
      const events = s.bindings.get(name);
      if (events) {
        if (deferred && events.every(e => sameBinding(e, events[0]))) return { found: true, binding: events[0] };
        return { found: true, binding: events.filter(e => e.at <= at).at(-1) };
      }
      if (deferredScope(s)) deferred = true;
    }
    return { found: false };
  };
  const lookupName = (scope: Scope | undefined, name: string, at: number): string | undefined => resolve(latest(scope, name, at).binding?.type);
  /** The written type of a class name as spelled at `at`, if the name is one. */
  const visibleType = (name: string | undefined, scope: Scope, at: number, annotation = false): string | undefined => {
    if (!name) return;
    const [head, ...rest] = name.split('.');
    // Imported under one name from two places (in different functions, say):
    // which one this is cannot be told from the summary-level import facts.
    if ((importTargets.get(head)?.size ?? 0) > 1) return;
    const { found, binding } = latest(scope, head, at, annotation);
    if (found) {
      if (binding?.source === 'import' && binding.target) return [binding.target, ...rest].join('.');
      if (binding?.source === 'class' && rest.length === 0) return name;
      return;
    }
    // Unbound here (a builtin, a star import, an import in another function):
    // nothing this file can tell.
    return undefined;
  };
  const expressionType = (node: any, scope: Scope): string | undefined => {
    if (node?.type === 'call') {
      const name = concrete(node.childForFieldName('function'));
      // A local parameter/assignment can shadow a constructor or import.
      return name ? visibleType(name, scope, node.startIndex) : undefined;
    }
    if (node?.type === 'identifier') return lookupName(scope, node.text, node.startIndex);
  };
  const setField = (owner: Scope, name: string, type: LazyType) => {
    owner.fields.set(name, [...(owner.fields.get(name) ?? []), type]);
  };
  /** Conflicting writes (including unknown writes) invalidate the field. */
  const fieldType = (owner: Scope, name: string): string | undefined => {
    const types = (owner.fields.get(name) ?? []).map(resolve);
    return types.length && types.every(t => t !== undefined && t === types[0]) ? types[0] : undefined;
  };
  const isOwnSelf = (scope: Scope, object: any, at: number): boolean =>
    object?.type === 'identifier' && object.text === 'self' && !!scope.owner && lookupName(scope, 'self', at) === scope.owner.name;
  const global: Scope = { node: root, start: 0, end: root.endIndex, bindings: new Map(), fields: new Map() };
  const frames = [global];
  const branches: Array<{ end: number; scope: Scope }> = [];
  const comprehensionTypes = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
  /** Each comprehension's first iterable `[start, end]`, by node start. */
  const outerIterables = new Map<number, [number, number] | undefined>();
  const inOuterIterable = (scope: Scope, node: any): boolean => {
    if (!comprehensionTypes.has(scope.node.type)) return false;
    if (!outerIterables.has(scope.start)) {
      const iterable = scope.node.namedChildren.find((c: any) => c.type === 'for_in_clause')?.childForFieldName('right');
      outerIterables.set(scope.start, iterable ? [iterable.startIndex, iterable.endIndex] : undefined);
    }
    const range = outerIterables.get(scope.start);
    return !!range && range[0] <= node.startIndex && node.endIndex <= range[1];
  };
  const branchTypes = new Set(['if_statement', 'for_statement', 'while_statement', 'try_statement', 'match_statement']);
  /**
   * The names an assignment (or `for`/`with`/`except` target) binds: plain
   * identifiers, also inside tuple/list patterns and starred targets. An
   * attribute or subscript target (`self.cache[k] = v`, `x[self] = 1`) binds
   * no name. A `self.attr` inside a tuple target is an untyped field write.
   */
  const bindTarget = (scope: Scope, target: any, at: number) => {
    if (!target) return;
    if (target.type === 'identifier') bind(scope, target.text, at);
    else if (/^(tuple_pattern|list_pattern|pattern_list|tuple|list|as_pattern_target|list_splat_pattern|list_splat|parenthesized_expression|expression_list)$/.test(target.type)) {
      for (const child of target.namedChildren) bindTarget(scope, child, at);
    } else if (target.type === 'attribute' && scope.owner && isOwnSelf(scope, target.childForFieldName('object'), at)) {
      setField(scope.owner, target.childForFieldName('attribute').text, undefined);
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
  /** Each `[local, dotted path]` an import statement binds. */
  const importedBindings = (node: any): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    const module = node.type === 'import_from_statement' ? node.childForFieldName('module_name')?.text : undefined;
    for (const item of node.childrenForFieldName('name')) {
      const aliased = item.type === 'aliased_import';
      const path = (aliased ? item.childForFieldName('name') : item)?.text;
      if (!path) continue;
      if (module !== undefined) {
        out.push([aliased ? item.childForFieldName('alias')?.text : path, joinModule(module, path)]);
      } else if (aliased) {
        out.push([item.childForFieldName('alias')?.text, path]);
      } else {
        // `import a.b` binds `a`, which names the package `a`.
        out.push([path.split('.')[0], path.split('.')[0]]);
      }
    }
    return out.filter(([local]) => !!local);
  };
  /** Starts of `@staticmethod` functions: their first parameter is not `self`. */
  const staticMethods = new Set<number>();
  const nodes = root.descendantsOfType(['decorated_definition', 'class_definition', 'function_definition', 'lambda', 'assignment',
    'augmented_assignment', 'named_expression', ...comprehensionTypes, ...branchTypes, 'with_item', 'except_clause', 'case_clause', 'import_from_statement', 'import_statement', 'delete_statement']);
  for (const node of nodes) {
    if (node.type !== 'import_from_statement' && node.type !== 'import_statement') continue;
    for (const [local, target] of importedBindings(node)) {
      const targets = importTargets.get(local) ?? new Set<string>();
      targets.add(target);
      importTargets.set(local, targets);
    }
  }
  for (const node of nodes) {
    checkBudget();
    if (node.type === 'decorated_definition') {
      // Seen before its definition (pre-order), and without a `.parent` walk.
      if (node.namedChildren.some((c: any) => c.type === 'decorator' && c.text === '@staticmethod')) {
        const definition = node.childForFieldName('definition');
        if (definition) staticMethods.add(definition.startIndex);
      }
      continue;
    }
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
        const bases: Array<() => string | undefined> = [];
        const outer = current;
        for (const base of node.childForFieldName('superclasses')?.namedChildren ?? []) {
          // Match heritage queries: Base[T] inherits the subscripted class.
          // keyword arguments (metaclass=...) and *bases are not bases.
          if (base.type === 'keyword_argument' || base.type === 'list_splat' || base.type === 'dictionary_splat') continue;
          const raw = concrete(base.type === 'subscript' ? base.childForFieldName('value') : base);
          bases.push(() => visibleType(raw, outer, node.startIndex));
        }
        basesByClass.set(node.startIndex, { name, bases });
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
          const annotation = concrete(param.childForFieldName('type'));
          const outer = current;
          if (id) bind(scope, id.text, 0, annotation ? () => visibleType(annotation, outer, node.startIndex, true) : undefined);
        }
        // Only a direct instance/class method owns its first parameter.
        const first = params?.firstNamedChild;
        const firstName = first?.type === 'identifier' ? first.text : first?.childForFieldName('name')?.text;
        if (current.node.type === 'class_definition' && (firstName === 'self' || firstName === 'cls') && !staticMethods.has(node.startIndex)) {
          bind(scope, firstName, 0, current.name);
        }
      }
      scopes.push(scope);
      frames.push(scope);
    }
    if (branchTypes.has(node.type)) branches.push({ end: node.endIndex, scope });
    if (node.type === 'import_from_statement' || node.type === 'import_statement') {
      for (const [local, target] of importedBindings(node)) bind(scope, local, node.endIndex, undefined, 'import', target);
    }
    if (node.type === 'assignment' || node.type === 'augmented_assignment' || node.type === 'named_expression') {
      const conditional = branches.some(branch => branch.scope === scope);
      const walrus = node.type === 'named_expression';
      const left = node.childForFieldName(walrus ? 'name' : 'left');
      const value = node.childForFieldName(walrus ? 'value' : 'right');
      const annotation = node.type === 'assignment' ? concrete(node.childForFieldName('type')) : undefined;
      const at = scope;
      const type: LazyType = conditional || node.type === 'augmented_assignment' ? undefined
        : () => visibleType(annotation, at, node.startIndex, true) ?? expressionType(value, at);
      if (left?.type === 'identifier') {
        if (scope.node.type === 'class_definition') setField(scope, left.text, type);
        else bind(scope, left.text, node.endIndex, type);
      } else if (left?.type === 'attribute') {
        if (scope.owner && isOwnSelf(scope, left.childForFieldName('object'), node.startIndex)) {
          setField(scope.owner, left.childForFieldName('attribute').text, scope.name === '__init__' ? type : undefined);
        }
      } else if (left?.type !== 'subscript') {
        bindTarget(scope, left, node.endIndex);
      }
    }
    if (node.type === 'delete_statement') {
      // `del x` / `del x, y` unbind those names. `del d[k]`, `del self.d[k]`
      // and `del obj.attr` unbind none.
      for (const target of node.namedChildren) {
        if (target.type === 'identifier') bind(scope, target.text, node.endIndex);
        else if (/^(expression_list|tuple|list|parenthesized_expression)$/.test(target.type)) {
          for (const id of target.namedChildren.filter((c: any) => c.type === 'identifier')) bind(scope, id.text, node.endIndex);
        }
      }
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
  /**
   * `super()` / `super(Owner, self)` in a method of a class with one base:
   * that base, whose chain resolution walks for the first definition. With
   * several bases the next class in the MRO depends on the member, so none.
   */
  const superType = (call: any, scope: Scope): string | undefined => {
    if (call.childForFieldName('function')?.text !== 'super' || !scope.owner || scope === scope.owner) return;
    if (latest(scope, 'super', call.startIndex).found) return;
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    if (args.length && (args.length !== 2 || args[0].text !== scope.owner.name)) return;
    const bases = basesByClass.get(scope.owner.start)?.bases ?? [];
    return bases.length === 1 ? bases[0]() : undefined;
  };
  const lookup = (node: any): ReceiverType => {
    const scope = scopeFor(node);
    if (node.type === 'identifier') return { type: lookupName(scope, node.text, node.startIndex) };
    if (node.type === 'attribute' && scope.owner && isOwnSelf(scope, node.childForFieldName('object'), node.startIndex)) {
      return { type: fieldType(scope.owner, node.childForFieldName('attribute').text) };
    }
    if (node.type === 'call') return { type: superType(node, scope) };
    return {};
  };
  scanned = true;
  for (const { name, bases } of basesByClass.values()) {
    for (const base of bases) {
      const type = base();
      if (name && type) heritage.push([name, type]);
    }
  }
  /**
   * Per call node (several query patterns match one call): its member name's
   * start and typed receiver. Keyed by span: `a.b().c()` starts where `a.b()` does.
   */
  const callReceivers = new Map<string, { name: number; receiver?: ReceiverType & { receiver: string } } | undefined>();
  return {
    factories: [], heritage, typedNames: new Set(), lookup,
    receiverOfCall(nameNode: any, callNode?: any) {
      if (!callNode) return;
      const key = `${callNode.startIndex}:${callNode.endIndex}`;
      if (!callReceivers.has(key)) {
        const member = callNode.childForFieldName('function');
        if (member?.type !== 'attribute') {
          callReceivers.set(key, undefined);
        } else {
          const attribute = member.childForFieldName('attribute');
          const object = member.childForFieldName('object');
          const type = object ? lookup(object).type : undefined;
          callReceivers.set(key, { name: attribute?.startIndex ?? -1, ...(type ? { receiver: { type, receiver: object.text } } : {}) });
        }
      }
      const entry = callReceivers.get(key);
      // Only the member's own name: `f(key=obj)` inside `x.f(...)` is not a member call on x.
      return entry && entry.name === nameNode.startIndex ? entry.receiver : undefined;
    },
  };
}
