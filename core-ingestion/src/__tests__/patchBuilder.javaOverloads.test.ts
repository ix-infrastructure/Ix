// Copyright 2026 Ix Infrastructure Inc.

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges, type FileParseResult } from '../index.js';
import { buildPatch, buildPatchWithResolution, symbolNodeId } from '../patch-builder.js';

/**
 * Java overloads share the qualified key `Container.name`, and a node id was
 * folded from that key alone, so a class's overloads were one node: the first
 * one's lines, holding the calls of all of them (#1139). Each overload with its
 * own parameter signature is now its own node. The first keeps the bare key, so
 * its id and the id of every method that is not overloaded are what they were.
 * Resolution still knows one key per name; which overload a caller's edge
 * lands on is decided from its call sites (resolveEdges.javaOverloads.test.ts).
 */

const WS = 'workspace';

type Op = {
  type: string; id?: string; kind?: string; name?: string; src?: string; dst?: string;
  predicate?: string; attrs?: Record<string, unknown>; entityId?: string; field?: string; value?: string;
};

const parse = (filePath: string, source: string): FileParseResult => {
  const result = parseFile(filePath, source);
  expect(result).not.toBeNull();
  expect(result!.hasParseErrors).toBeUndefined();
  return result!;
};

/** Patches of a repo resolved together, the way an ingest builds them. */
function patchesOf(results: FileParseResult[]): Map<string, Op[]> {
  const edges = resolveEdges(results);
  return new Map(results.map(r => [r.filePath, buildPatchWithResolution(r, 'hash', WS, edges).ops as Op[]]));
}

const symbols = (ops: Op[], name: string): Op[] =>
  ops.filter(op => op.type === 'UpsertNode' && op.name === name && op.kind !== 'chunk' && op.kind !== 'section');
const lines = (node: Op): [unknown, unknown] => [node.attrs?.line_start, node.attrs?.line_end];
const edgesFrom = (ops: Op[], src: string, predicate: string): Op[] =>
  ops.filter(op => op.type === 'UpsertEdge' && op.predicate === predicate && op.src === src);
const claims = (ops: Op[], entityId: string, predicate: string): string[] =>
  ops.filter(op => op.type === 'AssertClaim' && op.entityId === entityId && op.field?.startsWith(`${predicate}:`))
    .map(op => op.value!);
const identityKeys = (result: FileParseResult, name: string): Array<string | undefined> =>
  result.entities.filter(e => e.name === name).map(e => e.identityKey);

// The files of the issue's reproduction.
const OVER = `package demo;

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

    public String other() {
        return First.one("x");
    }
}
`;
const callee = (cls: string, method: string, params: string) =>
  `package demo;\n\npublic class ${cls} {\n    public static String ${method}(${params}) {\n        return "";\n    }\n}\n`;
const USER = `package demo;

public class User {
    public String useText(Over over) {
        return over.handle("a");
    }

    public String useNumber(Over over) {
        return over.handle(1);
    }
}
`;
const OVER_PATH = 'src/main/java/demo/Over.java';
const demoRepo = (): FileParseResult[] => [
  parse(OVER_PATH, OVER),
  parse('src/main/java/demo/First.java', callee('First', 'one', 'String text')),
  parse('src/main/java/demo/Second.java', callee('Second', 'two', 'Integer number')),
  parse('src/main/java/demo/Third.java', callee('Third', 'three', 'String text, Integer number')),
  parse('src/main/java/demo/User.java', USER),
];

