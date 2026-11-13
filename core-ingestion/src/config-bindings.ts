// Copyright 2026 Ix Infrastructure Inc.

import type { SyntaxNode } from 'tree-sitter';
import type { FileParseResult, ParsedEntity } from './index.js';

export type ConfigKind = 'ConfigKey' | 'EnvVar' | 'CliFlag' | 'Route';
export interface ConfigBinding {
  kind: ConfigKind;
  /** Routes use METHOD /pattern; flags use their spelling including dashes. */
  key: string;
  role: 'declaration' | 'read' | 'handler';
  /** Qualified entity key in this file, never an invented symbol. */
  symbol: string;
  line: number;
  defaultValue?: string | number | boolean | null;
}

const qkey = (e: ParsedEntity) => e.container ? `${e.container}.${e.name}` : e.name;
const field = (n: SyntaxNode, name: string) => n.childForFieldName(name);
const calls = new Set(['call_expression', 'call', 'method_invocation', 'object_creation_expression']);
const members = new Set(['member_expression', 'attribute', 'selector_expression', 'field_access', 'subscript', 'subscript_expression']);
const httpMethods = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)$/;

/** Only scalar literals; interpolation, expressions, comments and identifiers do not qualify. */
function scalar(text: string | undefined): ConfigBinding['defaultValue'] | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (/^(true|True|false|False)$/.test(t)) return /^(true|True)$/.test(t);
  if (/^(null|None|nil)$/.test(t)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (/^r?["'`]/.test(t) && /^r?(["'`])[^\r\n]*\1$/.test(t) && !/\$\{|["'`]\s*\+/.test(t)) {
    const unwrapped = t.replace(/^r/, '');
    if (unwrapped.startsWith('"')) {
      try { return JSON.parse(unwrapped); } catch { return undefined; }
    }
    return unwrapped.slice(1, -1).replace(/\\([\\'"`])/g, '$1');
  }
  return undefined;
}

function string(n: SyntaxNode | null | undefined): string | undefined {
  const value = scalar(n?.text);
  return typeof value === 'string' ? value : undefined;
}

