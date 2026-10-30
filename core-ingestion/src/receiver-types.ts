// Copyright 2026 Ix Infrastructure Inc.

/** Conservative lexical inference. Unknown bindings deliberately stop lookup. */
export interface ReceiverType {
  type?: string;
  factory?: string;
  /**
   * Java: methods called in turn on `type` (`a.getB().m()` is `A` then
   * `getB`). Each step's declared return type is the next receiver.
   */
  chain?: string[];
}

export interface ReceiverFacts {
  factories: Array<[string, string]>;
  heritage: Array<[string, string]>;
  package?: string;
  /** Names some binding in the file gives a type or factory; no other name can resolve to one. */
  typedNames: ReadonlySet<string>;
  lookup(node: any): ReceiverType | undefined;
  /** Java: the receiver of the call whose name node is given, implicit `this` included. */
  receiverOfCall?(nameNode: any, callNode?: any): (ReceiverType & { receiver: string }) | undefined;
}

interface ReceiverBinding extends ReceiverType {
  available?: number;
  factoryNode?: any;
}

const classTypes = new Set(['class_definition', 'trait_definition', 'object_definition', 'class_declaration', 'abstract_class_declaration', 'class']);
const functionTypes = new Set(['function_definition', 'function_declaration', 'method_declaration', 'method_definition', 'arrow_function', 'function_expression', 'func_literal', 'lambda_expression', 'method_signature', 'abstract_method_signature', 'function_signature']);
// Also the statements that own a binding of their own: Go `if x := …;`,
// `switch x := v.(type)`, Scala `case x: T =>` and `for (x <- xs)`.
// TypeScript functions that bind their own `this` (arrow functions do not).
const thisFunctions = new Set(['function_declaration', 'function_expression', 'generator_function', 'generator_function_declaration']);
const blockTypes = new Set(['block', 'statement_block', 'template_body', 'class_body', 'for_statement', 'for_in_statement', 'catch_clause',
  'if_statement', 'expression_switch_statement', 'type_switch_statement', 'case_clause', 'for_expression']);

const bindingTypes = ['variable_declarator', 'public_field_definition', 'var_spec', 'val_definition', 'var_definition', 'val_declaration', 'var_declaration'];
const parameterTypes = ['required_parameter', 'optional_parameter', 'parameter', 'class_parameter', 'parameter_declaration'];
const mutationTypes = ['assignment_expression', 'augmented_assignment_expression', 'assignment_statement', 'assignment', 'update_expression'];
// Node types whose `name` field is read, and every non-scope type visited.
const named = new Set(['type_alias_declaration', ...classTypes, ...functionTypes, ...bindingTypes, ...parameterTypes]);
const visited = new Set([...named, ...mutationTypes, 'short_var_declaration', 'range_clause', 'for_in_statement', 'case_clause', 'enumerator',
  'type_switch_statement', 'catch_clause', 'infix_expression', 'type_definition', 'type_spec', 'type_alias']);
// Every node type the walk stops at: the scopes and the visited types.
const walkedTypes = [...new Set([...classTypes, ...functionTypes, ...blockTypes, 'class_static_block', 'internal_module', ...visited])];

