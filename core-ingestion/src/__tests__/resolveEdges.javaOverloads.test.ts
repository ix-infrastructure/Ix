// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import {
  buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult,
  type FileParseResult, type FileSummary, type ResolvedEdge,
} from '../index.js';
import { selectJavaOverload } from '../java-overloads.js';
import { buildPatchWithResolution, symbolNodeId } from '../patch-builder.js';
import { changedNames, summarySignature } from '../symbol-index.js';

/**
 * Each Java overload is its own node (patchBuilder.javaOverloads.test.ts), but
 * a caller's name resolves to the one key the overloads share, so every caller
 * landed on the first overload and the others had none (#1139). A call site
 * now says how it passes its arguments, a file says which overloads each key
 * has, and once the name has resolved the two pick the overload. Whatever
 * they cannot decide stays on the first overload, with the edge id it had.
 */

const WS = 'workspace';
const DIR = 'src/main/java/demo';

type Op = { type: string; id?: string; name?: string; src?: string; dst?: string; predicate?: string; attrs?: Record<string, unknown> };

const parse = (name: string, source: string): FileParseResult => {
  const result = parseFile(`${DIR}/${name}.java`, `package demo;\n\n${source}`);
  expect(result).not.toBeNull();
  expect(result!.hasParseErrors).toBeUndefined();
  return result!;
};
const id = (file: string, key: string): string => symbolNodeId(WS, `${DIR}/${file}.java`, key);

function patchesOf(results: FileParseResult[], edges: ResolvedEdge[] = resolveEdges(results)): Map<string, Op[]> {
  return new Map(results.map(r => [r.filePath.slice(DIR.length + 1, -'.java'.length), buildPatchWithResolution(r, 'hash', WS, edges).ops as Op[]]));
}
const calls = (ops: Op[], src: string): Op[] =>
  ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS' && op.src === src);
/** Where the calls of `src` land outside its own file, or (`own`) inside it. */
const callDsts = (ops: Op[], src: string, own = false): string[] => {
  const here = new Set(ops.filter(op => op.type === 'UpsertNode').map(op => op.id));
  return calls(ops, src).map(op => op.dst!).filter(dst => here.has(dst) === own);
};

/** The same parse results as they were before call sites recorded their shapes. */
const withoutShapes = (results: FileParseResult[]): FileParseResult[] => results.map(r => {
  const { overloads: _overloads, ...rest } = r;
  return { ...rest, relationships: r.relationships.map(({ callShapes: _shapes, ...rel }) => rel) };
});

// The issue's reproduction.
const OVER = `public class Over {
    public String handle(String text) { return text; }
    public String handle(Integer number) { return "n"; }
    public String handle(String text, Integer number) { return text; }
    public String other() { return ""; }
}
`;
const USER = `public class User {
    public String useText(Over over) { return over.handle("a"); }
    public String useNumber(Over over) { return over.handle(1); }
}
`;
const HANDLE = ['Over.handle', 'Over.handle(Integer)', 'Over.handle(String,Integer)'];