describe('Java overloads: one node each (#1139)', () => {
  const results = demoRepo();
  const patches = patchesOf(results);
  const over = patches.get(OVER_PATH)!;
  const handles = symbols(over, 'handle');
  const id = (file: string, key: string) => symbolNodeId(WS, `src/main/java/demo/${file}.java`, key);

  it('writes a method node per overload, with that overload\'s own lines', () => {
    expect(handles.map(lines)).toEqual([[4, 6], [8, 10], [12, 14]]);
    expect(handles.every(n => n.kind === 'method')).toBe(true);
    expect(new Set(handles.map(n => n.id)).size).toBe(3);
  });

  it('keeps the first overload on the bare key and gives later ones a signature key', () => {
    expect(identityKeys(results[0], 'handle')).toEqual([undefined, 'Over.handle(Integer)', 'Over.handle(String,Integer)']);
    expect(handles.map(n => n.id)).toEqual([
      id('Over', 'Over.handle'),
      id('Over', 'Over.handle(Integer)'),
      id('Over', 'Over.handle(String,Integer)'),
    ]);
    // Identity never involves a line number.
    for (const key of identityKeys(results[0], 'handle')) if (key) expect(key).not.toMatch(/\d/);
  });

  it('leaves the id of a method that is not overloaded, and of the class, as it was', () => {
    expect(identityKeys(results[0], 'other')).toEqual([undefined]);
    expect(symbols(over, 'other').map(n => n.id)).toEqual([id('Over', 'Over.other')]);
    expect(symbols(over, 'Over').map(n => n.id)).toEqual([id('Over', 'Over')]);
    // No relationship outside an overload carries an identity key.
    for (const r of results.flatMap(file => file.relationships)) {
      if (r.srcIdentityKey) expect(r.srcName).toBe('Over.handle');
      if (r.dstIdentityKey) expect([r.srcName, r.dstName]).toEqual(['Over', 'handle']);
    }
  });

  it('contains each overload from the class with its own CONTAINS edge', () => {
    const contained = edgesFrom(over, id('Over', 'Over'), 'CONTAINS');
    expect(contained.map(e => e.dst)).toEqual([...handles.map(n => n.id), id('Over', 'Over.other')]);
    expect(new Set(contained.map(e => e.id)).size).toBe(4);
  });

  it('points each overload\'s chunk at that overload', () => {
    const chunks = over.filter(op => op.type === 'UpsertNode' && op.kind === 'chunk' && op.name === 'handle');
    expect(chunks.map(c => c.attrs?.start_line)).toEqual([4, 8, 12]);
    const defined = chunks.map(c => edgesFrom(over, c.id!, 'DEFINES').map(e => e.dst));
    expect(defined).toEqual(handles.map(n => [n.id]));
  });

  it('attaches each CALLS edge to the overload that makes the call', () => {
    const calls = handles.map(n => edgesFrom(over, n.id!, 'CALLS').map(e => e.dst));
    expect(calls).toEqual([
      [id('First', 'First.one')],
      [id('Second', 'Second.two')],
      [id('Third', 'Third.three')],
    ]);
  });

  it('attaches each call claim to the overload that makes the call', () => {
    // A claim's value is the callee as the call's own relationship names it.
    expect(handles.map(n => claims(over, n.id!, 'calls'))).toEqual([['one'], ['two'], ['three']]);
  });

  it('still resolves every cross-file caller to the one key, and lands it on the overload it calls', () => {
    const edges = resolveEdges(results).filter(e => e.dstFilePath === OVER_PATH && e.predicate === 'CALLS');
    // Each call resolves by its name and by its receiver's type, to the same key.
    expect([...new Set(edges.map(e => `${e.srcName} -> ${e.dstQualifiedKey}`))].sort()).toEqual([
      'User.useNumber -> Over.handle',
      'User.useText -> Over.handle',
    ]);
    // Which overload is the call site's to say (resolveEdges.javaOverloads.test.ts).
    const user = patches.get('src/main/java/demo/User.java')!;
    expect(edgesFrom(user, id('User', 'User.useText'), 'CALLS').map(e => e.dst)).toEqual([handles[0].id]);
    expect(edgesFrom(user, id('User', 'User.useNumber'), 'CALLS').map(e => e.dst)).toEqual([handles[1].id]);
  });

  it('resolves exactly what it resolved when the overloads were one node', () => {
    // Resolution reads names and qualified keys only: the same relationships
    // with the identity fields removed resolve to the same edges.
    const stripped = results.map(r => ({
      ...r,
      entities: r.entities.map(({ identityKey: _i, ...e }) => e),
      chunks: r.chunks.map(({ identityKey: _i, ...c }) => c),
      relationships: r.relationships.map(({ srcIdentityKey: _s, dstIdentityKey: _d, ...rel }) => rel),
    }));
    expect(resolveEdges(results)).toEqual(resolveEdges(stripped));
  });
});

