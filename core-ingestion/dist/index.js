import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
// @ts-ignore — tree-sitter has no bundled types
import Parser from 'tree-sitter';
// @ts-ignore
import JavaScript from 'tree-sitter-javascript';
// @ts-ignore
import TypeScript from 'tree-sitter-typescript';
// @ts-ignore
import Python from 'tree-sitter-python';
// @ts-ignore
import Java from 'tree-sitter-java';
// @ts-ignore
import C from 'tree-sitter-c';
// @ts-ignore
import CPP from 'tree-sitter-cpp';
// @ts-ignore
import CSharp from 'tree-sitter-c-sharp';
// @ts-ignore
import Go from 'tree-sitter-go';
// @ts-ignore
import Rust from 'tree-sitter-rust';
// @ts-ignore
import Ruby from 'tree-sitter-ruby';
// @ts-ignore
import PHP from 'tree-sitter-php';
// @ts-ignore
import Scala from 'tree-sitter-scala';
const _require = createRequire(import.meta.url);
function tryLoadGrammar(pkg) {
    try {
        return _require(pkg);
    }
    catch {
        return null;
    }
}
const Kotlin = tryLoadGrammar('tree-sitter-kotlin');
const Swift = tryLoadGrammar('tree-sitter-swift');
import { SupportedLanguages, languageFromPath } from './languages.js';
import { LANGUAGE_QUERIES } from './queries.js';
import { classifyFileRole } from './role-classifier.js';
// ---------------------------------------------------------------------------
// Language → grammar map
// ---------------------------------------------------------------------------
const GRAMMAR_MAP = {
    [SupportedLanguages.JavaScript]: JavaScript,
    [SupportedLanguages.TypeScript]: TypeScript.typescript,
    [SupportedLanguages.Python]: Python,
    [SupportedLanguages.Java]: Java,
    [SupportedLanguages.C]: C,
    [SupportedLanguages.CPlusPlus]: CPP,
    [SupportedLanguages.CSharp]: CSharp,
    [SupportedLanguages.Go]: Go,
    [SupportedLanguages.Rust]: Rust,
    [SupportedLanguages.Ruby]: Ruby,
    [SupportedLanguages.PHP]: PHP.php_only,
    [SupportedLanguages.Scala]: Scala,
    ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
    ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};
// Capture key prefix → NodeKind string
const DEFINITION_KIND_MAP = {
    'definition.class': 'class',
    'definition.interface': 'interface',
    'definition.function': 'function',
    'definition.method': 'method',
    'definition.struct': 'class',
    'definition.enum': 'class',
    'definition.trait': 'trait',
    'definition.module': 'module',
    'definition.namespace': 'module',
    'definition.impl': 'class',
    'definition.type': 'class',
    'definition.property': 'function',
    'definition.const': 'function',
    'definition.static': 'function',
    'definition.macro': 'function',
    'definition.union': 'class',
    'definition.typedef': 'class',
    'definition.template': 'class',
    'definition.record': 'class',
    'definition.delegate': 'class',
    'definition.annotation': 'class',
    'definition.constructor': 'method',
};
// Primitive / built-in types to exclude from REFERENCES edges
const TYPE_BUILTINS = new Set([
    // TypeScript / JavaScript
    'string', 'number', 'boolean', 'void', 'null', 'undefined', 'any', 'never',
    'unknown', 'object', 'bigint', 'symbol',
    // Java / Kotlin / Scala
    'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short',
    'Character', 'Object', 'Void', 'Int', 'Unit', 'Any', 'AnyVal', 'AnyRef',
    'Nothing', 'Null', 'Char', 'Number',
    // C#
    'decimal',
    // Python
    'int', 'str', 'float', 'bool', 'bytes', 'Optional', 'Union', 'List', 'Dict',
    'Set', 'Tuple', 'Type',
    // Rust
    'i8', 'i16', 'i32', 'i64', 'i128', 'u8', 'u16', 'u32', 'u64', 'u128',
    'f32', 'f64', 'usize', 'isize',
    // Go
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'byte', 'rune', 'error',
    // Common stdlib collections / wrappers
    'Array', 'Map', 'Seq', 'Vector', 'Option', 'Future', 'Promise', 'Result',
    'Either', 'Try', 'IO', 'Observable', 'Iterator', 'Iterable',
    // C / C++
    'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t',
    'int16_t', 'int32_t', 'int64_t',
]);
// Builtins to exclude from CALLS edges — split by language family to avoid
// suppressing valid method names in other languages (e.g. `filter` is a Python
// builtin but also a common ORM method; `warn`/`error` are JS console methods
// but also valid Python logging method names).
// Keywords and pseudo-variables that are never valid call targets in any language.
const SHARED_BUILTINS = new Set([
    'if', 'for', 'while', 'return', 'new', 'this', 'self',
    'undefined', 'null', 'true', 'false',
    'println', // Scala/Java/Kotlin/Rust standard-output builtin — noise in any language
]);
// Python-specific builtins (bare function calls like `len(x)`, `range(n)`, etc.)
const PYTHON_BUILTINS = new Set([
    ...SHARED_BUILTINS,
    'print', 'len', 'range', 'int', 'str', 'float', 'list', 'dict',
    'set', 'tuple', 'type', 'isinstance', 'super', 'property', 'enumerate',
    'zip', 'map', 'filter', 'sorted', 'any', 'all', 'min', 'max', 'sum',
    'open', 'repr', 'abs', 'round', 'hash', 'id', 'callable', 'iter', 'next',
    'vars', 'dir', 'getattr', 'setattr', 'hasattr', 'delattr',
]);
// JavaScript/TypeScript-specific builtins
const JS_BUILTINS = new Set([
    ...SHARED_BUILTINS,
    'console', 'log', 'warn', 'error', 'debug', 'info',
    'module', 'exports',
    'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON',
    'Math', 'Date', 'Error', 'Map', 'Set', 'Symbol',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'process', 'Buffer', 'global', 'window', 'document',
    'require', 'fetch', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
]);
// Per-language BUILTINS lookup — falls back to shared for languages without a
// specific set (e.g. Java, Go, Rust) so they only skip obvious non-calls.
function builtinsForLanguage(lang) {
    switch (lang) {
        case SupportedLanguages.Python:
            return PYTHON_BUILTINS;
        case SupportedLanguages.JavaScript:
        case SupportedLanguages.TypeScript:
            return JS_BUILTINS;
        default:
            return SHARED_BUILTINS;
    }
}
/** Returns true if a grammar is installed for the given file's language. */
export function isGrammarSupported(filePath) {
    const language = languageFromPath(filePath);
    if (!language)
        return false;
    if (filePath.endsWith('.tsx'))
        return true; // TSX uses TypeScript.tsx, always available
    return GRAMMAR_MAP[language] !== undefined;
}
// ---------------------------------------------------------------------------
// Parser instance (reused across calls)
// ---------------------------------------------------------------------------
let _parser = null;
const _queryCache = new Map();
function getParser() {
    if (!_parser)
        _parser = new Parser();
    return _parser;
}
function getCachedQuery(language, grammar, querySource) {
    const cached = _queryCache.get(language);
    if (cached && cached.grammar === grammar)
        return cached.query;
    const query = new Parser.Query(grammar, querySource);
    _queryCache.set(language, { grammar, query });
    return query;
}
// ---------------------------------------------------------------------------
// Rust: cfg macro unwrapping
// ---------------------------------------------------------------------------
/**
 * Blanks out feature-gating macro wrappers in Rust source so that the items
 * inside become visible to tree-sitter as top-level declarations.
 *
 * Replaces `cfg_rt! { ... }` (and similar) with the body contents in-place,
 * preserving every character position and line number so that entity line
 * numbers remain accurate.
 */
