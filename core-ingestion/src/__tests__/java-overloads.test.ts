// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';
import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult } from '../index.js';
import { buildPatchWithResolution } from '../patch-builder.js';

const overSource = `package demo;

public class Over {
    public String handle(String text) {
        return First.one(text);
    }

    public String handle(Integer number) {
        return Second.two(number);
    }

    public String handle(String text, Integer number) {
        return Third.three(text, number);
    }
}
`;

function fixture() {
  return [
    parseFile('demo/Over.java', overSource)!,
    ...['First.one', 'Second.two', 'Third.three'].map((target, i) => {
      const [owner, method] = target.split('.');
      const parameters = ['String text', 'Integer number', 'String text, Integer number'][i];
      return parseFile(`demo/${owner}.java`, `package demo; public class ${owner} { public static String ${method}(${parameters}) { return ""; } }`)!;
    }),
  ];
}

describe('Java overload identity (#1139)', () => {
  it('writes each overload with its own range, containment, chunk and outgoing calls', () => {
    const results = fixture();
    const resolved = resolveEdges(results);
    const patches = results.map(r => buildPatchWithResolution(r, 'hash', 'ws', resolved));
    const nodes = patches.flatMap(p => p.ops).filter(op => op.type === 'UpsertNode');
    const edges = patches.flatMap(p => p.ops).filter(op => op.type === 'UpsertEdge');
    const handles = nodes.filter(n => n.kind === 'method' && n.name === 'handle');
    expect(handles.map(n => [n.attrs.line_start, n.attrs.line_end])).toEqual([[4, 6], [8, 10], [12, 14]]);
    expect(new Set(handles.map(n => n.id)).size).toBe(3);
    const owner = nodes.find(n => n.kind === 'class' && n.name === 'Over')!;
    handles.forEach((handle, i) => {
      expect(edges.filter(e => e.predicate === 'CONTAINS' && e.src === owner.id && e.dst === handle.id)).toHaveLength(1);
      const defining = edges.filter(e => e.predicate === 'DEFINES' && e.dst === handle.id);
      expect(defining).toHaveLength(1);
      expect(nodes.find(n => n.id === defining[0].src)!.attrs.start_line).toBe(handle.attrs.line_start);
      const calls = edges.filter(e => e.predicate === 'CALLS' && e.src === handle.id);
      expect(calls).toHaveLength(1);
      expect(nodes.find(n => n.id === calls[0].dst)!.name).toBe(['one', 'two', 'three'][i]);
    });
  });

  it('keeps resolution identical when overloads are only present in stored summaries', () => {
    const results = fixture();
    const summaries = new Map(results.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], summaries);
    expect(resolveEdges([results[0]], undefined, index)).toEqual(resolveEdges(results));
  });

  it('distinguishes calls to different overloads, including several calls from one method', () => {
    const results = fixture();
    const user = parseFile('demo/User.java', `package demo;
public class User {
  String useText(Over over) { return over.handle("a"); }
  String useNumber(Over over) { return over.handle(1); }
  void useBoth(Over over) { over.handle("a"); over.handle(1); }
}`)!;
    results.push(user);
    const resolved = resolveEdges(results);
    const calls = resolved.filter(e => e.predicate === 'CALLS' && e.dstFilePath === 'demo/Over.java');
    expect(calls.filter(e => e.srcName === 'User.useText').map(e => e.dstQualifiedKey)).toEqual(['Over.handle(String)']);
    expect(calls.filter(e => e.srcName === 'User.useNumber').map(e => e.dstQualifiedKey)).toEqual(['Over.handle(Integer)']);
    expect(calls.filter(e => e.srcName === 'User.useBoth').map(e => e.dstQualifiedKey).sort()).toEqual(['Over.handle(Integer)', 'Over.handle(String)']);
    const patch = buildPatchWithResolution(user, 'hash', 'ws', resolved);
    const overPatch = buildPatchWithResolution(results[0], 'hash', 'ws', resolved);
    const handles = overPatch.ops.filter(op => op.type === 'UpsertNode' && op.name === 'handle');
    const edges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    expect(edges).toHaveLength(4);
    expect(edges.every(e => handles.some(n => n.id === e.dst))).toBe(true);
    const summaries = new Map(results.map(r => [r.filePath, summarizeParseResult(r)]));
    expect(resolveEdges([user], undefined, buildGlobalResolutionIndex([...summaries.keys()], summaries)))
      .toEqual(resolved.filter(e => e.srcFilePath === user.filePath));
  });

  it('uses stable type signatures for generics, arrays, varargs and constructors', () => {
    const source = `class Types {
  Types() {}
  Types(int count) {}
  void accept(java.util.Map<String, Integer> values) {}
  void accept(java.util.List<String> values) {}
  void array(String values[]) {}
  void array(String[][] values) {}
  void rest(String... values) {}
  void rest(int... values) {}
  void single(String value) {}
}`;
    const original = parseFile('Types.java', source)!;
    const reformatted = parseFile('Types.java', source.replaceAll('values', 'renamed')
      .replace('Map<String, Integer>', 'Map< String, /* type */ Integer >')
      .replace('String renamed[]', '@Deprecated final String renamed[]').replace('int count', 'final int total'))!;
    expect(original.hasParseErrors).toBeUndefined();
    expect(reformatted.hasParseErrors).toBeUndefined();
    const keys = summarizeParseResult(original).qkeys;
    expect(keys).toEqual(expect.arrayContaining([
      ['Types', 'Types.Types()'], ['Types', 'Types.Types(int)'],
      ['accept', 'Types.accept(java.util.Map<String,Integer>)'], ['accept', 'Types.accept(java.util.List<String>)'],
      ['array', 'Types.array(String[])'], ['array', 'Types.array(String[][])'],
      ['rest', 'Types.rest(String...)'], ['rest', 'Types.rest(int...)'], ['single', 'Types.single'],
    ]));
    expect(summarizeParseResult(reformatted).qkeys).toEqual(keys);
    const ids = (result: typeof original) => buildPatchWithResolution(result, 'hash', 'ws', [])
      .ops.filter(op => op.type === 'UpsertNode' && op.kind === 'method').map(op => op.id).sort();
    expect(ids(reformatted)).toEqual(ids(original));
  });

  it('resolves same-file calls without choosing an overload for unknown arguments', () => {
    const result = parseFile('Local.java', `class Local {
  void run(String value) {}
  void run(Integer value) {}
  void use() { run("a"); run(1); }
  void unknown() { run(valueFromElsewhere()); }
}`)!;
    const patch = buildPatchWithResolution(result, 'hash', 'ws', resolveEdges([result]));
    const nodes = patch.ops.filter(op => op.type === 'UpsertNode');
    const caller = nodes.find(n => n.name === 'use' && n.kind === 'method')!;
    const unknown = nodes.find(n => n.name === 'unknown' && n.kind === 'method')!;
    const calls = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    expect(calls.filter(e => e.src === caller.id)).toHaveLength(2);
    expect(calls.some(e => e.src === unknown.id)).toBe(false);
    expect(unknown.attrs.unresolved_calls).toContain('run');
  });

  it('does not guess between fixed arity and a competing varargs overload', () => {
    const result = parseFile('Varargs.java', `class Varargs {
  void run(Integer value) {}
  void run(String... values) {}
  void use() { run("a"); }
}`)!;
    const resolved = resolveEdges([result]);
    expect(resolved.filter(e => e.predicate === 'CALLS')).toEqual([]);
    const patch = buildPatchWithResolution(result, 'hash', 'ws', resolved);
    expect(patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toEqual([]);
  });
});