describe('Java overloads: the relation is written on the nodes', () => {
  const over = buildPatch(parse(OVER_PATH, OVER), 'hash', WS).ops as Op[];
  const handles = symbols(over, 'handle');
  const overloadAttrs = (node: Op) => [node.attrs?.overload_of, node.attrs?.overload_signature];
  const marked = (ops: Op[]) => ops.filter(op =>
    op.type === 'UpsertNode' && ('overload_of' in op.attrs! || 'overload_signature' in op.attrs!));

  it('points each later overload at the first one\'s node and gives it its signature', () => {
    const first = symbolNodeId(WS, OVER_PATH, 'Over.handle');
    expect(handles[0].id).toBe(first);
    expect(handles.slice(1).map(overloadAttrs)).toEqual([[first, 'Integer'], [first, 'String,Integer']]);
  });

  it('gives the first overload its signature and no overload_of', () => {
    expect(overloadAttrs(handles[0])).toEqual([undefined, 'String']);
    expect('overload_of' in handles[0].attrs!).toBe(false);
  });

  it('writes neither attribute anywhere else', () => {
    expect(marked(over).map(n => n.name)).toEqual(['handle', 'handle', 'handle']);
    // The attrs of a method that is not overloaded are the keys they always were.
    expect(Object.keys(symbols(over, 'other')[0].attrs!)).toEqual(
      ['line_start', 'line_end', 'language', 'role', 'role_source', 'unresolved_calls', 'unresolved_call_count']);
    expect(Object.keys(handles[1].attrs!).slice(0, 7)).toEqual(
      ['line_start', 'line_end', 'language', 'role', 'role_source', 'overload_of', 'overload_signature']);
  });

  it('writes an empty signature for no parameters', () => {
    const ops = buildPatch(parse('demo/Run.java',
      'package demo;\n\nclass Run {\n    void go(int a) {}\n\n    void go() {}\n}\n'), 'hash', WS).ops as Op[];
    expect(symbols(ops, 'go').map(overloadAttrs)).toEqual([
      [undefined, 'int'],
      [symbolNodeId(WS, 'demo/Run.java', 'Run.go'), ''],
    ]);
  });

  it('points a later constructor at the class node, which holds the first one', () => {
    const ops = buildPatch(parse('demo/Point.java',
      'package demo;\n\npublic class Point {\n    public Point() {}\n\n    public Point(int x) {}\n}\n'), 'hash', WS).ops as Op[];
    const classNode = symbols(ops, 'Point').find(n => n.kind === 'class')!;
    const later = symbols(ops, 'Point').filter(n => n.kind === 'method');
    expect(later.map(overloadAttrs)).toEqual([[classNode.id, 'int']]);
    // A class is not an overload: it says nothing of the first constructor's parameters.
    expect(marked(ops)).toEqual(later);
  });

  it('marks nothing when declarations of one signature stay one node', () => {
    const ops = buildPatch(parse('demo/Twice.java',
      'package demo;\n\nclass Twice {\n    Runnable a = new Runnable() { public void run() {} };\n    Runnable b = new Runnable() { public void run() {} };\n}\n'), 'hash', WS).ops as Op[];
    expect(marked(ops)).toEqual([]);
  });

  it('always points at a node the same patch writes', () => {
    const written = new Set(over.filter(op => op.type === 'UpsertNode').map(op => op.id));
    for (const node of marked(over)) if (node.attrs!.overload_of) expect(written.has(node.attrs!.overload_of as string)).toBe(true);
  });
});