function unwrapRustCfgMacros(source) {
    const re = /\bcfg_(?:rt_multi_thread|not_rt|rt|io|time|sync|net|fs|process|signal)!\s*\{/g;
    const chars = source.split('');
    let m;
    while ((m = re.exec(source)) !== null) {
        const openBrace = m.index + m[0].length - 1; // position of the `{`
        // Find matching closing brace by counting depth
        let depth = 0;
        let closeBrace = -1;
        for (let i = openBrace; i < source.length; i++) {
            if (source[i] === '{')
                depth++;
            else if (source[i] === '}') {
                depth--;
                if (depth === 0) {
                    closeBrace = i;
                    break;
                }
            }
        }
        if (closeBrace === -1)
            continue;
        // Blank out everything from start of macro name up to and including `{`
        for (let i = m.index; i <= openBrace; i++) {
            if (chars[i] !== '\n')
                chars[i] = ' ';
        }
        // Blank out the matching closing `}`
        chars[closeBrace] = ' ';
    }
    return chars.join('');
}
// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------
export function parseFile(filePath, source) {
    const language = languageFromPath(filePath);
    if (!language)
        return null;
    // TypeScript TSX uses a separate grammar
    const isTsx = filePath.endsWith('.tsx');
    const grammar = isTsx ? TypeScript.tsx : GRAMMAR_MAP[language];
    if (!grammar)
        return null;
    const queries = LANGUAGE_QUERIES[language];
    if (!queries)
        return null;
    try {
        const parser = getParser();
        parser.setLanguage(grammar);
        // tree-sitter-java cannot parse array-type annotations on varargs params
        // (e.g. `@Nullable Object @Nullable ... args`). The second annotation causes
        // error recovery to truncate the enclosing class_declaration, orphaning all
        // subsequent methods. Strip any @Annotation immediately before `...` in-memory
        // so the class body parses correctly.
        let parseSource = language === SupportedLanguages.Java
            ? source.replace(/@\w+\s*(?=\.\.\.)/g, '')
            : source;
        // Rust: unwrap feature-gating macros (cfg_rt! { ... }, cfg_io! { ... }, etc.)
        // These macros are transparent pass-throughs — their bodies contain normal items
        // that tree-sitter cannot see because they are parsed as raw token_tree nodes.
        // We blank out the macro call and matching closing brace in-place (preserving
        // character positions and line numbers) so the inner items become top-level.
        if (language === SupportedLanguages.Rust) {
            parseSource = unwrapRustCfgMacros(parseSource);
        }
        const tree = parser.parse(parseSource, undefined, { bufferSize: parseSource.length + 1 });
        const cacheKey = isTsx ? 'tsx' : language;
        const query = getCachedQuery(cacheKey, grammar, queries);
        const matches = query.matches(tree.rootNode);
        const fileName = nodePath.basename(filePath);
        let sourceLineCount = 1;
        for (let i = 0; i < source.length; i++) {
            if (source.charCodeAt(i) === 10)
                sourceLineCount++;
        }
        const entities = [
            { name: fileName, kind: 'file', lineStart: 1, lineEnd: sourceLineCount, language },
        ];
        const chunks = [];
        const relationships = [];
        const pendingChunks = [];
        // Track class ranges for containment: [name, startLine, endLine]
        const classRanges = [];
        // Track seen calls per enclosing scope to avoid duplicate CALLS edges
        const seenCalls = new Map();
        // Track seen type references per enclosing class/file to avoid duplicate REFERENCES edges
        const seenRefs = new Map();
        // Python: map function name → (param name → declared type) for typed-parameter qualifier substitution
        const paramTypeMap = new Map();
        // Python: map function name → (variable name → assigned type) for untyped-param qualifier substitution
        const assignTypeMap = new Map();
        // --- First pass: collect definitions ---
        for (const match of matches) {
            // Definition captures: name + definition.*
            const defCapture = match.captures.find((c) => c.name.startsWith('definition.'));
            const nameCapture = match.captures.find((c) => c.name === 'name');
            if (defCapture) {
                const kind = DEFINITION_KIND_MAP[defCapture.name] ?? 'function';
                const name = nameCapture?.node.text
                    ?? (defCapture.name === 'definition.constructor' ? 'init' : '');
                if (!name || name.length === 0)
                    continue;
                const defNode = defCapture.node;
                const lineStart = defNode.startPosition.row + 1;
                const lineEnd = defNode.endPosition.row + 1;
                const startByte = defNode.startIndex;
                const endByte = defNode.endIndex;
                // Containment: file CONTAINS or class CONTAINS.
                // For Go methods the receiver type IS the container — methods are defined
                // outside the struct body so findEnclosing() always returns null for them.
                // The receiver.type capture (emitted by the Go method queries) overrides this.
                const enclosing = findEnclosing(classRanges, lineStart, name);
                const receiverCapture = match.captures.find((c) => c.name === 'receiver.type');
                // heritageClassCapture is set by the Go interface method query, where @heritage.class
                // captures the interface name and serves as the container (like receiver.type for structs).
                const heritageClassCapture = match.captures.find((c) => c.name === 'heritage.class');
                const effectiveContainer = (receiverCapture && kind === 'method')
                    ? receiverCapture.node.text
                    : (heritageClassCapture && kind === 'method')
                        ? heritageClassCapture.node.text
                        : (enclosing ?? undefined);
                entities.push({
                    name,
                    kind,
                    lineStart,
                    lineEnd,
                    language,
                    container: effectiveContainer,
                });
                pendingChunks.push({
                    name,
                    chunkKind: kind,
                    lineStart,
                    lineEnd,
                    startByte,
                    endByte,
                    language,
                    container: enclosing ?? undefined,
                });
                if (kind === 'class' || kind === 'interface' || kind === 'trait') {
                    classRanges.push({ name, start: lineStart, end: lineEnd });
                }
                if (effectiveContainer) {
                    relationships.push({ srcName: effectiveContainer, dstName: name, predicate: 'CONTAINS' });
                }
                else {
                    relationships.push({ srcName: fileName, dstName: name, predicate: 'CONTAINS' });
                }
                continue;
            }
            // Heritage: EXTENDS
            const heritageClass = match.captures.find((c) => c.name === 'heritage.class');
            const heritageExtends = match.captures.find((c) => c.name === 'heritage.extends' || c.name === 'heritage.trait');
            if (heritageClass && heritageExtends) {
                relationships.push({
                    srcName: heritageClass.node.text,
                    dstName: heritageExtends.node.text,
                    predicate: 'EXTENDS',
                });
                continue;
            }
            // Heritage: IMPLEMENTS (separate edge type, use EXTENDS for simplicity)
            const heritageImpl = match.captures.find((c) => c.name === 'heritage.implements');
            if (heritageClass && heritageImpl) {
                relationships.push({
                    srcName: heritageClass.node.text,
                    dstName: heritageImpl.node.text,
                    predicate: 'EXTENDS',
                });
                continue;
            }
            // Python typed parameters: build paramTypeMap for qualifier substitution in the second pass.
            // Maps function name → (param name → declared type) so that e.g. `query: Query` lets us
            // rewrite `query.filter(...)` → `Query.filter` when building effectiveCallee.
            if (language === SupportedLanguages.Python) {
                const typedParamScope = match.captures.find((c) => c.name === '_typed_param_scope');
                const typedParamName = match.captures.find((c) => c.name === '_typed_param_name');
                const typedParamType = match.captures.find((c) => c.name === '_typed_param_type');
                if (typedParamScope && typedParamName && typedParamType) {
                    const funcName = typedParamScope.node.childForFieldName?.('name')?.text;
                    if (funcName) {
                        if (!paramTypeMap.has(funcName))
                            paramTypeMap.set(funcName, new Map());
                        paramTypeMap.get(funcName).set(typedParamName.node.text, typedParamType.node.text);
                    }
                    continue;
                }
                // Assignment tracking: x = SomeClass() or x = Model.objects.method()
                const assignScope = match.captures.find((c) => c.name === '_assign_scope');
                const assignLhs = match.captures.find((c) => c.name === '_assign_lhs');
                const assignRhsType = match.captures.find((c) => c.name === '_assign_rhs_type');
                if (assignScope && assignLhs && assignRhsType) {
                    // Only track PascalCase RHS names (constructors by convention).
                    // Lowercase function calls like `select(...)` or `create_engine(...)` are skipped
                    // to avoid cross-module false edges (e.g. orm.query → select.where in SQLAlchemy).
                    const rhsName = assignRhsType.node.text;
                    if (/^[A-Z]/.test(rhsName)) {
                        const funcName = assignScope.node.childForFieldName?.('name')?.text;
                        if (funcName) {
                            if (!assignTypeMap.has(funcName))
                                assignTypeMap.set(funcName, new Map());
                            assignTypeMap.get(funcName).set(assignLhs.node.text, rhsName);
                        }
                    }
                    continue;
                }
            }
        }
        // --- Second pass: calls and imports ---
        for (const match of matches) {
            // Full import statement captures (Scala: reconstructs dotted package paths)
            const importStmt = match.captures.find((c) => c.name === 'import.stmt');
            if (importStmt) {
                const raw = importStmt.node.text.replace(/^import\s+/, '').trim();
                const line = importStmt.node.startPosition.row + 1;
                if (raw.endsWith('._')) {
                    // Wildcard: "ix.memory.model._" → package path "ix.memory.model"
                    const pkgPath = raw.slice(0, -2);
                    entities.push({ name: pkgPath, kind: 'module', lineStart: line, lineEnd: line, language });
                    relationships.push({ srcName: fileName, dstName: pkgPath, predicate: 'IMPORTS' });
                }
                else {
                    const braceIdx = raw.lastIndexOf('.{');
                    if (braceIdx !== -1) {
                        // Selective: "ix.memory.model.{NodeKind, GraphNode}"
                        const prefix = raw.slice(0, braceIdx);
                        const names = raw.slice(braceIdx + 2, -1).split(',').map((s) => s.trim()).filter(Boolean);
                        for (const name of names) {
                            const dstName = `${prefix}.${name}`;
                            entities.push({ name: dstName, kind: 'module', lineStart: line, lineEnd: line, language });
                            relationships.push({ srcName: fileName, dstName, predicate: 'IMPORTS' });
                        }
                    }
                    else {
                        // Simple: "ix.memory.model.NodeKind"
                        entities.push({ name: raw, kind: 'module', lineStart: line, lineEnd: line, language });
                        relationships.push({ srcName: fileName, dstName: raw, predicate: 'IMPORTS' });
                    }
                }
                continue;
            }
            // Import captures (JS/TS/Python path-based)
            const importSource = match.captures.find((c) => c.name === 'import.source');
            if (importSource) {
                let importPath = importSource.node.text
                    .replace(/^["'`]|["'`]$/g, '') // strip quotes
                    .replace(/\\\\/g, '/'); // normalise backslashes
                if (importPath.length > 0 && importPath !== '*') {
                    const rawMod = importPath.split('/').filter((s) => s !== '*').pop() ?? importPath;
                    const modName = rawMod.replace(/^\.+/, ''); // strip leading dots: '.models' → 'models'
                    if (!modName)
                        continue; // skip bare '.' relative imports
                    entities.push({ name: modName, kind: 'module', lineStart: importSource.node.startPosition.row + 1, lineEnd: importSource.node.startPosition.row + 1, language });
                    relationships.push({ srcName: fileName, dstName: modName, predicate: 'IMPORTS' });
                }
                continue;
            }
            // Import name captures (e.g. from . import utils — the symbol name, not the module path)
            const importName = match.captures.find((c) => c.name === 'import.name');
            if (importName) {
                const name = importName.node.text;
                if (name && name !== '*' && name.length > 1) {
                    entities.push({ name, kind: 'module', lineStart: importName.node.startPosition.row + 1, lineEnd: importName.node.startPosition.row + 1, language });
                    relationships.push({ srcName: fileName, dstName: name, predicate: 'IMPORTS' });
                }
                continue;
            }
            // Call captures
            const callName = match.captures.find((c) => c.name === 'call.name');
            if (callName) {
                const callee = callName.node.text;
                if (!callee || callee.length <= 1)
                    continue;
                // If a _qualifier capture is present (field_expression / stable_identifier
                // patterns like NodeKind.Decision, or Python attribute calls like
                // Session.execute), emit the fully qualified name so that resolution can use
                // the qualifier to break ties between same-named symbols in different files.
                // BUILTINS filtering is skipped for attribute calls: method names like
                // `filter` or `map` are Python builtins when called bare, but are valid
                // user-defined method calls when invoked as `query.filter(...)`.
                const qualifierCapture = match.captures.find((c) => c.name === '_qualifier');
                if (builtinsForLanguage(language).has(callee) && !qualifierCapture)
                    continue;
                // Find enclosing function/method for the call; fall back to enclosing class
                // (e.g. calls in val/lazy val body at class level) before falling back to file.
                const callLine = callName.node.startPosition.row + 1;
                const caller = findEnclosingFunction(entities, callLine)
                    ?? findEnclosing(classRanges, callLine, '')
                    ?? fileName;
                const scope = caller;
                if (!seenCalls.has(scope))
                    seenCalls.set(scope, new Set());
                const seen = seenCalls.get(scope);
                const effectiveCallee = (() => {
                    if (!qualifierCapture)
                        return callee;
                    let qualifier = qualifierCapture.node.text;
                    // Python: 'self'/'cls' always refers to the enclosing class — substitute it
                    // so the edge reads 'Query.filter' instead of 'self.filter', enabling
                    // same-file resolution without type inference.
                    if (language === SupportedLanguages.Python && (qualifier === 'self' || qualifier === 'cls')) {
                        const enclosingClass = findEnclosing(classRanges, callLine, '');
                        if (enclosingClass)
                            qualifier = enclosingClass;
                    }
                    else if (qualifier === 'this') {
                        // JS/TS: 'this' inside a class method refers to the enclosing class.
                        // Substitute so e.g. `this.save()` → `Document.save` instead of `this.save`.
                        const enclosingClass = findEnclosing(classRanges, callLine, '');
                        if (enclosingClass)
                            qualifier = enclosingClass;
                    }
                    else if (language === SupportedLanguages.Python) {
                        // Typed-parameter substitution: if the qualifier is a param with a declared type,
                        // use the type name so e.g. `query.filter(...)` → `Query.filter`.
                        // Also check assignTypeMap for variables assigned from constructor/ORM calls.
                        const funcName = findEnclosingFunction(entities, callLine);
                        if (funcName) {
                            const typeForParam = paramTypeMap.get(funcName)?.get(qualifier);
                            const typeForAssign = assignTypeMap.get(funcName)?.get(qualifier);
                            if (typeForParam)
                                qualifier = typeForParam;
                            else if (typeForAssign)
                                qualifier = typeForAssign;
                        }
                    }
                    return `${qualifier}.${callee}`;
                })();
                if (!seen.has(effectiveCallee)) {
                    seen.add(effectiveCallee);
                    relationships.push({ srcName: caller, dstName: effectiveCallee, predicate: 'CALLS' });
                }
                continue;
            }
            // Type reference captures
            const refType = match.captures.find((c) => c.name === 'reference.type');
            if (refType) {
                const typeName = refType.node.text;
                if (!typeName || TYPE_BUILTINS.has(typeName) || typeName.length <= 1)
                    continue;
                // Use the enclosing class as the src so the edge reads "ClassX REFERENCES TypeY".
                // Fall back to the file name when no enclosing class is found (top-level usage).
                const refLine = refType.node.startPosition.row + 1;
                const src = findEnclosing(classRanges, refLine, typeName) ?? fileName;
                if (!seenRefs.has(src))
                    seenRefs.set(src, new Set());
                const seen = seenRefs.get(src);
                if (!seen.has(typeName)) {
                    seen.add(typeName);
                    relationships.push({ srcName: src, dstName: typeName, predicate: 'REFERENCES' });
                }
                continue;
            }
        }
        for (const pendingChunk of pendingChunks) {
            const chunkText = source.slice(pendingChunk.startByte, pendingChunk.endByte);
            const contentHash = crypto.createHash('sha256').update(chunkText).digest('hex').slice(0, 16);
            chunks.push({
                ...pendingChunk,
                contentHash,
            });
        }
        // Fallback: if no semantic chunks found, emit one file_body chunk covering the whole file
        if (chunks.length === 0) {
            const contentHash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
            chunks.push({
                name: null,
                chunkKind: 'file_body',
                lineStart: 1,
                lineEnd: sourceLineCount,
                startByte: 0,
                endByte: source.length,
                contentHash,
                language,
            });
        }
        return { filePath, language, entities, chunks, relationships, fileRole: classifyFileRole(filePath, source) };
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// resolveCallEdges helpers
// ---------------------------------------------------------------------------
/** Build the qualified key for an entity (mirrors buildPatch's entityQKey logic). */
function qualifiedKey(e) {
    return e.container ? `${e.container}.${e.name}` : e.name;
}
/**
 * Given a file's qualified-key map and a plain callee name, return the single
 * unambiguous qualified key, or null if the name maps to 0 or >1 entities.
 * Callers must treat null as "do not emit" to avoid dangling nodeIds.
 */
function bestQKey(fileQKeys, filePath, plainName) {
    const qks = [...new Set(fileQKeys.get(filePath)?.get(plainName) ?? [])];
    return qks.length === 1 ? qks[0] : null;
}
/**
 * Resolves CALLS and EXTENDS relationships to their cross-file targets by
 * building a symbol table and import map over the full batch of parsed files.
 *
 * Tiers (in priority order):
 *   0.9 — import-scoped: dst is in a file the src explicitly imports
 *   0.8 — transitive import-scoped: one re-export hop away
 *   0.5 — global fallback: dst exists in exactly one other file (unambiguous)
 *
 * Same-file edges are already handled correctly by buildPatch and are not
 * emitted here.
 *
 * Import resolution handles:
 *   - Stem-based:      './payments'     → 'payments.ts'
 *   - Path-aliased:    '@/lib/payments' → 'payments.ts'  (last segment)
 *   - Directory index: './services'     → 'services/index.ts'
 *   - Bare aliases:    '@components'    → 'components.ts' (strip leading non-word chars)
 *   - Dotted paths:    'ix.memory.model.Edge' → stem 'Edge' → 'Edge.scala'
 *                      (handles Scala/Java package imports where tree-sitter
 *                       emits each identifier separately)
 *
 * Qualified-key resolution:
 *   - Module-level function/class: dstQualifiedKey === dstName
 *   - Unambiguous class method: dstQualifiedKey === 'ClassName.method'
 *   - Ambiguous (two entities share the same plain name): edge not emitted
 */
export function resolveEdges(results, stats) {
    // Provide a default no-op stats bag when caller passes none (backward compat).
    if (!stats)
        stats = {
            importLookups: 0, transitiveLookups: 0, globalFallbacks: 0,
            globalCandidateTotal: 0, resolvedImport: 0, resolvedTransitive: 0,
            resolvedGlobal: 0, resolvedQualifier: 0, skippedSameFile: 0, skippedAmbiguous: 0,
        };
    // fileQKeys: filePath → (plainName → qualifiedKeys[])
    // Mirrors the entityQKey computation in buildPatch so nodeIds match exactly.
    const fileQKeys = new Map();
    for (const r of results) {
        const qkMap = new Map();
        for (const e of r.entities) {
            if (e.kind === 'file' || e.kind === 'module')
                continue;
            const qk = qualifiedKey(e);
            const list = qkMap.get(e.name) ?? [];
            list.push(qk);
            qkMap.set(e.name, list);
        }
        fileQKeys.set(r.filePath, qkMap);
    }
    // fileHasSymbol: filePath → Set<plainName>  (fast membership check)
    const fileHasSymbol = new Map();
    for (const [fp, qkMap] of fileQKeys) {
        fileHasSymbol.set(fp, new Set(qkMap.keys()));
    }
    // resultsByPath: O(1) lookup replacing results.find() in transitive import loop
    const resultsByPath = new Map(results.map(r => [r.filePath, r]));
    // symbolToFiles: plainName → filePath[]  — replaces O(F) full-scan in tier-3 and qualifier fallback
    const symbolToFiles = new Map();
    for (const [fp, symbols] of fileHasSymbol) {
        for (const sym of symbols) {
            const list = symbolToFiles.get(sym) ?? [];
            list.push(fp);
            symbolToFiles.set(sym, list);
        }
    }
    // fileLanguage: filePath → SupportedLanguages (fast language lookup without re-calling languageFromPath)
    const fileLanguage = new Map();
    for (const r of results) {
        fileLanguage.set(r.filePath, r.language);
    }
    // stemToFiles: basename-without-extension → filePath[]
    // Matches the last path segment of an import to files in the batch.
    const stemToFiles = new Map();
    for (const r of results) {
        const stem = nodePath.basename(r.filePath, nodePath.extname(r.filePath));
        const list = stemToFiles.get(stem) ?? [];
        list.push(r.filePath);
        stemToFiles.set(stem, list);
    }
    // dirToIndexFiles: directory basename → filePath[] for 'index.*' files
    // Handles directory imports: './services' → 'services/index.ts'
    const dirToIndexFiles = new Map();
    for (const r of results) {
        const stem = nodePath.basename(r.filePath, nodePath.extname(r.filePath));
        if (stem === 'index') {
            const dirName = nodePath.basename(nodePath.dirname(r.filePath));
            const list = dirToIndexFiles.get(dirName) ?? [];
            list.push(r.filePath);
            dirToIndexFiles.set(dirName, list);
        }
    }
    // packageToFiles: dotted package path → filePath[] (Scala/Java wildcard imports)
    // e.g. "ix.memory.model" → all .scala files under .../ix/memory/model/
    // Builds all suffix keys so that both "model" and "ix.memory.model" resolve.
    const packageToFiles = new Map();
    for (const r of results) {
        const ext = nodePath.extname(r.filePath);
        if (ext !== '.scala' && ext !== '.java')
            continue;
        const dir = nodePath.dirname(r.filePath);
        const parts = dir.split(/[/\\]/);
        // Cap at 8 segments to avoid noise from very shallow path components like "src", "main".
        const maxDepth = Math.min(8, parts.length);
        for (let i = parts.length - 1; i >= parts.length - maxDepth; i--) {
            const pkg = parts.slice(i).join('.');
            const list = packageToFiles.get(pkg) ?? [];
            if (!list.includes(r.filePath))
                list.push(r.filePath);
            packageToFiles.set(pkg, list);
        }
    }
    // goPkgDirToFiles: Go package directory name → filePath[]
    // In Go, the last segment of an import path IS the package directory name.
    // e.g. import "go.etcd.io/etcd/server/etcdserver" is stripped to modName "etcdserver"
    // by the import processor; this index maps that name to all .go files in
    // any directory named "etcdserver" within the ingested batch.
    const goPkgDirToFiles = new Map();
    for (const r of results) {
        if (nodePath.extname(r.filePath) !== '.go')
            continue;
        const dirName = nodePath.basename(nodePath.dirname(r.filePath));
        const list = goPkgDirToFiles.get(dirName) ?? [];
        if (!list.includes(r.filePath))
            list.push(r.filePath);
        goPkgDirToFiles.set(dirName, list);
    }
    // ── Helpers ────────────────────────────────────────────────────────
    /** Resolve a module name to matching file paths in the batch. */
    function modNameToFiles(modName, excludeFp) {
        const fps = [];
        // Strip leading non-word chars for bare aliases: '@components' → 'components'
        const candidates = [modName];
        const stripped = modName.replace(/^[^a-zA-Z0-9_]+/, '');
        if (stripped && stripped !== modName)
            candidates.push(stripped);
        // Strip file extensions so "explain.js" resolves to the "explain" stem
        // (TS/JS ESM imports use .js extensions that map to .ts source files)
        const noExt = modName.replace(/\.(js|ts|mjs|cjs|jsx|tsx|py|scala|java|c|cc|cpp|cxx|h|hh|hpp|hxx)$/, '');
        if (noExt !== modName && noExt && !candidates.includes(noExt))
            candidates.push(noExt);
        // For dotted paths (Scala/Java: 'ix.memory.model.Edge'), also try last segment
        const lastDot = modName.lastIndexOf('.');
        if (lastDot !== -1) {
            const lastSegment = modName.slice(lastDot + 1);
            if (lastSegment && !candidates.includes(lastSegment))
                candidates.push(lastSegment);
        }
        for (const cand of candidates) {
            for (const fp of stemToFiles.get(cand) ?? []) {
                if (fp !== excludeFp)
                    fps.push(fp);
            }
            for (const fp of dirToIndexFiles.get(cand) ?? []) {
                if (fp !== excludeFp)
                    fps.push(fp);
            }
        }
        // Package-path wildcard resolution (Scala/Java): "ix.memory.model" → all files in that dir
        for (const fp of packageToFiles.get(modName) ?? []) {
            if (fp !== excludeFp && !fps.includes(fp))
                fps.push(fp);
        }
        // Go package directory resolution: "etcdserver" → all .go files in .../etcdserver/
        // The last segment of a Go import path is the package directory name, not a file stem.
        for (const fp of goPkgDirToFiles.get(modName) ?? []) {
            if (fp !== excludeFp && !fps.includes(fp))
                fps.push(fp);
        }
        return fps;
    }
    function tokenizeSymbolParts(value) {
        return value
            .replace(/([a-z\d])([A-Z])/g, '$1 $2')
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
    }
    const GENERIC_RESOLUTION_TOKENS = new Set([
        'run', 'job', 'file', 'files', 'table', 'tables', 'output', 'outputs',
        'input', 'inputs', 'background',
    ]);
    function candidateStem(filePath) {
        return nodePath.basename(filePath, nodePath.extname(filePath)).toLowerCase();
    }
    function pickCallerAlignedCandidate(matches, srcName, dstName) {
        if (matches.length === 0)
            return null;
        const srcTokens = new Set(tokenizeSymbolParts(srcName).filter(token => !GENERIC_RESOLUTION_TOKENS.has(token)));
        const overlapScores = matches.map(fp => {
            const qKeys = fileQKeys.get(fp)?.get(dstName) ?? [];
            const candidateTokens = new Set(tokenizeSymbolParts(candidateStem(fp)));
            for (const qKey of qKeys) {
                for (const token of tokenizeSymbolParts(qKey))
                    candidateTokens.add(token);
            }
            let overlap = 0;
            for (const token of candidateTokens) {
                if (!GENERIC_RESOLUTION_TOKENS.has(token) && srcTokens.has(token))
                    overlap++;
            }
            return { fp, overlap };
        });
        const maxOverlap = Math.max(...overlapScores.map(x => x.overlap));
        if (maxOverlap <= 0)
            return null;
        const bestMatches = overlapScores.filter(x => x.overlap === maxOverlap);
        return {
            chosen: bestMatches.length === 1 ? bestMatches[0].fp : null,
            best: bestMatches,
        };
    }
    function narrowCCandidates(matches, srcFilePath, srcLanguage, srcName, dstName) {
        if (matches.length <= 1)
            return matches;
        // C# partial class narrowing: multiple files may define the same class via
        // partial class (e.g. JsonReader.cs + JsonReader.Async.cs both define JsonReader).
        // Prefer the canonical file whose stem exactly matches the destination class name
        // over variant files that have additional dot-segments in the stem.
        if (srcLanguage === SupportedLanguages.CSharp) {
            const dstNameLower = dstName.toLowerCase();
            const canonicalMatches = matches.filter(fp => candidateStem(fp) === dstNameLower);
            if (canonicalMatches.length === 1)
                return canonicalMatches;
        }
        if (srcLanguage !== SupportedLanguages.C && srcLanguage !== SupportedLanguages.CPlusPlus)
            return matches;
        let narrowed = matches;
        const implExts = ['.c', '.cpp', '.cc', '.cxx'];
        const implMatches = narrowed.filter(fp => implExts.some(ext => fp.endsWith(ext)));
        if (implMatches.length === 1)
            narrowed = implMatches;
        if (narrowed.length <= 1)
            return narrowed;
        const srcParts = srcFilePath.replace(/\\/g, '/').split('/');
        const withProximity = narrowed.map(fp => {
            const fpParts = fp.replace(/\\/g, '/').split('/');
            let common = 0;
            while (common < srcParts.length && common < fpParts.length && srcParts[common] === fpParts[common]) {
                common++;
            }
            return { fp, common };
        });
        const maxCommon = Math.max(...withProximity.map(x => x.common));
        const proximityMatches = withProximity.filter(x => x.common === maxCommon).map(x => x.fp);
        if (proximityMatches.length === 1)
            return proximityMatches;
        const callerAligned = pickCallerAlignedCandidate(narrowed, srcName, dstName);
        if (callerAligned?.chosen)
            return [callerAligned.chosen];
        const callerAlignedCandidates = pickCallerAlignedCandidate(matches, srcName, dstName);
        if (callerAlignedCandidates?.best) {
            const implAlignedMatches = callerAlignedCandidates.best
                .map(match => match.fp)
                .filter(fp => ['.c', '.cpp', '.cc', '.cxx'].some(ext => fp.endsWith(ext)));
            if (implAlignedMatches.length === 1)
                return implAlignedMatches;
        }
        return narrowed;
    }
    // ── Main resolution loop ───────────────────────────────────────────
    const resolved = [];
    for (const result of results) {
        const srcFilePath = result.filePath;
        const srcLanguage = result.language;
        const srcSymbols = fileHasSymbol.get(srcFilePath);
        // Build the set of file paths this file explicitly imports.
        const importedFilePaths = new Set();
        for (const rel of result.relationships) {
            if (rel.predicate !== 'IMPORTS')
                continue;
            for (const fp of modNameToFiles(rel.dstName, srcFilePath)) {
                importedFilePaths.add(fp);
            }
        }
        // Build one-hop transitive import set.
        // Handles re-exports: baz.ts → index.ts (re-exports from bar.ts) → bar.ts
        const transitiveFilePaths = new Set();
        for (const fp of importedFilePaths) {
            const fpResult = resultsByPath.get(fp);
            if (!fpResult)
                continue;
            for (const rel of fpResult.relationships) {
                if (rel.predicate !== 'IMPORTS')
                    continue;
                for (const transitiveFp of modNameToFiles(rel.dstName, srcFilePath)) {
                    if (!importedFilePaths.has(transitiveFp))
                        transitiveFilePaths.add(transitiveFp);
                }
            }
        }
        for (const rel of result.relationships) {
            if (rel.predicate !== 'CALLS' && rel.predicate !== 'EXTENDS' && rel.predicate !== 'REFERENCES' && rel.predicate !== 'IMPORTS')
                continue;
            // Resolve Scala/Java dotted class imports (e.g. "ix.memory.model.ClaimId")
            // to the actual indexed entity node in the defining file.
            // Uses package-path lookup: extract package ("ix.memory.model") and entity
            // name ("ClaimId"), find files registered under that package, then find
            // the one that defines the entity.
            if (rel.predicate === 'IMPORTS') {
                if (result.language !== SupportedLanguages.Scala && result.language !== SupportedLanguages.Java)
                    continue;
                const dstName = rel.dstName;
                const lastDot = dstName.lastIndexOf('.');
                if (lastDot === -1)
                    continue; // not a dotted class import
                const entityName = dstName.slice(lastDot + 1);
                if (!entityName || entityName === '_')
                    continue; // wildcard import
                const pkgPath = dstName.slice(0, lastDot); // e.g. "ix.memory.model"
                // Find files in the declared package that define this entity
                const pkgFiles = packageToFiles.get(pkgPath) ?? [];
                const matchFiles = pkgFiles.filter(fp => fp !== srcFilePath && fileHasSymbol.get(fp)?.has(entityName));
                if (matchFiles.length !== 1)
                    continue; // ambiguous or not found
                const fp = matchFiles[0];
                const dstQualifiedKey = bestQKey(fileQKeys, fp, entityName);
                if (dstQualifiedKey === null)
                    continue;
                resolved.push({ srcFilePath, srcName: rel.srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: 'IMPORTS', confidence: 0.9 });
                continue;
            }
            const dstName = rel.dstName;
            const srcName = rel.srcName;
            // Tier 1b: qualifier-assisted (confidence 0.9 / 0.7)
            // For dotted names like "NodeKind.Decision" (emitted by field_expression queries):
            // find the file defining the qualifier, then check it also defines the member.
            // This breaks ties where both NodeKind.Decision and SourceType.Decision exist.
            const qualDot = dstName.lastIndexOf('.');
            if (qualDot !== -1) {
                const qualifierPart = dstName.slice(0, qualDot);
                const memberPart = dstName.slice(qualDot + 1);
                if (memberPart && qualifierPart) {
                    // Try import-scoped qualifier first
                    const qualImportMatches = [];
                    for (const fp of importedFilePaths) {
                        if (fileHasSymbol.get(fp)?.has(qualifierPart))
                            qualImportMatches.push(fp);
                    }
                    if (qualImportMatches.length === 1) {
                        const qfp = qualImportMatches[0];
                        if (fileHasSymbol.get(qfp)?.has(memberPart)) {
                            const dstQualifiedKey = bestQKey(fileQKeys, qfp, memberPart);
                            if (dstQualifiedKey !== null) {
                                // dstName must match rel.dstName so buildPatchWithResolution can look it up
                                resolved.push({ srcFilePath, srcName, dstFilePath: qfp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.9 });
                            }
                        }
                        continue;
                    }
                    // Global qualifier fallback — use symbolToFiles index instead of full scan
                    const qualGlobalMatches = (symbolToFiles.get(qualifierPart) ?? []).filter(fp => fp !== srcFilePath);
                    if (qualGlobalMatches.length === 1) {
                        const qfp = qualGlobalMatches[0];
                        if (fileHasSymbol.get(qfp)?.has(memberPart)) {
                            const dstQualifiedKey = bestQKey(fileQKeys, qfp, memberPart);
                            if (dstQualifiedKey !== null) {
                                resolved.push({ srcFilePath, srcName, dstFilePath: qfp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.7 });
                            }
                        }
                    }
                    continue; // qualified name exhausted — don't try bare-name tiers
                }
            }
            // Tier 1: same-file — already correct in buildPatch, skip here
            if (srcSymbols.has(dstName))
                continue;
            // Tier 2: import-scoped (confidence 0.9)
            const importMatches = [];
            for (const fp of importedFilePaths) {
                if (fileHasSymbol.get(fp)?.has(dstName))
                    importMatches.push(fp);
            }
            const narrowedImportMatches = narrowCCandidates(importMatches, srcFilePath, srcLanguage, srcName, dstName);
            if (narrowedImportMatches.length === 1) {
                const fp = narrowedImportMatches[0];
                const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
                if (dstQualifiedKey === null)
                    continue; // ambiguous — do not emit bad nodeId
                resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.9 });
                continue;
            }
            // Tier 2.5: transitive import-scoped (confidence 0.8) — one re-export hop away
            const transitiveMatches = [];
            for (const fp of transitiveFilePaths) {
                if (fileHasSymbol.get(fp)?.has(dstName))
                    transitiveMatches.push(fp);
            }
            const narrowedTransitiveMatches = narrowCCandidates(transitiveMatches, srcFilePath, srcLanguage, srcName, dstName);
            if (narrowedTransitiveMatches.length === 1) {
                const fp = narrowedTransitiveMatches[0];
                const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
                if (dstQualifiedKey === null)
                    continue;
                resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.8 });
                continue;
            }
            // Tier 3: global fallback (confidence 0.5) — uses inverted symbol index
            // instead of scanning all files.
            stats.globalFallbacks++;
            const candidates = symbolToFiles.get(dstName) ?? [];
            let globalMatches = candidates.filter(fp => fp !== srcFilePath && fileLanguage.get(fp) === srcLanguage);
            const importHint = pickCallerAlignedCandidate(importMatches, srcName, dstName)?.chosen
                ?? pickCallerAlignedCandidate(transitiveMatches, srcName, dstName)?.chosen;
            if (importHint) {
                const hintedStem = candidateStem(importHint);
                const stemMatches = globalMatches.filter(fp => candidateStem(fp) === hintedStem);
                if (stemMatches.length > 0)
                    globalMatches = stemMatches;
            }
            stats.globalCandidateTotal += globalMatches.length;
            const resolvedMatches = narrowCCandidates(globalMatches, srcFilePath, srcLanguage, srcName, dstName);
            if (resolvedMatches.length === 1) {
                const fp = resolvedMatches[0];
                const dstQualifiedKey = bestQKey(fileQKeys, fp, dstName);
                if (dstQualifiedKey === null)
                    continue; // ambiguous — do not emit bad nodeId
                resolved.push({ srcFilePath, srcName, dstFilePath: fp, dstName, dstQualifiedKey, predicate: rel.predicate, confidence: 0.5 });
                stats.resolvedGlobal++;
                continue;
            }
            if (narrowedImportMatches.length > 1 || narrowedTransitiveMatches.length > 1 || resolvedMatches.length > 1) {
                stats.skippedAmbiguous++;
            }
            // 0 or >1 matches after all tiers — leave as dangling edge, do not emit
        }
    }
    return resolved;
}
/** @deprecated Use resolveEdges instead. */
export function resolveCallEdges(results) {
    return resolveEdges(results).map(e => ({
        callerFilePath: e.srcFilePath,
        callerName: e.srcName,
        calleeFilePath: e.dstFilePath,
        calleeName: e.dstName,
        calleeQualifiedKey: e.dstQualifiedKey,
        confidence: e.confidence,
    }));
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function findEnclosing(ranges, line, excludeName) {
    // Find the innermost class/interface that contains this line
    let best = null;
    for (const r of ranges) {
        if (r.name === excludeName)
            continue;
        if (line >= r.start && line <= r.end) {
            if (!best || (r.end - r.start) < (best.end - best.start)) {
                best = r;
            }
        }
    }
    return best?.name ?? null;
}
function findEnclosingFunction(entities, line) {
    let best = null;
    for (const e of entities) {
        if (e.kind !== 'function' && e.kind !== 'method')
            continue;
        if (line >= e.lineStart && line <= e.lineEnd) {
            if (!best || (e.lineEnd - e.lineStart) < (best.lineEnd - best.lineStart)) {
                best = e;
            }
        }
    }
    return best ? (best.container ? `${best.container}.${best.name}` : best.name) : null;
}