describe('Java callers resolve to the overload they call (#1139)', () => {
  it('lands the issue\'s two callers on the two overloads, across files', () => {
    const results = [parse('Over', OVER), parse('User', USER)];
    expect(results[0].overloads).toEqual([['Over.handle', ['String', 'Integer', 'String,Integer']]]);
    const edges = resolveEdges(results).filter(e => e.predicate === 'CALLS');
    // The key is still the one the overloads share; the overload rides beside it.
    expect(edges.every(e => e.dstQualifiedKey === 'Over.handle')).toBe(true);
    expect(edges.filter(e => e.srcName === 'User.useText').every(e => e.dstIdentityKey === undefined)).toBe(true);
    expect(edges.filter(e => e.srcName === 'User.useNumber').every(e => e.dstIdentityKey === HANDLE[1])).toBe(true);
    // The typed relationship keeps its tier and confidence.
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'User.useNumber', dstName: 'Over.handle', tier: 'type', confidence: 0.95, dstIdentityKey: HANDLE[1],
    }));

    const user = patchesOf(results).get('User')!;
    expect(callDsts(user, id('User', 'User.useText'))).toEqual([id('Over', HANDLE[0])]);
    expect(callDsts(user, id('User', 'User.useNumber'))).toEqual([id('Over', HANDLE[1])]);
    expect(calls(user, id('User', 'User.useNumber'))[0].attrs).toEqual({ confidence: 0.95, tier: 'type' });
  });

  it('keeps the edge to the first overload, and its id, exactly as before', () => {
    const results = [parse('Over', OVER), parse('User', USER)];
    const now = calls(patchesOf(results).get('User')!, id('User', 'User.useText'));
    const before = calls(patchesOf(withoutShapes(results)).get('User')!, id('User', 'User.useText'));
    expect(now).toEqual(before);
    // The edge that moved to another overload has an id of its own.
    const moved = calls(patchesOf(results).get('User')!, id('User', 'User.useNumber'));
    const was = calls(patchesOf(withoutShapes(results)).get('User')!, id('User', 'User.useNumber'));
    expect(was.map(e => e.dst)).toEqual([id('Over', HANDLE[0])]);
    expect(moved[0].id).not.toBe(was[0].id);
  });

  it('picks by argument count alone when the types say nothing', () => {
    const results = [parse('Over', OVER), parse('User', `public class User {
    public String both(Over over, Object a, Object b) { return over.handle(unknown(a), unknown(b)); }
    Object unknown(Object o) { return o; }
}
`)];
    expect(results[1].relationships.find(r => r.dstName === 'Over.handle')?.callShapes).toEqual([{ argc: 2 }]);
    expect(callDsts(patchesOf(results).get('User')!, id('User', 'User.both'))).toEqual([id('Over', HANDLE[2])]);
  });

  it('falls back to the first overload, same edge id, when two overloads take that many unknown arguments', () => {
    const results = [parse('Over', OVER), parse('User', `public class User {
    public String one(Over over) { return over.handle(make()); }
    Object make() { return null; }
}
`)];
    const now = calls(patchesOf(results).get('User')!, id('User', 'User.one'));
    expect(callDsts(patchesOf(results).get('User')!, id('User', 'User.one'))).toEqual([id('Over', HANDLE[0])]);
    expect(now).toEqual(calls(patchesOf(withoutShapes(results)).get('User')!, id('User', 'User.one')));
    expect(resolveEdges(results)).toEqual(resolveEdges(withoutShapes(results)));
  });

  it('falls back to the first overload when no overload takes that many arguments', () => {
    const results = [parse('Over', OVER), parse('User', `public class User {
    public String none(Over over) { return over.handle(); }
}
`)];
    expect(callDsts(patchesOf(results).get('User')!, id('User', 'User.none'))).toEqual([id('Over', HANDLE[0])]);
  });

  it('writes one edge per overload when one method calls two', () => {
    const results = [parse('Over', OVER), parse('User', `public class User {
    public String both(Over over) { return over.handle("a") + over.handle(2) + over.handle("b"); }
}
`)];
    expect(results[1].relationships.find(r => r.dstName === 'Over.handle')?.callShapes).toEqual([
      { argc: 1, argTypes: ['String'] }, { argc: 1, argTypes: ['int'] },
    ]);
    const edges = calls(patchesOf(results).get('User')!, id('User', 'User.both'));
    expect(edges.map(e => e.dst)).toEqual([id('Over', HANDLE[0]), id('Over', HANDLE[1])]);
    expect(new Set(edges.map(e => e.id)).size).toBe(2);
    // The name and the receiver's type agree: no second edge to the first overload.
    expect(edges.map(e => e.attrs?.tier)).toEqual(['type', 'type']);
  });

  it('does not let the call\'s bare name add an edge to the first overload the typed call did not choose', () => {
    // `handle` resolves by name too (it is the only `handle` in the repo).
    const results = [parse('Over', OVER), parse('User', USER)];
    const edges = resolveEdges(results).filter(e => e.srcName === 'User.useNumber' && e.predicate === 'CALLS');
    expect(edges.map(e => [e.dstName, e.tier, e.dstIdentityKey])).toEqual([
      ['handle', 'global', HANDLE[1]], ['Over.handle', 'type', HANDLE[1]],
    ]);
  });

  it('picks the overload of a same-file call, bare or through this', () => {
    const results = [parse('Over', `public class Over {
    public String handle(String text) { return text; }
    public String handle(Integer number) { return "n"; }
    public String bare() { return handle(1); }
    public String viaThis() { return this.handle(2); }
    public String text() { return handle("a"); }
}
`)];
    expect(resolveEdges(results).filter(e => e.predicate === 'CALLS' && e.tier !== 'type')).toEqual([]);
    const over = patchesOf(results).get('Over')!;
    expect(callDsts(over, id('Over', 'Over.bare'), true)).toEqual([id('Over', 'Over.handle(Integer)')]);
    expect(callDsts(over, id('Over', 'Over.viaThis'), true)).toEqual([id('Over', 'Over.handle(Integer)')]);
    expect(calls(over, id('Over', 'Over.text'))).toEqual(calls(patchesOf(withoutShapes(results)).get('Over')!, id('Over', 'Over.text')));
    expect(callDsts(over, id('Over', 'Over.text'), true)).toEqual([id('Over', 'Over.handle')]);
  });

  it('carries both identities when the caller is itself a later overload', () => {
    const results = [parse('Over', OVER), parse('User', `public class User {
    public String use(Over over) { return over.handle("a"); }
    public String use(Over over, int n) { return over.handle(n); }
}
`)];
    const edges = resolveEdges(results).filter(e => e.dstName === 'Over.handle');
    expect(edges.map(e => [e.srcIdentityKey, e.dstIdentityKey])).toEqual([
      [undefined, undefined], ['User.use(Over,int)', HANDLE[1]],
    ]);
    const user = patchesOf(results).get('User')!;
    expect(callDsts(user, id('User', 'User.use'))).toEqual([id('Over', HANDLE[0])]);
    expect(callDsts(user, id('User', 'User.use(Over,int)'))).toEqual([id('Over', HANDLE[1])]);
  });

  it('reads the declared type of a local, a parameter and a field', () => {
    const results = [parse('Over', OVER), parse('User', `public class User {
    private Integer count;
    private final String label = "x";
    public String local(Over over) { int n = 1; return over.handle(n); }
    public String param(Over over, Integer n) { return over.handle(n); }
    public String field(Over over) { return over.handle(count); }
    public String thisField(Over over) { return over.handle(this.count); }
    public String text(Over over) { return over.handle(label); }
    public String pair(Over over, String s) { Integer n = 2; return over.handle(s, n); }
    public String shadowed(Over over, String count) { return over.handle(count); }
    public <T> String generic(Over over, T value) { return over.handle(value); }
    public String inferred(Over over) { var n = compute(); return over.handle(n); }
    Integer compute() { return 1; }
}
`)];
    const shapes = (src: string) => results[1].relationships.find(r => r.srcName === src && r.dstName === 'Over.handle')?.callShapes;
    expect(shapes('User.local')).toEqual([{ argc: 1, argTypes: ['int'] }]);
    expect(shapes('User.pair')).toEqual([{ argc: 2, argTypes: ['String', 'Integer'] }]);
    // A type parameter and an inferred `var` are not a known type.
    expect(shapes('User.generic')).toEqual([{ argc: 1 }]);
    expect(shapes('User.inferred')).toEqual([{ argc: 1 }]);
    const user = patchesOf(results).get('User')!;
    for (const method of ['local', 'param', 'field', 'thisField']) {
      expect(callDsts(user, id('User', `User.${method}`)), method).toEqual([id('Over', HANDLE[1])]);
    }
    for (const method of ['text', 'shadowed', 'generic', 'inferred']) {
      expect(callDsts(user, id('User', `User.${method}`)), method).toEqual([id('Over', HANDLE[0])]);
    }
    expect(callDsts(user, id('User', 'User.pair'))).toEqual([id('Over', HANDLE[2])]);
  });

  it('reads the type of a new expression and of a cast', () => {
    const results = [
      parse('Sink', `public class Sink {
    public void put(String text) {}
    public void put(StringBuilder builder) {}
    public void put(java.util.List<String> items) {}
    public void put(long number) {}
}
`),
      parse('User', `import java.util.ArrayList;
import java.util.List;

public class User {
    void fresh(Sink sink) { sink.put(new StringBuilder()); }
    void cast(Sink sink, Object o) { sink.put((List<String>) o); }
    void castPrimitive(Sink sink, Object o) { sink.put((long) o); }
    void subtype(Sink sink) { sink.put(new ArrayList<String>()); }
    void negative(Sink sink) { sink.put(-1L); }
}
`),
    ];
    const user = patchesOf(results).get('User')!;
    expect(callDsts(user, id('User', 'User.fresh'))).toEqual([id('Sink', 'Sink.put(StringBuilder)')]);
    // `List<String>` at the call, `java.util.List<String>` at the declaration.
    expect(callDsts(user, id('User', 'User.cast'))).toEqual([id('Sink', 'Sink.put(java.util.List)')]);
    expect(callDsts(user, id('User', 'User.castPrimitive'))).toEqual([id('Sink', 'Sink.put(long)')]);
    expect(callDsts(user, id('User', 'User.negative'))).toEqual([id('Sink', 'Sink.put(long)')]);
    // ArrayList is a List only through a hierarchy this does not read: not guessed.
    expect(callDsts(user, id('User', 'User.subtype'))).toEqual([id('Sink', 'Sink.put')]);
  });

  it('takes an Object parameter for any argument that fits nothing else', () => {
    const results = [
      parse('Sink', `public class Sink {
    public void put(String text) {}
    public void put(Object any) {}
    public void put(int number) {}
}
`),
      parse('User', `public class User {
    void thing(Sink sink) { sink.put(new User()); }
    void text(Sink sink) { sink.put("a"); }
    void number(Sink sink) { sink.put(3); }
    void boxed(Sink sink, Integer n) { sink.put(n); }
    void flag(Sink sink) { sink.put(true); }
}
`),
    ];
    const user = patchesOf(results).get('User')!;
    expect(callDsts(user, id('User', 'User.thing'))).toEqual([id('Sink', 'Sink.put(Object)')]);
    // An exact match beats Object; so does `int` for an int, without boxing.
    expect(callDsts(user, id('User', 'User.text'))).toEqual([id('Sink', 'Sink.put')]);
    expect(callDsts(user, id('User', 'User.number'))).toEqual([id('Sink', 'Sink.put(int)')]);
    // Integer to Object needs no unboxing, so it is tried before Integer to int.
    expect(callDsts(user, id('User', 'User.boxed'))).toEqual([id('Sink', 'Sink.put(Object)')]);
    expect(callDsts(user, id('User', 'User.flag'))).toEqual([id('Sink', 'Sink.put(Object)')]);
  });

  it('picks a varargs overload only when the fixed ones do not take the call', () => {
    const results = [
      parse('Log', `public class Log {
    public void info(String message) {}
    public void info(String message, Object... args) {}
    public void warn() {}
    public void warn(int... codes) {}
}
`),
      parse('User', `public class User {
    void one(Log log, String m) { log.info(m); }
    void many(Log log, String m) { log.info(m, 1, "x"); }
    void unknown(Log log) { log.info(text()); }
    void none(Log log) { log.warn(); }
    void codes(Log log) { log.warn(1, 2); }
    String text() { return ""; }
}
`),
    ];
    expect(results[0].overloads).toEqual([['Log.info', ['String', 'String,Object...']], ['Log.warn', ['', 'int...']]]);
    const user = patchesOf(results).get('User')!;
    expect(callDsts(user, id('User', 'User.one'))).toEqual([id('Log', 'Log.info')]);
    expect(callDsts(user, id('User', 'User.many'))).toEqual([id('Log', 'Log.info(String,Object...)')]);
    expect(callDsts(user, id('User', 'User.unknown'))).toEqual([id('Log', 'Log.info')]);
    expect(callDsts(user, id('User', 'User.none'))).toEqual([id('Log', 'Log.warn')]);
    expect(callDsts(user, id('User', 'User.codes'))).toEqual([id('Log', 'Log.warn(int...)')]);
  });

  it('leaves a new expression on the class node, whichever constructor it calls', () => {
    const results = [
      parse('Point', `public class Point {
    public Point() {}
    public Point(int x) {}
}
`),
      parse('User', `public class User {
    Point make() { return new Point(1); }
}
`),
    ];
    // Constructors are not in the table: the class's callers keep their edge.
    expect(results[0].overloads).toBeUndefined();
    expect(results[0].entities.filter(e => e.name === 'Point').map(e => e.identityKey)).toEqual([undefined, undefined, 'Point(int)']);
    expect(results[1].relationships.find(r => r.dstName === 'Point')?.callShapes).toBeUndefined();
    expect(callDsts(patchesOf(results).get('User')!, id('User', 'User.make'))).toEqual([id('Point', 'Point')]);
  });

  it('resolves against a summary from before overloads were recorded as it always did', () => {
    const over = parse('Over', OVER);
    const user = parse('User', USER);
    const { overloads: _overloads, ...old } = summarizeParseResult(over);
    const index = (summary: FileSummary) => buildGlobalResolutionIndex([over.filePath, user.filePath], new Map([[over.filePath, summary]]));
    const against = (summary: FileSummary) => resolveEdges([user], undefined, index(summary));
    expect(against(old as FileSummary)).toEqual(resolveEdges(withoutShapes([over, user])).filter(e => e.srcFilePath === user.filePath));
    expect(against(old as FileSummary).some(e => e.dstIdentityKey !== undefined)).toBe(false);
    // A table that is not a table (hand-edited, another version) is no table.
    for (const overloads of [null, 'x', [['Over.handle']], [['Over.handle', ['String']]], [[1, [2, 3]]]]) {
      expect(against({ ...old, overloads } as unknown as FileSummary)).toEqual(against(old as FileSummary));
      expect(() => summarySignature({ ...old, overloads } as unknown as FileSummary)).not.toThrow();
    }
    // The current summary, in the index only, resolves as the batch does.
    expect(against(summarizeParseResult(over))).toEqual(resolveEdges([over, user]).filter(e => e.srcFilePath === user.filePath));
  });

  it('re-resolves callers when an overload is added, and only then changes a signature', () => {
    const single = parse('Over', 'public class Over {\n    public String handle(String text) { return text; }\n}\n');
    const double = parse('Over', 'public class Over {\n    public String handle(String text) { return text; }\n    public String handle(Integer n) { return "n"; }\n}\n');
    const reordered = parse('Over', 'public class Over {\n    public String handle(Integer n) { return "n"; }\n    public String handle(String text) { return text; }\n}\n');
    expect(single.overloads).toBeUndefined();
    expect('overloads' in summarizeParseResult(single)).toBe(false);
    expect([...changedNames(summarizeParseResult(single), summarizeParseResult(double))].sort()).toEqual(['Over.handle', 'handle']);
    expect([...changedNames(summarizeParseResult(double), summarizeParseResult(reordered))].sort()).toEqual(['Over.handle', 'handle']);
    // A summary stored before this change for a file with overloads differs from
    // today's by exactly those names, so its callers are re-resolved once.
    const { overloads: _overloads, ...stored } = summarizeParseResult(double);
    const old = { ...stored, sig: summarySignature(stored) };
    expect([...changedNames(old, summarizeParseResult(double))].sort()).toEqual(['Over.handle', 'handle']);
  });

  it('changes nothing for methods without overloads, or for other languages', () => {
    const java = [
      parse('Plain', 'public class Plain {\n    public String run(String text) { return text; }\n    public String twice(String text) { return run(run(text)); }\n}\n'),
      parse('User', 'public class User {\n    String use(Plain plain) { return plain.run("a") + plain.run(null) + plain.twice("b"); }\n}\n'),
    ];
    expect(java.some(r => r.overloads !== undefined)).toBe(false);
    expect(resolveEdges(java)).toEqual(resolveEdges(withoutShapes(java)));
    expect([...patchesOf(java)]).toEqual([...patchesOf(withoutShapes(java))]);
    expect(java.map(summarizeParseResult)).toEqual(withoutShapes(java).map(summarizeParseResult));

    const others = [
      parseFile('src/over.ts', 'export class Over {\n  handle(a: string): string;\n  handle(a: number): string;\n  handle(a: unknown): string { return String(a); }\n}\nexport function use(o: Over) { return o.handle(1) + o.handle("a"); }\n')!,
      parseFile('src/Over.kt', 'class Over {\n  fun handle(a: String): String = a\n  fun handle(a: Int): String = "n"\n}\nfun use(o: Over): String = o.handle(1) + o.handle("a")\n')!,
      parseFile('src/Over.cs', 'class Over {\n  string Handle(string a) { return a; }\n  string Handle(int a) { return "n"; }\n  string Use() { return Handle(1) + Handle("a"); }\n}\n')!,
    ];
    for (const result of others) {
      expect(result, result?.filePath).not.toBeNull();
      expect(result.overloads).toBeUndefined();
      expect(result.relationships.some(r => r.callShapes !== undefined)).toBe(false);
    }
    expect(resolveEdges(others).some(e => e.srcIdentityKey !== undefined || e.dstIdentityKey !== undefined)).toBe(false);
  });
});