describe('Java overloads: calls and unresolved calls per overload', () => {
  const source = `package demo;

public class Calls {
    public void run(Alpha a) {
        Helper.shared();
        mystery();
        onlyFirst();
    }

    public void run(Beta a) {
        Helper.shared();
        Helper.shared();
        mystery();
        onlySecond();
    }

    public void run(Alpha a, Beta b) {
        run(a);
    }
}
`;
  const helper = 'package demo;\n\npublic class Helper {\n    public static void shared() {}\n}\n';
  const results = [parse('demo/Calls.java', source), parse('demo/Helper.java', helper)];
  const ops = patchesOf(results).get('demo/Calls.java')!;
  const runs = symbols(ops, 'run');
  const shared = symbolNodeId(WS, 'demo/Helper.java', 'Helper.shared');

  it('gives two overloads that call the same callee an edge each', () => {
    expect(runs.map(lines)).toEqual([[4, 8], [10, 15], [17, 19]]);
    const toShared = ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS' && op.dst === shared);
    expect(toShared.map(e => e.src)).toEqual([runs[0].id, runs[1].id]);
    expect(new Set(toShared.map(e => e.id)).size).toBe(2);
  });

  it('still records a call once per overload, however often it is made there', () => {
    const calls = results[0].relationships.filter(r => r.predicate === 'CALLS' && r.dstName === 'shared');
    expect(calls.map(r => [r.srcName, r.srcIdentityKey])).toEqual([['Calls.run', undefined], ['Calls.run', 'Calls.run(Beta)']]);
  });

  it('attaches each overload\'s type references to it', () => {
    expect(runs.map(n => claims(ops, n.id!, 'references'))).toEqual([['Alpha'], ['Beta'], ['Alpha', 'Beta']]);
    const refs = results[0].relationships.filter(r => r.predicate === 'REFERENCES');
    expect(refs.map(r => [r.srcName, r.srcIdentityKey, r.dstName])).toEqual([
      ['Calls.run', undefined, 'Alpha'],
      ['Calls.run', 'Calls.run(Beta)', 'Beta'],
      ['Calls.run', 'Calls.run(Alpha,Beta)', 'Alpha'],
      ['Calls.run', 'Calls.run(Alpha,Beta)', 'Beta'],
    ]);
  });

  it('puts unresolved calls on the overload that makes them', () => {
    expect(runs.map(n => n.attrs?.unresolved_calls)).toEqual([
      ['mystery', 'onlyFirst'],
      ['mystery', 'onlySecond'],
      undefined,
    ]);
    expect(runs.map(n => n.attrs?.unresolved_call_count)).toEqual([2, 2, undefined]);
  });

  it('points a call from one overload to another at the first overload, not at itself', () => {
    expect(edgesFrom(ops, runs[2].id!, 'CALLS').map(e => e.dst)).toEqual([runs[0].id]);
    expect(edgesFrom(ops, runs[0].id!, 'CALLS').map(e => e.dst)).toEqual([shared]);
  });

  it('builds the same nodes for the file on its own', () => {
    const solo = buildPatch(results[0], 'hash', WS).ops as Op[];
    expect(symbols(solo, 'run').map(n => n.id)).toEqual(runs.map(n => n.id));
    expect(symbols(solo, 'run').map(n => n.attrs?.unresolved_calls)).toEqual([
      ['shared', 'mystery', 'onlyFirst'],
      ['shared', 'mystery', 'onlySecond'],
      undefined,
    ]);
    const edgeIds = solo.filter(op => op.type === 'UpsertEdge').map(op => op.id);
    expect(edgeIds).toHaveLength(new Set(edgeIds).size);
  });
});