// Java: every type declaration is a class scope, constructors are functions,
// and the statements that declare a variable for their own body are blocks.
const javaClasses = new Set([...classTypes, 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration']);
const javaFunctions = new Set([...functionTypes, 'constructor_declaration', 'compact_constructor_declaration']);
const javaBlocks = new Set([...blockTypes, 'enhanced_for_statement', 'try_with_resources_statement', 'switch_block']);
// A Java variable keeps its declared type when reassigned, so assignments are not walked.
// Java declarations whose `type` field types their variable_declarator children.
const javaDeclarations = ['local_variable_declaration', 'field_declaration', 'constant_declaration'];
const javaWalkedTypes = [...new Set([...walkedTypes.filter(t => !mutationTypes.includes(t)), ...javaClasses, ...javaFunctions, ...javaBlocks,
  ...javaDeclarations, 'formal_parameter', 'catch_formal_parameter', 'resource', 'instanceof_expression', 'type_pattern', 'record_pattern_component'])];
/** Longest Java call chain followed to a receiver (`a.b().c().d()`). */
const JAVA_MAX_CHAIN = 4;

function typeName(node: any): string | undefined {
  if (!node) return;
  if (node.type === 'type_annotation' || node.type === 'pointer_type') return typeName(node.firstNamedChild);
  if (node.type === 'generic_type') return typeName(node.childForFieldName('name') ?? node.firstNamedChild);
  // Unions, tuples, structural types and type parameters are not a concrete receiver.
  if (/^(?:type_identifier|identifier|qualified_type|nested_type_identifier|stable_type_identifier|scoped_type_identifier)$/.test(node.type)) {
    const text = node.text.replace(/\s/g, '');
    if (/^[\w$]+(?:\.[\w$]+)*$/.test(text)) return text;
  }
}

// Java's `<T extends U, @A V>`, read through the field rather than every child.
function javaTypeParameters(node: any): string[] {
  const list = node.childForFieldName('type_parameters');
  return list ? list.namedChildren.map((p: any) => p.namedChildren.find((c: any) => c.type === 'type_identifier')?.text).filter(Boolean) : [];
}

// The type names a class or function declares for its own body. Scala lists
// them as bare identifiers (under `parameters` on a function), a Go entry can
// declare several names, and a Go method receiver `Box[K, T]` redeclares them.
function declaredTypeParameters(node: any): string[] {
  const names: string[] = [];
  for (const list of node.namedChildren) {
    if (list.type !== 'type_parameters' && list.type !== 'type_parameter_list') continue;
    for (const p of list.namedChildren) {
      if (p.type === 'identifier' || p.type === 'type_identifier') names.push(p.text);
      else if (p.type !== 'annotation' && p.type !== 'type_parameters') {
        const declared = p.childrenForFieldName('name');
        if (declared.length) names.push(...declared.map((n: any) => n.text));
        else if (p.firstNamedChild) names.push(p.firstNamedChild.text);
      }
    }
  }
  let receiver = node.type === 'method_declaration' ? node.childForFieldName('receiver')?.firstNamedChild?.childForFieldName('type') : null;
  if (receiver?.type === 'pointer_type') receiver = receiver.firstNamedChild;
  for (const arg of receiver?.type === 'generic_type' ? receiver.childForFieldName('type_arguments')?.namedChildren ?? [] : []) {
    if (/^\w+$/.test(arg.text)) names.push(arg.text);
  }
  return names;
}

export function collectReceiverFacts(root: any, language: string, checkBudget: () => void): ReceiverFacts {
  const java = language === 'java';
  const classes = java ? javaClasses : classTypes;
  const functions = java ? javaFunctions : functionTypes;
  const blocks = java ? javaBlocks : blockTypes;
  const isScope = (type: string): boolean =>
    classes.has(type) || functions.has(type) || blocks.has(type) || type === 'class_static_block' || type === 'internal_module';
  const scopes = new Map<number, Map<string, ReceiverBinding>>();
  const typeParameters = new Map<number, Set<string>>();
  const factories: Array<[string, string]> = [];
  const heritage: Array<[string, string]> = [];
  // Java: each type declaration and anonymous class body in document order
  // (`name` absent for an anonymous one), and the declared return types of
  // each `Class.method` key (overloads share the key).
  const javaTypes: Array<{ start: number; end: number; name?: string; superclass?: string }> = [];
  const namedBodies = new Set<number>();
  const anonymousBodies = new Set<number>();
  const javaReturns = new Map<string, Set<string>>();
  // Java: each variable_declarator's declared type (from its declaration), and
  // every scope in document order with its enclosing scope's index (-1: the
  // file), so a lookup walks scopes by position instead of `.parent`, which
  // these bindings rebuild from the root on every call.
  const declaratorTypes = new Map<number, any>();
  const javaScopes: Array<{ start: number; end: number; id: number; type: string; parent: number }> = [];
  // Scope ancestors of the node being visited, innermost last. Tracking them
  // during the walk avoids a parent-chain walk per node.
  const frames: Array<{ node: any; type: string; end: number; scope?: number }> = [];
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
  // Java: the named type a member being visited belongs to; none inside an
  // anonymous class body.
  const javaOwner = (): any => {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (anonymousBodies.has(frames[i].node.id)) return;
      if (classes.has(frames[i].type)) return frames[i].node;
    }
  };
  const javaTypeParameter = (name: string): boolean => frames.some(f => typeParameters.get(f.node.id)?.has(name));
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
    if (java && (value.type === 'object_creation_expression' || value.type === 'cast_expression')) return { type: typeName(value.childForFieldName('type')) };
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
  // `var` (a local, a lambda or resource parameter) declares no type of its own.
  const javaDeclaredType = (declaration: any): any => {
    const type = declaration?.childForFieldName('type');
    return type && type.text !== 'var' ? type : null;
  };
  const javaTypeList = (node: any): Array<string | undefined> =>
    node?.namedChildren.find((c: any) => c.type === 'type_list')?.namedChildren.map(typeName) ?? [];
  const visitJava = (node: any, type: string): void => {
    if (javaDeclarations.includes(type)) {
      const declared = javaDeclaredType(node);
      for (const declarator of node.childrenForFieldName('declarator')) declaratorTypes.set(declarator.id, declared);
      return;
    }
    const name = ['class_body', 'type_pattern', 'record_pattern_component'].includes(type) ? null : node.childForFieldName('name');
    if (classes.has(type)) {
      const body = node.childForFieldName('body');
      if (body) namedBodies.add(body.id);
      if (!name) return;
      // Superclass first: a member it declares is the one a subclass inherits.
      const superclass = typeName(node.childForFieldName('superclass')?.firstNamedChild);
      const parents = [superclass, ...javaTypeList(node.childForFieldName('interfaces')),
        ...javaTypeList(node.namedChildren.find((c: any) => c.type === 'extends_interfaces'))];
      for (const parent of parents) if (parent) heritage.push([name.text, parent]);
      javaTypes.push({ start: node.startIndex, end: node.endIndex, name: name.text, superclass });
      return;
    }
    if (type === 'class_body' && !namedBodies.has(node.id)) {
      // `new T() { … }` or an enum constant's body: `this` is not the enclosing class.
      anonymousBodies.add(node.id);
      javaTypes.push({ start: node.startIndex, end: node.endIndex });
      return;
    }
    if (type === 'method_declaration' && name) {
      const owner = javaOwner()?.childForFieldName('name')?.text;
      const result = node.childForFieldName('type');
      if (!owner || !result || result.type === 'void_type') return;
      const own = typeParameters.get(node.id);
      const returned = typeName(result);
      const key = `${owner}.${name.text}`;
      const returns = javaReturns.get(key) ?? new Set<string>();
      // A primitive, array or type-parameter result is not a receiver (''), but
      // still blocks an overload's class type.
      returns.add(returned && !own?.has(returned) && !javaTypeParameter(returned) ? returned : '');
      javaReturns.set(key, returns);
      return;
    }
    if (type === 'formal_parameter' && name) {
      // Method, constructor, record-component and typed lambda parameters.
      bind(scopeOf(), name.text, { type: typeName(javaDeclaredType(node)) });
      return;
    }
    if (type === 'catch_formal_parameter' && name) {
      // `catch (A | B e)` has no single type.
      const caught = node.namedChildren.find((c: any) => c.type === 'catch_type')?.namedChildren ?? [];
      bind(scopeOf(), name.text, { type: caught.length === 1 ? typeName(caught[0]) : undefined });
      return;
    }
    if (type === 'enhanced_for_statement' && name) {
      bind(node, name.text, { type: typeName(javaDeclaredType(node)) });
      return;
    }
    if (type === 'resource' && name) {
      const declared = typeName(javaDeclaredType(node));
      bind(scopeOf(), name.text, declared ? { type: declared } : valueType(node.childForFieldName('value')));
      return;
    }
    // Pattern variables (`x instanceof T t`, `case T t ->`, record patterns)
    // only shadow: their scope follows control flow.
    if (type === 'instanceof_expression' && name) bind(scopeOf(), name.text, {});
    if (type === 'type_pattern' || type === 'record_pattern_component') {
      for (const child of node.namedChildren) if (child.type === 'identifier') bind(scopeOf(), child.text, {});
    }
  };
  const visit = (node: any, type: string): void => {
    const name = named.has(type) ? node.childForFieldName('name') : null;
    // A local type declaration shadows a same-named class (a package-level Go
    // `type_spec` is the class itself).
    const localType = ['type_definition', 'type_spec', 'type_alias'].includes(type) && scopeOf() !== root ? node.childForFieldName('name') : null;
    if ((type === 'type_alias_declaration' && name) || localType) {
      const scope = scopeOf();
      const names = typeParameters.get(scope.id) ?? new Set<string>();
      names.add((name ?? localType).text);
      typeParameters.set(scope.id, names);
    }
    if (classes.has(type) || functions.has(type)) {
      const generics = java ? javaTypeParameters(node) : declaredTypeParameters(node);
      if (generics.length) typeParameters.set(node.id, new Set(generics));
      const singleParameter = java ? null : node.childForFieldName('parameter');
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
    if (java) visitJava(node, type);
    let binding: any;
    let owner = scopeOf();
    if (language === 'typescript' && type === 'variable_declarator' && node.parent?.type === 'variable_declaration') {
      owner = functionScope();
    }
    if (['function_definition', 'function_declaration'].includes(type) && name && owner !== root && !classes.has(owner.type) && !['template_body', 'class_body'].includes(owner.type)) {
      bind(owner, name.text, {});
    }
    const declares = bindingTypes.includes(type) || parameterTypes.includes(type);
    const annotation = !declares ? null
      : java && type === 'variable_declarator' ? declaratorTypes.get(node.id) ?? null
        : node.childForFieldName('type');
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
      // A Java field can also belong to an interface, enum or record.
      const local = ['variable_declarator', 'val_definition', 'var_definition', 'var_spec'].includes(type) &&
        !['template_body', 'class_body'].includes(owner.type) && !(java && classes.has(owner.type));
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
  for (const node of root.descendantsOfType(java ? javaWalkedTypes : walkedTypes)) {
    // Types are matched by name, and `class` is also a keyword.
    if (!node.isNamed) continue;
    checkBudget();
    while (frames.length && !within(frames[frames.length - 1], node)) frames.pop();
    const type: string = node.type;
    visit(node, type);
    if (isScope(type)) {
      const frame: (typeof frames)[number] = { node, type, end: node.endIndex };
      if (java) {
        const parent = frames.length ? frames[frames.length - 1].scope! : -1;
        frame.scope = javaScopes.push({ start: node.startIndex, end: node.endIndex, id: node.id, type, parent }) - 1;
      }
      frames.push(frame);
    }
  }
  // `lookupName` for Java, by position: the scopes around `pos`, innermost first.
  const javaLookupName = (pos: number, name: string, field = false): ReceiverType | undefined => {
    let lo = 0;
    let hi = javaScopes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (javaScopes[mid].start <= pos) lo = mid + 1; else hi = mid;
    }
    // Scopes nest, so the innermost one around `pos` is the last to start
    // before it or one of that scope's ancestors.
    let at = lo - 1;
    while (at >= 0 && javaScopes[at].end <= pos) at = javaScopes[at].parent;
    for (let i = at; ; i = javaScopes[i].parent) {
      const scope = i >= 0 ? javaScopes[i] : { id: root.id, type: root.type };
      const skip = field && !classes.has(scope.type) && scope.type !== 'class_body';
      const info = skip ? undefined : scopes.get(scope.id)?.get(name);
      if (info) {
        if (info.available !== undefined && info.available > pos) return {};
        if (info.type) for (let j = at; j >= 0; j = javaScopes[j].parent) {
          if (typeParameters.get(javaScopes[j].id)?.has(info.type)) return {};
        }
        return info;
      }
      // `this` stops at the innermost class, named or anonymous.
      if (field && !skip && (classes.has(scope.type) || anonymousBodies.has(scope.id))) return;
      if (i < 0) return;
    }
  };
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
      // A Scala or Java anonymous class (`new T { … }`) is its own `this`.
      if (field && (classes.has(p.type) || (p.type === 'template_body' && !classes.has(p.parent?.type)) || anonymousBodies.has(p.id))) return;
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
  // Java method results, only for methods that can return a class: a getter
  // returning `int` is never a chained receiver, so it costs no summary space.
  for (const [method, returns] of javaReturns) if ([...returns].some(Boolean)) for (const type of returns) factories.push([method, type]);
  if (java) return javaFacts(root, { factories, heritage, typedNames, scopes, javaTypes, lookupName: javaLookupName });
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

/** The innermost Java type declaration or anonymous class body around `pos`. */
function javaTypeAt(types: Array<{ start: number; end: number; name?: string; superclass?: string }>, pos: number) {
  // Document order: the last range starting at or before `pos` that still
  // contains it is the innermost one.
  let lo = 0;
  let hi = types.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (types[mid].start <= pos) lo = mid + 1; else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) if (types[i].end > pos) return types[i];
  return undefined;
}

function javaFacts(root: any, facts: {
  factories: Array<[string, string]>;
  heritage: Array<[string, string]>;
  typedNames: Set<string>;
  scopes: Map<number, Map<string, ReceiverBinding>>;
  javaTypes: Array<{ start: number; end: number; name?: string; superclass?: string }>;
  lookupName(pos: number, name: string, field?: boolean): ReceiverType | undefined;
}): ReceiverFacts {
  const { scopes, javaTypes, lookupName } = facts;
  // Every name a declaration binds, typed or not: any of them can shadow a type name.
  const boundNames = new Set<string>();
  for (const bindings of scopes.values()) for (const name of bindings.keys()) boundNames.add(name);
  const pkg = root.namedChildren.find((node: any) => node.type === 'package_declaration')?.firstNamedChild;
  const calls = new Map<number, (ReceiverType & { receiver: string }) | undefined>();
  // `this` (implicit for a bare `m()`) is the innermost named class; inside an
  // anonymous class body it is that unnamed class, so unknown.
  const enclosing = (node: any) => {
    const at = javaTypeAt(javaTypes, node.startIndex);
    return at?.name ? at : undefined;
  };
  const lookup = (node: any, depth = 0): ReceiverType => {
    switch (node?.type) {
      case 'identifier': {
        const name = node.text;
        const bound = boundNames.has(name) ? lookupName(node.startIndex, name) : undefined;
        if (bound) return bound;
        // Not a variable in scope: an uppercase name is a type (`URL.valueOf()`),
        // which resolution only accepts when exactly one class in scope has it.
        return /^[A-Z]/.test(name) ? { type: name } : {};
      }
      case 'field_access': {
        const object = node.childForFieldName('object');
        const field = node.childForFieldName('field');
        if (object?.type === 'this' && field?.type === 'identifier') {
          return (boundNames.has(field.text) ? lookupName(node.startIndex, field.text, true) : undefined) ?? {};
        }
        // `Outer.this`
        if (field?.type === 'this' && object?.type === 'identifier') return { type: object.text };
        return {};
      }
      case 'this': return { type: enclosing(node)?.name };
      case 'super': return { type: enclosing(node)?.superclass };
      case 'object_creation_expression':
      case 'cast_expression':
        return { type: typeName(node.childForFieldName('type')) };
      case 'parenthesized_expression': return lookup(node.firstNamedChild, depth);
      case 'method_invocation': {
        // `a.getB().m()`: the receiver is what `getB` returns, known only once resolved.
        const name = node.childForFieldName('name')?.text;
        const object = node.childForFieldName('object');
        if (!name || depth >= JAVA_MAX_CHAIN - 1 || qualifiedSuper(node, object)) return {};
        const base = object ? lookup(object, depth + 1) : { type: enclosing(node)?.name };
        return base.type ? { type: base.type, chain: [...(base.chain ?? []), name] } : {};
      }
      default: return {};
    }
  };
  return {
    factories: facts.factories, heritage: facts.heritage, typedNames: facts.typedNames,
    package: pkg?.text.replace(/\s/g, '') || undefined,
    lookup: (node: any) => lookup(node),
    // Each call matches both Java call patterns, so its receiver is kept by call.
    receiverOfCall(nameNode: any, callNode?: any) {
      const call = callNode ?? nameNode.parent;
      if (call?.type !== 'method_invocation') return;
      if (calls.has(call.id)) return calls.get(call.id);
      const object = call.childForFieldName('object');
      const info = qualifiedSuper(call, object) ? {} : object ? lookup(object) : { type: enclosing(call)?.name };
      const receiver = info.type ? { type: info.type, ...(info.chain ? { chain: info.chain } : {}), receiver: object?.text ?? 'this' } : undefined;
      calls.set(call.id, receiver);
      return receiver;
    },
  };
}

/**
 * `X.super.m()`: an interface's default method or an outer class's
 * superclass, not `X`. Its `super` is an extra named child; counting children
 * avoids materializing them (a comment there also counts, which only costs
 * the typed edge).
 */
function qualifiedSuper(call: any, object = call.childForFieldName('object')): boolean {
  if (!object || object.type === 'super') return false;
  const plain = call.childForFieldName('type_arguments') ? 4 : 3;
  return call.namedChildCount > plain;
}

/**
 * The inferred receiver of a member call, given the call's member-name node:
 * `dep.run()` (TS), `dep.run()` (Scala), `dep.Run()` (Go). Only a receiver with
 * an inferred type or factory counts; `receiver` is its source text.
 */
export function callReceiver(nameNode: any, facts: ReceiverFacts, callNode?: any): (ReceiverType & { receiver: string }) | undefined {
  if (facts.receiverOfCall) return facts.receiverOfCall(nameNode, callNode);
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
