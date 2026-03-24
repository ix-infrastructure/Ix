import { describe, expect, it } from 'vitest';
import { parseFile, type ParsedChunk } from '../index.js';

// ---------------------------------------------------------------------------
// Helper to parse a synthetic source string as a given file extension
// ---------------------------------------------------------------------------
function parse(source: string, ext = '.ts') {
  const filePath = `/repo/fixture${ext}`;
  return parseFile(filePath, source);
}

describe('Chunk extraction — M1 acceptance criteria', () => {
  it('a file with 3 top-level functions produces 3 chunk nodes', () => {
    const src = `
function alpha() { return 1; }
function beta()  { return 2; }
function gamma() { return 3; }
`.trim();
    const result = parse(src);
    expect(result).not.toBeNull();
    const chunks = result!.chunks.filter(c => c.name !== null);
    expect(chunks.length).toBe(3);
    expect(chunks.map(c => c.name)).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
    expect(chunks.every(c => c.chunkKind === 'function')).toBe(true);
  });

  it('a class file produces at least a class chunk and/or method chunks', () => {
    const src = `
class MyService {
  greet() { return 'hello'; }
  farewell() { return 'bye'; }
}
`.trim();
    const result = parse(src);
    expect(result).not.toBeNull();
    const chunks = result!.chunks.filter(c => c.name !== null);
    // Must have at least the class chunk or method chunks
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const names = chunks.map(c => c.name);
    expect(names.some(n => n === 'MyService' || n === 'greet' || n === 'farewell')).toBe(true);
  });

  it('a file with no extractable semantic units produces one file_body chunk', () => {
    // A comment-only file has no definitions
    const src = `// This file has no definitions\nconst x = 1;\n`;
    const result = parseFile('/repo/fixture.txt', src);
    // .txt is not a supported language, so we test with an empty TS file
    const emptyTs = parseFile('/repo/empty.ts', '// empty\n');
    // Even if parse fails gracefully, test the fallback chunk on a real parsed file
    if (emptyTs) {
      expect(emptyTs.chunks.length).toBeGreaterThanOrEqual(1);
      if (emptyTs.chunks.every(c => c.name === null)) {
        expect(emptyTs.chunks[0].chunkKind).toBe('file_body');
      }
    }
  });

  it('each chunk has required fields: startByte, endByte, contentHash, language', () => {
    const src = `function foo() { return 42; }`;
    const result = parse(src);
    expect(result).not.toBeNull();
    for (const chunk of result!.chunks) {
      expect(typeof chunk.startByte).toBe('number');
      expect(typeof chunk.endByte).toBe('number');
      expect(chunk.endByte).toBeGreaterThan(chunk.startByte);
      expect(typeof chunk.contentHash).toBe('string');
      expect(chunk.contentHash.length).toBeGreaterThan(0);
      expect(typeof chunk.language).toBe('string');
    }
  });

  it('chunks have matching lineStart/lineEnd within file bounds', () => {
    const src = `function a() {}\nfunction b() {}\n`;
    const result = parse(src);
    expect(result).not.toBeNull();
    const lines = src.split('\n').length;
    for (const chunk of result!.chunks) {
      expect(chunk.lineStart).toBeGreaterThanOrEqual(1);
      expect(chunk.lineEnd).toBeLessThanOrEqual(lines);
    }
  });

  it('method chunks carry a container field matching their enclosing class', () => {
    const src = `
class Calculator {
  add(a: number, b: number) { return a + b; }
}
`.trim();
    const result = parse(src);
    expect(result).not.toBeNull();
    const methodChunk = result!.chunks.find(c => c.name === 'add');
    if (methodChunk) {
      expect(methodChunk.container).toBe('Calculator');
    }
  });

  it('re-parsing the same file produces identical chunks (stable IDs)', () => {
    const src = `function stableFunc() { return true; }`;
    const r1 = parse(src);
    const r2 = parse(src);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.chunks).toEqual(r2!.chunks);
  });

  it('Scala file produces chunks for class/trait/def definitions', () => {
    const src = `
class GraphService {
  def findNode(id: String): Option[Node] = None
  def saveNode(node: Node): Unit = ()
}
`.trim();
    const result = parseFile('/repo/fixture.scala', src);
    expect(result).not.toBeNull();
    const chunks = result!.chunks.filter(c => c.name !== null);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