describe('Java overloads: signatures', () => {
  it('erases generics, annotations and whitespace, and writes varargs as T...', () => {
    const result = parse('demo/Sig.java', `package demo;

import java.util.List;
import java.util.Map;

public class Sig<T> {
    void m() {}
    void m(@Nullable final java.util.Map<String, List<T>> a, String[] b, int c[], T... rest) {}
    void m(Map<String,
            List<T>> a) {}
    void m(List<String> a) {}
    void m(List<Integer> a) {}
    void m(String... rest) {}
    void m(String[] rest) {}
    void m(final @Ann(v = 1) int... y) {}
    void m(String @NonNull [] x, int y) {}
    void m(Sig<T> this, long z) {}
}
`);
    expect(identityKeys(result, 'm')).toEqual([
      undefined,
      'Sig.m(java.util.Map,String[],int[],T...)',
      'Sig.m(Map)',
      'Sig.m(List)',
      'Sig.m(List)',            // same erasure as the line above: one node
      'Sig.m(String...)',
      'Sig.m(String[])',
      'Sig.m(int...)',
      'Sig.m(String[],int)',
      'Sig.m(long)',            // the receiver parameter is not a parameter
    ]);
    const ops = buildPatch(result, 'hash', WS).ops as Op[];
    // Ten declarations, nine signatures.
    expect(symbols(ops, 'm')).toHaveLength(9);
  });

  it('gives overloaded constructors a node each', () => {
    const result = parse('demo/Point.java', `package demo;

public class Point {
    private final int x;

    public Point() {
        this(0);
    }

    public Point(int x) {
        this.x = x;
        Log.made(x);
    }

    public Point(int x, int y) {
        this(x + y);
        Log.sum(x, y);
    }
}
`);
    const ctors = result.entities.filter(e => e.name === 'Point' && e.kind === 'method');
    expect(ctors.map(e => [e.lineStart, e.lineEnd, e.identityKey])).toEqual([
      [6, 8, undefined],
      [10, 13, 'Point(int)'],
      [15, 18, 'Point(int,int)'],
    ]);
    const ops = buildPatch(result, 'hash', WS).ops as Op[];
    // A constructor has its class's key (it is named after the class, and has
    // no container), so the first one is the class node, as it always was.
    const classNode = symbols(ops, 'Point').find(n => n.kind === 'class')!;
    expect(classNode.id).toBe(symbolNodeId(WS, 'demo/Point.java', 'Point'));
    expect(lines(classNode)).toEqual([3, 19]);
    // The later ones are nodes of their own, contained by the class.
    const nodes = symbols(ops, 'Point').filter(n => n.kind === 'method');
    expect(nodes.map(lines)).toEqual([[10, 13], [15, 18]]);
    expect(nodes.map(n => n.id)).toEqual([
      symbolNodeId(WS, 'demo/Point.java', 'Point(int)'),
      symbolNodeId(WS, 'demo/Point.java', 'Point(int,int)'),
    ]);
    expect(nodes.map(n => n.attrs?.unresolved_calls)).toEqual([['made'], ['sum']]);
    expect(classNode.attrs?.unresolved_calls).toBeUndefined();
    expect(edgesFrom(ops, classNode.id!, 'CONTAINS').map(e => e.dst)).toEqual(nodes.map(n => n.id));
    const fileNode = ops.find(op => op.type === 'UpsertNode' && op.kind === 'file')!;
    expect(edgesFrom(ops, fileNode.id!, 'CONTAINS').map(e => e.dst)).toEqual([classNode.id]);
  });

  it('keys a nested class\'s later constructors under the enclosing class', () => {
    const result = parse('demo/Outer.java', `package demo;

public class Outer {
    static class Inner {
        Inner() {}
        Inner(int x) {}
    }
}
`);
    expect(identityKeys(result, 'Inner')).toEqual([undefined, undefined, 'Outer.Inner(int)']);
    const ops = buildPatch(result, 'hash', WS).ops as Op[];
    const inner = symbolNodeId(WS, 'demo/Outer.java', 'Outer.Inner');
    expect(edgesFrom(ops, inner, 'CONTAINS').map(e => e.dst)).toEqual([symbolNodeId(WS, 'demo/Outer.java', 'Outer.Inner(int)')]);
  });

  it('keeps declarations with the same signature as one node', () => {
    const result = parse('demo/Tasks.java', `package demo;

public class Tasks {
    Runnable first = new Runnable() {
        public void run() {
            Work.one();
        }
    };
    Runnable second = new Runnable() {
        public void run() {
            Work.two();
        }
    };
    void go(int a) {}
    void go(String a) {}
    void go(int b) {}
}
`);
    expect(identityKeys(result, 'run')).toEqual([undefined, undefined]);
    expect(identityKeys(result, 'go')).toEqual([undefined, 'Tasks.go(String)', undefined]);
    const ops = buildPatch(result, 'hash', WS).ops as Op[];
    // As before the change: one `run` node, the first one's lines, both calls.
    const run = symbols(ops, 'run');
    expect(run.map(lines)).toEqual([[5, 7]]);
    expect(run[0].attrs?.unresolved_calls).toEqual(['one', 'two']);
    expect(symbols(ops, 'go').map(lines)).toEqual([[14, 14], [15, 15]]);
  });

  it('keeps same-named methods of different classes on their own bare keys', () => {
    const result = parse('demo/Two.java', `package demo;

class A {
    void run(int a) {}
}

class B {
    void run(String a) {}
}
`);
    expect(identityKeys(result, 'run')).toEqual([undefined, undefined]);
    const ops = buildPatch(result, 'hash', WS).ops as Op[];
    expect(symbols(ops, 'run').map(n => n.id)).toEqual([
      symbolNodeId(WS, 'demo/Two.java', 'A.run'),
      symbolNodeId(WS, 'demo/Two.java', 'B.run'),
    ]);
  });
});

