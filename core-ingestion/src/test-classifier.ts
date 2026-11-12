// Copyright 2026 Ix Infrastructure Inc.

import type Parser from 'tree-sitter';
import type { ParsedEntity } from './index.js';

/** Mark runnable definitions; anonymous framework callbacks use the file node. */
export function markTestEntities(
  entities: ParsedEntity[], root: Parser.SyntaxNode, language: string, testFile: boolean, source: string,
): void {
  if (!['typescript', 'javascript', 'python', 'go', 'java', 'scala'].includes(language)) return;
  if ((language === 'python' || language === 'go') && !testFile) return;
  const js = language === 'typescript' || language === 'javascript';
  if (js && !testFile && !/\b(?:describe|it|test|suite)\b/.test(source)) return;
  const file = entities.find(e => e.kind === 'file');
  // No need to walk thousands of anonymous callbacks: they use the file node.
  if (testFile && js) {
    if (file) file.isTest = true;
    return;
  }
  if (language === 'python' || language === 'go') {
    for (const entity of entities) {
      const testName = language === 'python' ? /^test_/ : /^Test[^a-z]/;
      if ((entity.kind === 'function' || entity.kind === 'method') && testName.test(entity.name)) entity.isTest = true;
    }
    if (file) file.isTest = true;
    return;
  }
  let detected = testFile;
  const definitions = new Map(entities.filter(e => e.kind === 'function' || e.kind === 'method')
    .map(e => [`${e.name}:${e.lineStart}`, e]));
  const mark = (node: Parser.SyntaxNode): void => {
    detected = true;
    const name = node.childForFieldName('name')?.text;
    const entity = definitions.get(`${name}:${node.startPosition.row + 1}`);
    if (entity) entity.isTest = true;
  };
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const name = node.childForFieldName('name')?.text ?? '';
    if ((language === 'java' || language === 'scala')
      && /^(?:method_declaration|function_definition)$/.test(node.type)) {
      // Inspect declaration modifiers, never comments or strings in the body.
      const annotations = node.namedChildren.filter(n => /modifier|annotation/.test(n.type));
      if (annotations.some(n => /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(n.text))
        || (testFile && /^test[A-Z_]/.test(name))) mark(node);
    }
    if ((language === 'typescript' || language === 'javascript' || language === 'scala')
      && node.type === 'call_expression') {
      const fn = node.childForFieldName('function')?.text ?? '';
      const args = node.childForFieldName('arguments')?.namedChildren ?? [];
      if (/^(?:describe|it|test|suite)(?:\.(?:only|skip|todo|concurrent))?$/.test(fn)
        && args.some(n => /string/.test(n.type))
        && args.some(n => /function|lambda/.test(n.type))) detected = true;
    }
    stack.push(...node.namedChildren);
  }
  if (detected) {
    if (file) file.isTest = true;
  }
}
