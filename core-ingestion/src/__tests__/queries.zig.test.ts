import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

// @tree-sitter-grammars/tree-sitter-zig has no win32/node26 prebuild; runs green
// in CI (Linux/node24) and is skipped locally when the grammar is absent.
const z = parseFile('/repo/m.zig', 'pub fn main() void {}\n');
const describeFn = z && z.language === SupportedLanguages.Zig ? describe : describe.skip;

describeFn('Zig queries', () => {
  it('detects language as Zig', () => {
    expect(parseFile('/repo/m.zig', 'const x = 1;\n')!.language).toBe(SupportedLanguages.Zig);
  });

  it('captures functions (incl. methods), structs and enums', () => {
    const result = parseFile('/repo/p.zig', `
pub fn add(a: i32, b: i32) i32 { return a + b; }
fn helper(x: i32) i32 { return x; }
const Point = struct {
    x: i32,
    pub fn dist(self: Point) i32 { return self.x; }
};
const Color = enum { red, green };
`);
    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(['add', 'helper', 'dist', 'Point', 'Color']));
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'Point', kind: 'class' }),
    );
  });

  it('emits CALLS for bare and field-access calls', () => {
    const result = parseFile('/repo/r.zig', `
pub fn main() void {
    _ = add(1, 2);
    std.debug.print("x", .{});
}
`);
    expect(result).not.toBeNull();
    const calls = result!.relationships
      .filter(r => r.predicate === 'CALLS')
      .map(r => r.dstName);
    expect(calls).toEqual(expect.arrayContaining(['add', 'print']));
  });

  it('emits IMPORTS for @import', () => {
    const result = parseFile('/repo/i.zig', `
const std = @import("std");
const mod = @import("./mod.zig");
`);
    expect(result).not.toBeNull();
    const raws = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.importRaw);
    expect(raws).toEqual(expect.arrayContaining(['std', './mod.zig']));
  });
});