describe('Java overloads: typed-receiver bookkeeping', () => {
  const target = 'package p;\n\npublic class Target {\n    public void ping() {}\n}\n';
  const use = (second: string) => `package q;

import p.Target;

public class Use {
    public void ping() {}

    public void call(Target t) {
        t.ping();
    }

    public void call(Target t, int n) {
        ${second}
    }
}
`;
  const typedCalls = (second: string) => parse('/repo/q/Use.java', use(second)).receiverTypedCalls ?? [];

  it('counts a call as typed only when it is typed in every overload that makes it', () => {
    // `srcName` is shared by the overloads, so this list cannot tell them
    // apart: it says what it said when they were one scope.
    expect(typedCalls('t.ping();')).toContain('Use.call\0ping');
    expect(typedCalls('lib.Api.make().ping();')).not.toContain('Use.call\0ping');
    expect(typedCalls('n++;')).toContain('Use.call\0ping');
  });

  it('gives each overload the typed edge of its own call', () => {
    const results = [parse('/repo/p/Target.java', target), parse('/repo/q/Use.java', use('t.ping();'))];
    const ops = patchesOf(results).get('/repo/q/Use.java')!;
    const calls = symbols(ops, 'call');
    expect(calls).toHaveLength(2);
    const ping = symbolNodeId(WS, '/repo/p/Target.java', 'Target.ping');
    for (const node of calls) {
      const edges = edgesFrom(ops, node.id!, 'CALLS');
      expect(edges.map(e => [e.dst, e.attrs?.tier])).toEqual([[ping, 'type']]);
    }
  });

  it('keeps the first overload\'s typed relationship joined to its own call', () => {
    const result = parse('/repo/q/Use.java', use('t.ping();'));
    const calls = result.relationships.filter(r => r.predicate === 'CALLS');
    expect(calls.map(r => [r.srcIdentityKey, r.dstName, r.receiverType, r.receiverOnly])).toEqual([
      [undefined, 'ping', undefined, undefined],
      [undefined, 'Target.ping', 'Target', true],
      ['Use.call(Target,int)', 'ping', undefined, undefined],
      ['Use.call(Target,int)', 'Target.ping', 'Target', true],
    ]);
  });
});