/** Extract from AST operations, never from a file-wide string-literal scan. */
export function extractConfigBindings(root: SyntaxNode, language: string, entities: ParsedEntity[], filePath: string, checkBudget: () => void): ConfigBinding[] {
  if (!['typescript', 'javascript', 'python', 'go', 'java'].includes(language)) return [];
  const javascript = language === 'typescript' || language === 'javascript';
  const nodes: SyntaxNode[] = [];
  const pending = [root];
  while (pending.length) {
    checkBudget();
    const node = pending.pop()!;
    nodes.push(node);
    // Actual reads inside template interpolations still count; string fragments cannot match operations.
    if (!/comment/.test(node.type)) pending.push(...node.namedChildren.slice().reverse());
  }
  const imports = nodes.filter(n => /^(import_statement|import_from_statement|import_declaration|import_spec)$/.test(n.type)
    || (n.type === 'call_expression' && field(n, 'function')?.text === 'require' && string(field(n, 'arguments')?.namedChildren[0]) !== undefined)).map(n => n.text).join('\n');
  const has = (pattern: RegExp) => pattern.test(imports);
  const receivers = new Map<string, string>();
  // Follow simple constructor assignments (app = Flask(), r := chi.NewRouter()).
  for (const node of nodes) {
    if (!/^(variable_declarator|assignment|short_var_declaration|assignment_statement)$/.test(node.type)) continue;
    const left = field(node, 'name') ?? field(node, 'left');
    const right = field(node, 'value') ?? field(node, 'right');
    if (!left || !right || !/^[A-Za-z_$]\w*$/.test(left.text)) continue;
    if (/(?:express|fastify|Flask|FastAPI|APIRouter|gin|echo|chi|Router|NewServeMux|ArgumentParser|ConfigParser|Command)\b/.test(right.text)) receivers.set(left.text, right.text);
  }
  const file = entities.find(e => e.kind === 'file')!;
  const definitions = entities.filter(e => !['file', 'module'].includes(e.kind));
  const at = (node: SyntaxNode): string => {
    const line = node.startPosition.row + 1;
    const owners = definitions.filter(e => e.lineStart <= line && e.lineEnd >= line && ['function', 'method', 'class'].includes(e.kind));
    owners.sort((a, b) => (a.lineEnd - a.lineStart) - (b.lineEnd - b.lineStart));
    return owners[0] ? qkey(owners[0]) : file.name;
  };
  const target = (node: SyntaxNode | null | undefined, fallback: SyntaxNode): string => {
    if (node && /^[\w.]+$/.test(node.text)) {
      const found = definitions.filter(e => qkey(e) === node.text || e.name === node.text);
      if (found.length === 1) return qkey(found[0]);
    }
    if (node) {
      const found = definitions.filter(e => e.lineStart >= node.startPosition.row + 1 && e.lineEnd <= node.endPosition.row + 1 && ['function', 'method'].includes(e.kind));
      if (found.length === 1) return qkey(found[0]);
    }
    return at(fallback);
  };
  const facts: ConfigBinding[] = [];
  const add = (kind: ConfigKind, key: string | undefined, node: SyntaxNode, role: ConfigBinding['role'] = 'read', symbol = at(node), defaultValue?: ConfigBinding['defaultValue']) => {
    if (!key || key.length > 500) return;
    facts.push({ kind, key, role, symbol, line: node.startPosition.row + 1, ...(defaultValue !== undefined ? { defaultValue } : {}) });
  };
  const route = (method: string, path: string | undefined, n: SyntaxNode, handler?: SyntaxNode | null) => {
    if (path !== undefined && (path.startsWith('/') || language === 'python')) add('Route', `${method} ${path}`, n, 'handler', target(handler, n));
  };
  const flag = (name: string, node: SyntaxNode, def?: ConfigBinding['defaultValue'], symbol?: string) => {
    const names = name.startsWith('-') ? name.match(/--?[\w][\w-]*/g) ?? [] : [`--${name}`];
    for (const key of names) add('CliFlag', key, node, 'declaration', symbol ?? at(node), def);
    return names;
  };
  const argsOf = (node: SyntaxNode) => (field(node, 'arguments')?.namedChildren ?? []).filter(n => n.type !== 'comment');
  const calleeOf = (node: SyntaxNode) => {
    if (node.type === 'method_invocation') return [field(node, 'object')?.text, field(node, 'name')?.text].filter(Boolean).join('.');
    return (field(node, 'function') ?? field(node, 'constructor'))?.text ?? '';
  };
  const isCallTarget = (node: SyntaxNode) => node.parent && calls.has(node.parent.type)
    && (field(node.parent, 'function') ?? field(node.parent, 'constructor'))?.id === node.id;
  // Bind destinations to lexical declarations. A matching spelling elsewhere
  // in the file is not evidence that it came from a parser.
  const scopeTypes = /^(program|module|function_declaration|function_definition|method_declaration|arrow_function|function_expression|lambda|class_declaration|class_definition|statement_block|block)$/;
  const scopeOf = (node: SyntaxNode): SyntaxNode => {
    let parent = node.parent;
    while (parent && (!scopeTypes.test(parent.type) || (language === 'python' && parent.type === 'block'))) parent = parent.parent;
    return parent ?? root;
  };
  const declarations = new Map<number, Map<string, SyntaxNode[]>>();
  const declarationIds = new Set<number>();
  const declare = (node: SyntaxNode | null, scope = node ? scopeOf(node) : root) => {
    if (!node || node.type !== 'identifier') return;
    const names = declarations.get(scope.id) ?? new Map<string, SyntaxNode[]>();
    const found = names.get(node.text) ?? [];
    if (!found.some(n => n.id === node.id)) found.push(node);
    names.set(node.text, found);
    declarations.set(scope.id, names);
    declarationIds.add(node.id);
  };
  for (const node of nodes) {
    checkBudget();
    if (/^(function_declaration|function_definition)$/.test(node.type)) declare(field(node, 'name'), scopeOf(node));
    if (node.type === 'variable_declarator') declare(field(node, 'name'));
    if (node.type === 'assignment') declare(field(node, 'left'));
    if (/^(short_var_declaration|var_spec|parameter_declaration)$/.test(node.type)) {
      const left = field(node, 'left') ?? field(node, 'name');
      if (left && /^(identifier_list|expression_list)$/.test(left.type)) left.namedChildren.forEach(n => declare(n));
      else declare(left);
    }
    if (/^(formal_parameter|required_parameter|optional_parameter|typed_parameter|default_parameter|typed_default_parameter)$/.test(node.type)) {
      declare(field(node, 'name') ?? field(node, 'pattern') ?? node.namedChildren.find(n => n.type === 'identifier') ?? null);
    }
    if (node.type === 'identifier' && /^(parameters|formal_parameters)$/.test(node.parent?.type ?? '')) declare(node);
  }
  const resolve = (name: string, use: SyntaxNode): SyntaxNode | undefined => {
    let scope = scopeOf(use);
    while (true) {
      const found = declarations.get(scope.id)?.get(name);
      // Reassignments are ambiguous: do not guess which value reaches a read.
      if (found) return found.length === 1 ? found[0] : undefined;
      if (scope.id === root.id) return undefined;
      scope = scopeOf(scope);
    }
  };
  const destinations = new Map<number, Map<string, string[]>>();
  const bind = (declaration: SyntaxNode | undefined, property: string, names: string[]) => {
    if (!declaration) return;
    const properties = destinations.get(declaration.id) ?? new Map<string, string[]>();
    properties.set(property, [...new Set([...(properties.get(property) ?? []), ...names])]);
    destinations.set(declaration.id, properties);
  };
  const parameters = (fn: SyntaxNode | undefined) => field(fn ?? root, 'parameters')?.namedChildren.map(n =>
    n.type === 'identifier' ? n : field(n, 'name') ?? field(n, 'pattern') ?? n.namedChildren.find(c => c.type === 'identifier')).filter((n): n is SyntaxNode => !!n) ?? [];
  const handlerNode = (argument: SyntaxNode | undefined): SyntaxNode | undefined => {
    if (!argument) return undefined;
    if (field(argument, 'parameters')) return argument;
    const declaration = resolve(argument.text, argument);
    const parent = declaration?.parent;
    if (parent && /^(function_declaration|function_definition)$/.test(parent.type)) return parent;
    const value = parent?.type === 'variable_declarator' ? field(parent, 'value') : undefined;
    return value && field(value, 'parameters') ? value : undefined;
  };
  const optionRegistrations: Array<{ receiver: number; property: string; names: string[] }> = [];
  const flagDestinationSites: SyntaxNode[] = [];
  const receiverDeclaration = (callee: string, node: SyntaxNode) => resolve(/^[A-Za-z_$]\w*/.exec(callee)?.[0] ?? '', node);
  const isWebReceiver = (receiver: string) => {
    const factory = receivers.get(receiver.split('.')[0]) ?? '';
    return has(/express|fastify|flask|fastapi|gin-gonic|labstack\/echo|go-chi/) && /express|fastify|Flask|FastAPI|APIRouter|gin|echo|chi|Router/.test(factory);
  };
  const enclosingDecoratorTarget = (node: SyntaxNode): SyntaxNode | undefined => {
    let parent = node.parent;
    while (parent && parent.type !== 'decorated_definition' && parent.type !== 'method_declaration' && parent.type !== 'field_declaration') parent = parent.parent;
    return parent?.namedChildren.find(n => /^(function_definition|method_declaration)$/.test(n.type)) ?? parent ?? undefined;
  };

  for (const node of nodes) {
    checkBudget();
    if (members.has(node.type)) {
      // Assignment targets are writes. Exact environment accesses remain reads
      // when used as the receiver of another property access or method call.
      if (node.parent && /assignment|variable_declarator/.test(node.parent.type) && (field(node.parent, 'left')?.id === node.id || field(node.parent, 'name')?.id === node.id)) continue;
      const text = node.text.replace(/\s+/g, '');
      const env = (javascript ? /^process\.env(?:\.([\w]+)|\[(["'])([^"']+)\2\])$/.exec(text) : null)
        ?? (language === 'python' && has(/\bos\b/) ? /^os\.environ\[(["'])([^"']+)\1\]$/.exec(text) : null);
      if (env) {
        const key = text.startsWith('process.') ? env[1] ?? env[3] : env[2];
        const fallback = node.parent && /binary|boolean/.test(node.parent.type) && /\?\?|\|\||\bor\b/.test(node.parent.text) ? scalar(field(node.parent, 'right')?.text) : undefined;
        add('EnvVar', key, node, 'read', at(node), fallback);
      }
      // Keep the full settings path, stopping before a called method name.
      if (node.parent && members.has(node.parent.type) && !isCallTarget(node.parent)) continue;
      const config = /^(?:settings|config|cfg|configuration)\.([\w.]+)$/.exec(text);
      if (config && !isCallTarget(node)) add('ConfigKey', config[1], node);
    }
    if (!calls.has(node.type)) continue;
    const callee = calleeOf(node);
    const args = argsOf(node);
    const key = string(args[0]);
    const method = callee.split('.').pop() ?? '';
    const receiver = callee.slice(0, -(method.length + 1));
    if ((language === 'java' && callee === 'System.getenv')
      || (language === 'python' && has(/\bos\b/) && /^(os\.getenv|os\.environ\.get)$/.test(callee))
      || (language === 'go' && has(/\bos\b/) && /^(os\.Getenv|os\.LookupEnv)$/.test(callee))) add('EnvVar', key, node, 'read', at(node), scalar(args[1]?.text));
    if ((/^(config|cfg|configuration|nconf)\.(get|require|Get|getString|getInt|getBoolean|getLong|getDouble|GetString|GetInt|GetBool)$/.test(callee) && has(/config|viper|Config|nconf/))
      || (/^viper\.Get\w*$/.test(callee) && has(/spf13\/viper/))
      || (/\.(getProperty|getRequiredProperty)$/.test(callee) && has(/springframework.*env|java\.util\.Properties/))) {
      const section = has(/configparser/) && /ConfigParser/.test(receivers.get(receiver) ?? '') && method === 'get' && key && string(args[1]);
      add('ConfigKey', section ? `${key}.${string(args[1])}` : key, node, 'read', at(node), section ? undefined : scalar(args[1]?.text));
    }

    const argparse = method === 'add_argument' && has(/argparse/);
    const jsflag = /^(option|requiredOption)$/.test(method) && has(/commander|yargs/);
    const goflag = /^(String|Bool|Int|Int64|Float64|Duration)(Var)?P?$/.test(method) && has(/"flag"|spf13\/(?:pflag|cobra)/);
    const pyflag = /^(click\.option|typer\.Option)$/.test(callee) && has(/click|typer/);
    if (argparse || jsflag || goflag || pyflag) {
      let name = key;
      let def = scalar(args[1]?.text);
      let handler: string | undefined;
      if (jsflag) {
        def = scalar(args[2]?.text);
        if (args[1]?.type === 'object') {
          const pair = args[1]?.namedChildren.find(n => field(n, 'key')?.text === 'default');
          def = scalar(pair && field(pair, 'value')?.text);
        }
        // Commander/yargs chains identify an actual handler parameter.
        // Do not infer consumers from arbitrary opts/argv variables.
        let parent: SyntaxNode | null = node.parent;
        for (let i = 0; parent && i < 8; i++, parent = parent.parent) {
          if (calls.has(parent.type) && /\.(action|command)$/.test(calleeOf(parent))) { handler = target(argsOf(parent).at(-1), parent); break; }
        }
      }
      if (argparse || pyflag) {
        const kw = args.find(a => field(a, 'name')?.text === 'default');
        def = scalar(kw && field(kw, 'value')?.text);
        if (callee === 'typer.Option') { name = string(args[1]); def = scalar(args[0]?.text); }
        if (callee === 'click.option') handler = target(enclosingDecoratorTarget(node), node);
      }
      if (goflag) {
        const index = /VarP?$/.test(method) ? 1 : 0;
        name = string(args[index]);
        def = scalar(args[index + (method.endsWith('P') ? 2 : 1)]?.text);
      }
      if (name) {
        const names = flag(name, node, def, handler);
        if (!names.length) continue;
        const dest = args.find(a => field(a, 'name')?.text === 'dest');
        const destName = dest && string(field(dest, 'value'));
        const bare = (names.find(n => n.startsWith('--')) ?? names[0]).replace(/^-+/, '');
        const property = destName || (argparse ? bare.replace(/-/g, '_') : bare.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
        if (argparse || jsflag) {
          const receiver = receiverDeclaration(callee, node);
          if (receiver) optionRegistrations.push({ receiver: receiver.id, property, names });
        }
        if (jsflag && handler) {
          // Find the action call, then resolve its actual function declaration.
          let parent = node.parent;
          while (parent) {
            if (calls.has(parent.type) && /\.(action|command)$/.test(calleeOf(parent))) {
              bind(parameters(handlerNode(argsOf(parent).at(-1)))[0], property, names);
              break;
            }
            parent = parent.parent;
          }
        }
        if (callee === 'click.option') {
          const fn = enclosingDecoratorTarget(node);
          const explicit = args.slice(1).map(string).find(s => s && !s.startsWith('-'));
          const destination = explicit ?? bare.replace(/-/g, '_');
          bind(parameters(fn).find(p => p.text === destination), '', names);
        }
        if (callee === 'typer.Option') {
          let parameter = node.parent;
          while (parameter && !/^(typed_default_parameter|default_parameter)$/.test(parameter.type)) parameter = parameter.parent;
          bind(parameter ? field(parameter, 'name') ?? undefined : undefined, '', names);
        }
        if (goflag) {
          if (/VarP?$/.test(method) && args[0]) flagDestinationSites.push(args[0]);
          let variable = /VarP?$/.test(method) ? args[0]?.text.replace(/^&/, '') : undefined;
          if (!variable) {
            let parent = node.parent;
            while (parent && !['short_var_declaration', 'var_spec', 'assignment_statement', 'block'].includes(parent.type)) parent = parent.parent;
            variable = parent ? (field(parent, 'left') ?? field(parent, 'name'))?.text : undefined;
          }
          if (variable && /^[A-Za-z_]\w*$/.test(variable)) bind(resolve(variable, node), '', names);
        }
      }
    }
    if (/^Get(String|Bool|Int|Int64|Duration)$/.test(method) && /\.Flags\(\)|\.PersistentFlags\(\)/.test(receiver) && has(/spf13\/cobra/) && key) add('CliFlag', `--${key}`, node);

    if (isWebReceiver(receiver) && httpMethods.test(method.toUpperCase()) && key) route(method.toUpperCase(), key, node, args[args.length - 1]);
    const functionNode = field(node, 'function');
    const routeBuilder = functionNode && field(functionNode, 'object');
    if (javascript && routeBuilder && calls.has(routeBuilder.type) && /\.route$/.test(calleeOf(routeBuilder))
      && isWebReceiver(receiver) && httpMethods.test(method.toUpperCase())) route(method.toUpperCase(), string(argsOf(routeBuilder)[0]), node, args[args.length - 1]);
    if (has(/net\/http/) && /^(HandleFunc|Handle)$/.test(method) && (receiver === 'http' || /NewServeMux/.test(receivers.get(receiver) ?? ''))) {
      const pattern = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/.*)$/.exec(key ?? '');
      route(pattern?.[1] ?? '*', pattern?.[2] ?? key, node, args[1]);
    }
    if (/^(path|re_path)$/.test(callee) && has(/django\.urls/)) route('*', key, node, args[1]);
    if (method === 'route' && isWebReceiver(receiver)) {
      if (key && language === 'python') {
        const methods = args.find(a => field(a, 'name')?.text === 'methods');
        const values = methods ? (field(methods, 'value')?.namedChildren ?? []).map(string).filter((s): s is string => !!s) : ['GET'];
        for (const verb of values) route(verb, key, node, enclosingDecoratorTarget(node));
      } else if (!key) {
        const pairs = args[0]?.namedChildren ?? [];
        const value = (name: string) => field(pairs.find(p => field(p, 'key')?.text === name) ?? node, 'value');
        const verbs = value('method');
        const values = verbs?.type === 'array' ? verbs.namedChildren.map(string) : [string(verbs)];
        for (const verb of values) if (verb) route(verb, string(value('url')), node, value('handler'));
      }
    }
    // FastAPI/Flask method decorators: the decorated function is the handler.
    if (language === 'python' && httpMethods.test(method.toUpperCase()) && isWebReceiver(receiver)) {
      const fn = enclosingDecoratorTarget(node);
      if (fn) {
        // Replace the generic call-handler fallback with the actual decorated definition.
        const last = facts[facts.length - 1];
        if (last?.kind === 'Route' && last.line === node.startPosition.row + 1) last.symbol = target(fn, node);
      }
    }
  }

  // Java annotations carry syntax, rather than calls. Bind annotations to the method/field.
  if (language === 'java') for (const node of nodes.filter(n => /^(annotation|marker_annotation)$/.test(n.type))) {
    const name = field(node, 'name')?.text.split('.').pop() ?? '';
    const owner = enclosingDecoratorTarget(node);
    if (!owner) continue;
    const text = node.text;
    if (name === 'Option' && has(/picocli/)) {
      const names = /names\s*=\s*(\{[^}]+\}|"[^"]+")/.exec(text)?.[1];
      const def = /defaultValue\s*=\s*("[^"]*")/.exec(text)?.[1];
      if (names) {
        const flags = flag([...names.matchAll(/"([^"]+)"/g)].map(m => m[1]).join(', '), node, scalar(def), target(owner, node));
        const variable = owner.namedChildren.find(n => n.type === 'variable_declarator');
        bind(variable ? field(variable, 'name') ?? undefined : undefined, '', flags);
      }
    }
    if (/^(Get|Post|Put|Patch|Delete|Request)Mapping$/.test(name) && has(/springframework/)) {
      // Only method mappings are endpoints. A controller's static mapping
      // supplies prefixes (including path arrays), never a standalone route.
      if (owner.type !== 'method_declaration') continue;
      const mappingPaths = (annotation: SyntaxNode): string[] => {
        const args = field(annotation, 'arguments');
        const values = args?.namedChildren.flatMap(n => n.type === 'element_value_pair'
          ? /^(value|path)$/.test(field(n, 'key')?.text ?? '') ? [field(n, 'value')!] : []
          : [n]) ?? [];
        const paths = values.flatMap(n => n.type === 'element_value_array_initializer' ? n.namedChildren.map(string) : [string(n)])
          .filter((s): s is string => s !== undefined);
        return values.length ? paths : [''];
      };
      let controller = owner.parent;
      while (controller && controller.type !== 'class_declaration') controller = controller.parent;
      const prefix = controller?.namedChildren.find(n => n.type === 'modifiers')?.namedChildren
        .find(n => /^(annotation|marker_annotation)$/.test(n.type) && field(n, 'name')?.text.split('.').pop() === 'RequestMapping');
      const paths = mappingPaths(node);
      const verbs = name === 'RequestMapping' ? [...text.matchAll(/RequestMethod\.(\w+)/g)].map(m => m[1]) : [name.replace('Mapping', '').toUpperCase()];
      for (const base of prefix ? mappingPaths(prefix) : ['']) for (const path of paths) for (const verb of verbs.length ? verbs : ['*']) {
        route(verb, path ? `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : base || '/', node, owner);
      }
    }
    if (name === 'Path' && has(/(?:jakarta|javax)\.ws\.rs/)) {
      if (owner.type !== 'method_declaration') continue;
      const pathOf = (annotation: SyntaxNode): string | undefined => {
        const value = field(annotation, 'arguments')?.namedChildren[0];
        return string(value?.type === 'element_value_pair' ? field(value, 'value') : value);
      };
      const path = pathOf(node);
      let controller = owner.parent;
      while (controller && controller.type !== 'class_declaration') controller = controller.parent;
      const prefix = controller?.namedChildren.find(n => n.type === 'modifiers')?.namedChildren
        .find(n => /^(annotation|marker_annotation)$/.test(n.type) && field(n, 'name')?.text.split('.').pop() === 'Path');
      const base = prefix ? pathOf(prefix) : '';
      // A dynamic prefix cannot be resolved to the method's path alone.
      if (path === undefined || base === undefined) continue;
      const modifiers = owner.namedChildren.find(n => n.type === 'modifiers');
      const verbs = modifiers?.namedChildren.filter(n => /^(annotation|marker_annotation)$/.test(n.type)).map(n => field(n, 'name')?.text.split('.').pop() ?? '').filter(n => httpMethods.test(n)) ?? [];
      const joinedPath = path ? `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : base || '/';
      const fullPath = joinedPath.startsWith('/') ? joinedPath : `/${joinedPath}`;
      for (const verb of verbs) route(verb, fullPath, node, owner);
    }
  }
  // A parser result is a namespace only when assigned from that parser.
  for (const node of nodes.filter(n => calls.has(n.type))) {
    checkBudget();
    const callee = calleeOf(node);
    if (!/\.(opts|parse_args)$/.test(callee)) continue;
    const receiver = receiverDeclaration(callee, node);
    const assignment = node.parent;
    const left = assignment && (field(assignment, 'name') ?? field(assignment, 'left'));
    if (!receiver || !left || !declarationIds.has(left.id) || (field(assignment!, 'value') ?? field(assignment!, 'right'))?.id !== node.id) continue;
    for (const registration of optionRegistrations) if (registration.receiver === receiver.id) bind(left, registration.property, registration.names);
  }
  for (const node of nodes) {
    checkBudget();
    if (flagDestinationSites.some(site => site.startIndex <= node.startIndex && site.endIndex >= node.endIndex)) continue;
    if (node.parent && /assignment/.test(node.parent.type) && field(node.parent, 'left')?.id === node.id) continue;
    if (members.has(node.type)) {
      const object = field(node, 'object') ?? field(node, 'value');
      const property = field(node, 'property') ?? field(node, 'attribute') ?? field(node, 'field');
      if (object && property) {
        if (calls.has(object.type) && /\.opts$/.test(calleeOf(object))) {
          const receiver = receiverDeclaration(calleeOf(object), object);
          for (const registration of optionRegistrations) if (registration.receiver === receiver?.id && registration.property === property.text) {
            for (const key of registration.names) add('CliFlag', key, node);
          }
        }
        const declaration = object.text === 'this' ? (() => {
          let owner = node.parent;
          while (owner && owner.type !== 'class_declaration') owner = owner.parent;
          const found = owner && declarations.get(owner.id)?.get(property.text);
          return found?.length === 1 ? found[0] : undefined;
        })() : resolve(object.text, node);
        const names = declaration && destinations.get(declaration.id)?.get(object.text === 'this' ? '' : property.text);
        for (const key of names ?? []) add('CliFlag', key, node);
      }
    }
    const isReceiver = node.parent && (field(node.parent, 'object') ?? field(node.parent, 'value') ?? field(node.parent, 'operand'))?.id === node.id;
    if (node.type === 'identifier' && !declarationIds.has(node.id) && (!members.has(node.parent?.type ?? '') || isReceiver)) {
      const declaration = resolve(node.text, node);
      for (const key of declaration ? destinations.get(declaration.id)?.get('') ?? [] : []) add('CliFlag', key, node);
    }
  }
  const next = /(?:^|\/)app\/(?:(.*)\/)?route\.[cm]?[jt]sx?$/.exec(filePath);
  const exported = new Set<string>();
  if (next) for (const node of nodes) {
    if (!['function_declaration', 'variable_declarator'].includes(node.type)) continue;
    let parent = node.parent;
    while (parent && ['lexical_declaration', 'variable_declaration'].includes(parent.type)) parent = parent.parent;
    const name = field(node, 'name')?.text;
    if (parent?.type === 'export_statement' && name) exported.add(name);
  }
  if (next) for (const entity of definitions.filter(e => httpMethods.test(e.name) && exported.has(e.name))) {
    const path = '/' + (next[1] ?? '').split('/').filter(p => p && !/^\(.*\)$/.test(p)).join('/');
    facts.push({ kind: 'Route', key: `${entity.name} ${path}`, role: 'handler', symbol: qkey(entity), line: entity.lineStart });
  }
  return [...new Map(facts.map(f => [JSON.stringify(f), f])).values()];
}

/** Build on config entities the existing JSON/YAML/TOML parsers already recognized. */
export function configFileBindings(result: FileParseResult, source: string): FileParseResult {
  const facts: ConfigBinding[] = [];
  const file = result.entities.find(e => e.kind === 'file')!;
  const lines = source.split(/\r?\n/);
  if (result.language === 'json') {
    try {
      const walk = (value: unknown, path: string[]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        for (const [key, child] of Object.entries(value)) {
          const parts = [...path, key];
          const literal = child === null || ['string', 'number', 'boolean'].includes(typeof child);
          facts.push({ kind: 'ConfigKey', key: parts.join('.'), role: 'declaration', symbol: file.name, line: result.entities.find(e => e.name === key && e.container === (path.join('.') || undefined))?.lineStart ?? 1,
            ...(literal ? { defaultValue: child as ConfigBinding['defaultValue'] } : {}),
          });
          if (!literal) walk(child, parts);
        }
      };
      walk(JSON.parse(source), []);
    } catch { /* Existing parser owns malformed input handling. */ }
  } else {
    const stack: Array<{ indent: number; key: string }> = [];
    for (const e of result.entities.filter(e => e.kind === 'config_entry')) {
      const line = lines[e.lineStart - 1] ?? '';
      let key = e.container ? `${e.container}.${e.name}` : e.name;
      if (result.language === 'yaml') {
        const indent = line.length - line.trimStart().length;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        key = [...stack.map(p => p.key), e.name].join('.');
        stack.push({ indent, key: e.name });
      }
      const separator = line.indexOf(result.language === 'yaml' ? ':' : '=');
      const raw = separator >= 0 ? line.slice(separator + 1).trim() : '';
      let value = scalar(raw);
      if (result.language === 'yaml' && value === undefined && /^[A-Za-z_][\w./:-]*$/.test(raw)) value = raw;
      facts.push({ kind: 'ConfigKey', key, role: 'declaration', symbol: file.name, line: e.lineStart,
        ...(value !== undefined ? { defaultValue: value } : {}),
      });
    }
  }
  return facts.length ? { ...result, configBindings: facts } : result;
}