describe('selectJavaOverload', () => {
  const pick = (signatures: string[], argTypes: Array<string | null>): string =>
    signatures[selectJavaOverload(signatures, { argc: argTypes.length, ...(argTypes.some(t => t !== null) ? { argTypes } : {}) })];

  it('boxes only when nothing fits without, and widens to the nearest primitive', () => {
    expect(pick(['Integer', 'long'], ['int'])).toBe('long');
    expect(pick(['String', 'Integer'], ['int'])).toBe('Integer');
    expect(pick(['String', 'double', 'long'], ['int'])).toBe('long');
    expect(pick(['String', 'int'], ['Integer'])).toBe('int');
    expect(pick(['String', 'Long'], ['int'])).toBe('String'); // no overload takes it: first
    expect(pick(['String', 'Number'], ['int'])).toBe('Number');
    expect(pick(['String', 'int'], ['char'])).toBe('int');
    expect(pick(['String', 'char'], ['int'])).toBe('String');
  });

  it('compares a qualified name with a simple one', () => {
    expect(pick(['int', 'java.lang.String'], ['String'])).toBe('java.lang.String');
    expect(pick(['int', 'Entry'], ['Map.Entry'])).toBe('Entry');
    // Another package's Thing may or may not be this one: taken only when nothing else can be.
    expect(pick(['int', 'a.Thing', 'String'], ['b.Thing'])).toBe('a.Thing');
    expect(pick(['int', 'a.Thing', 'Object'], ['b.Thing'])).toBe('int');
  });

  it('never guesses between overloads that could both take the call', () => {
    // Dog may or may not be an Animal.
    expect(pick(['String', 'Animal', 'Object'], ['Dog'])).toBe('String');
    expect(pick(['String', 'Animal', 'Dog'], ['Dog'])).toBe('Dog');
    expect(pick(['String,int', 'Object,int', 'Object,String'], [null, 'int'])).toBe('String,int');
    expect(pick(['A', 'B'], [null])).toBe('A');
    // A parameter that may be a type parameter takes anything.
    expect(pick(['String', 'T'], ['int'])).toBe('T');
    expect(pick(['String', 'T', 'Integer'], ['int'])).toBe('String');
  });

  it('matches arrays and the varargs position', () => {
    expect(pick(['String', 'String[]'], ['String[]'])).toBe('String[]');
    expect(pick(['int', 'String...'], ['String[]'])).toBe('String...');
    expect(pick(['int', 'String...'], ['String', 'String'])).toBe('String...');
    expect(pick(['String,String', 'int...', 'long,long'], ['int', 'String'])).toBe('String,String'); // fits none: first
    expect(pick(['String,String', 'int...', 'long,long'], ['int', 'int'])).toBe('long,long');
    expect(pick(['String,String', 'String,Object...'], ['String', 'String'])).toBe('String,String');
  });
});