describe('overloads in other languages are untouched', () => {
  const noIdentity = (result: FileParseResult) => {
    expect(result.entities.some(e => e.identityKey !== undefined)).toBe(false);
    expect(result.chunks.some(c => c.identityKey !== undefined)).toBe(false);
    expect(result.entities.some(e => e.overloadSignature !== undefined)).toBe(false);
    expect(result.relationships.some(r => r.srcIdentityKey !== undefined || r.dstIdentityKey !== undefined)).toBe(false);
  };

  it('Python @overload stays one node', () => {
    const result = parse('adapter.py', `from typing import overload

class Adapter:
    @overload
    def convert(self, value: int) -> int: ...

    @overload
    def convert(self, value: str) -> str: ...

    def convert(self, value):
        return helper(value)
`);
    noIdentity(result);
    expect(symbols(buildPatch(result, 'hash', WS).ops as Op[], 'convert')).toHaveLength(1);
  });

  it.each([
    ['Over.kt', 'class Over {\n  fun handle(a: String) = one(a)\n  fun handle(a: Int) = two(a)\n}\n'],
    ['Over.cs', 'class Over {\n  void Handle(string a) { One(a); }\n  void Handle(int a) { Two(a); }\n}\n'],
    ['Over.scala', 'class Over {\n  def handle(a: String) = one(a)\n  def handle(a: Int) = two(a)\n}\n'],
    ['Over.cpp', 'class Over {\n  void handle(int a) { one(a); }\n  void handle(char a) { two(a); }\n};\n'],
    ['over.ts', 'class Over {\n  handle(a: string): void;\n  handle(a: number): void;\n  handle(a: unknown): void { one(a); }\n}\n'],
  ])('%s carries no identity key', (file, source) => {
    const result = parseFile(file, source);
    expect(result).not.toBeNull();
    noIdentity(result!);
    for (const op of buildPatch(result!, 'hash', WS).ops as Op[]) {
      if (op.type !== 'UpsertNode') continue;
      expect(op.attrs).not.toHaveProperty('overload_of');
      expect(op.attrs).not.toHaveProperty('overload_signature');
    }
  });
});

describe('Java grammar: the parameter nodes the signature is read from', () => {
  const require = createRequire(import.meta.url);
  const Parser = require('tree-sitter');
  const parser = new Parser();
  parser.setLanguage(require('tree-sitter-java'));
  const tree = parser.parse(`class A<T> {
  A(int x) {}
  void m(@Nullable final Map<String, T> a, String[] b, int c[], T... rest) {}
  void r(A<T> this, final @Ann(v = 1) int... y) {}
}`);
  const find = (type: string, node: any = tree.rootNode, out: any[] = []): any[] => {
    if (node.type === type) out.push(node);
    for (const child of node.namedChildren) find(type, child, out);
    return out;
  };

  it('method and constructor declarations have a `parameters` field', () => {
    for (const type of ['method_declaration', 'constructor_declaration']) {
      const declarations = find(type);
      expect(declarations.length).toBeGreaterThan(0);
      for (const d of declarations) expect(d.childForFieldName('parameters')?.type).toBe('formal_parameters');
    }
  });

  it('formal_parameter has a `type` field without its modifiers, and `dimensions` for `int c[]`', () => {
    const params = find('formal_parameter');
    expect(params.map(p => p.childForFieldName('type')?.text)).toEqual(['int', 'Map<String, T>', 'String[]', 'int']);
    expect(params.map(p => p.childForFieldName('dimensions')?.text)).toEqual([undefined, undefined, undefined, '[]']);
  });

  it('spread_parameter is [modifiers] type ... variable_declarator, with no field names', () => {
    const spreads = find('spread_parameter');
    expect(spreads.map(s => s.namedChildren.map((c: any) => c.type))).toEqual([
      ['type_identifier', 'variable_declarator'],
      ['modifiers', 'integral_type', 'variable_declarator'],
    ]);
    expect(spreads.map(s => s.childForFieldName('type'))).toEqual([null, null]);
  });

  it('receiver_parameter is its own node type inside formal_parameters', () => {
    const receivers = find('receiver_parameter');
    expect(receivers.map(r => [r.parent.type, r.text])).toEqual([['formal_parameters', 'A<T> this']]);
  });
});
