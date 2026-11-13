// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { SupportedLanguages } from '../languages.js';
import {
  changedNames, definedNames, findDependents, importsChanged, summaryBindings, summarySignature,
  type FileSummary, type StoredFileSummary,
} from '../symbol-index.js';

/** A summary with only the given fields, as one read back from disk may be. */
const summary = (filePath: string, fields: StoredFileSummary): StoredFileSummary => ({ filePath, ...fields });
const entry = (s: StoredFileSummary) => ({ summary: s });
/** The summary with the signature `summarizeParseResult` would give it. */
const signed = (s: StoredFileSummary): StoredFileSummary => ({ ...s, sig: summarySignature(s) });

describe('summary signature and changed names (#961)', () => {
  // mulberry32: a fixed seed, so a failure reproduces.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /**
   * A random summary over small pools of names, so two draws often agree on a
   * field and a mutation often changes nothing. Covers every field the
   * signature reads, and fields it must ignore (refs, entityCount, tsModule,
   * importRaw, a plain import alias).
   */
  const generate = (rand: () => number): StoredFileSummary => {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const some = <T>(make: () => T, max = 3): T[] => Array.from({ length: Math.floor(rand() * (max + 1)) }, make);
    const maybe = <T>(make: () => T): T | undefined => (rand() < 0.5 ? make() : undefined);
    const names = ['A', 'B', 'Base.get', 'Mk.apply'];
    const s: FileSummary = {
      filePath: 'f.ts',
      language: pick([SupportedLanguages.Java, SupportedLanguages.Scala, SupportedLanguages.TypeScript]),
      entityCount: Math.floor(rand() * 4),
      qkeys: some((): [string, string] => [pick(names), pick(['A', 'p.A', 'B'])]),
      imports: some(() => ({ dstName: pick(['x', 'y', 'z']), ...(rand() < 0.5 ? { importRaw: pick(['./x', 'x']) } : {}) })),
      refs: some(() => pick(names)),
      sig: '',
    };
    const exports = some((): [string, string, string?] => rand() < 0.5 ? [pick(names), pick(['a', 'b'])] : [pick(names), pick(['a', 'b']), pick(['./x', './y'])]);
    if (exports.length || rand() < 0.2) s.exportPublicNames = exports;
    const php = some((): [string, string] => [pick(['App\\A', 'App\\B']), pick(['A', 'B'])], 2);
    if (php.length) s.phpTypes = php;
    const factories = some((): [string, string] => [pick(names), pick(['URL', 'URI'])], 2);
    if (factories.length) s.receiverFactories = factories;
    const heritage = some((): [string, string] => [pick(names), pick(['P', 'Q'])], 2);
    if (heritage.length) s.receiverHeritage = heritage;
    const pkg = maybe(() => pick(['com.a', 'com.b']));
    if (pkg) s.receiverPackage = pkg;
    const aliases = Object.fromEntries(some((): [string, string] => [pick(['export:ns', 'export:o', 'ns', 'go']), pick(['./a', './b'])], 2));
    if (Object.keys(aliases).length) s.importAliases = aliases;
    const globals = some(() => pick(['G', 'H']), 2);
    if (globals.length) s.tsGlobalTypes = globals;
    if (rand() < 0.3) s.tsModule = true;
    return s;
  };

  /** Copy `s`, redrawing a few of its fields from another random summary. */
  const mutate = (s: StoredFileSummary, rand: () => number): StoredFileSummary => {
    const other = generate(rand) as Record<string, unknown>;
    const out = { ...s } as Record<string, unknown>;
    const fields = ['language', 'entityCount', 'qkeys', 'imports', 'refs', 'exportPublicNames', 'phpTypes', 'receiverFactories',
      'receiverHeritage', 'receiverPackage', 'importAliases', 'tsGlobalTypes', 'tsModule'];
    for (const field of fields) {
      if (rand() < 0.15) {
        if (other[field] === undefined) delete out[field];
        else out[field] = other[field];
      }
    }
    return out as StoredFileSummary;
  };

  it('differ if and only if some name changed, over generated summaries', () => {
    const rand = rng(961);
    let same = 0;
    let differ = 0;
    for (let i = 0; i < 5000; i++) {
      const before = signed(generate(rand));
      const after = signed(rand() < 0.5 ? mutate(before, rand) : generate(rand));
      const names = changedNames(before, after);
      // Without the signature short-cut too: the bindings alone must agree.
      const unsigned = changedNames({ ...before, sig: undefined }, after);
      const sigDiffers = before.sig !== after.sig;
      expect({ i, sigDiffers, names: [...names] }).toEqual({ i, sigDiffers, names: sigDiffers ? [...names] : [] });
      expect(names.size > 0).toBe(sigDiffers);
      expect(unsigned.size > 0).toBe(sigDiffers);
      if (sigDiffers) differ++; else same++;
    }
    // The generator has to exercise both sides of the "if and only if".
    expect(same).toBeGreaterThan(100);
    expect(differ).toBeGreaterThan(100);
  });

  it('names something for every binding, so no signature change goes unreported', () => {
    const rand = rng(11);
    for (let i = 0; i < 1000; i++) {
      for (const names of summaryBindings(generate(rand)).values()) expect(names.length).toBeGreaterThan(0);
    }
  });

  it("ignores what other files cannot bind to: refs, entity count, a file's own import aliases", () => {
    const base = summary('m.ts', { qkeys: [['f', 'f']], refs: ['x'], entityCount: 2 });
    expect(summarySignature(base)).toBe(summarySignature({ ...base, refs: ['y'], entityCount: 3, importAliases: { ns: './c' } }));
  });

  it('names a renaming re-export whose source module moved', () => {
    const before = signed(summary('b.ts', { qkeys: [], exportPublicNames: [['foo', 'a', './x']] }));
    const after = signed(summary('b.ts', { qkeys: [], exportPublicNames: [['foo', 'a', './y']] }));
    expect(before.sig).not.toBe(after.sig);
    expect(changedNames(before, after)).toEqual(new Set(['foo']));
  });
});

describe('dependents (IN-11)', () => {
  it('propagates changed superclass bindings to transitive subclass callers', () => {
    const before = summary('mid.scala', { receiverHeritage: [['Mid', 'A']] });
    const after = summary('mid.scala', { receiverHeritage: [['Mid', 'B']] });
    const table = new Map([
      ['mid.scala', entry(after)],
      ['child.scala', entry(summary('child.scala', { receiverHeritage: [['Child', 'Mid']], refs: ['Mid'] }))],
      ['leaf.scala', entry(summary('leaf.scala', { receiverHeritage: [['Leaf', 'Child']], refs: ['Child'] }))],
      ['use.scala', entry(summary('use.scala', { refs: ['Leaf.run'] }))],
      ['unrelated.scala', entry(summary('unrelated.scala', { refs: ['Other.run'] }))],
    ]);
    expect(findDependents(table, changedNames(before, after), [], new Set(['mid.scala'])))
      .toEqual(['child.scala', 'leaf.scala', 'use.scala']);
  });

  it('propagates inheritance through excluded files and terminates on cycles', () => {
    const table = new Map([
      ['a.scala', entry(summary('a.scala', { receiverHeritage: [['A', 'B']], refs: ['B'] }))],
      ['b.scala', entry(summary('b.scala', { receiverHeritage: [['B', 'A']], refs: ['A'] }))],
      ['use.scala', entry(summary('use.scala', { refs: ['B.run'] }))],
    ]);
    const names = new Set(['A']);
    expect(findDependents(table, names, [], new Set(['a.scala', 'b.scala']))).toEqual(['use.scala']);
    expect(names).toEqual(new Set(['A']));
  });

  it.each(['receiverFactories', 'receiverHeritage'] as const)('invalidates dependents when %s changes', (field) => {
    const before = signed(summary('target', { [field]: [['Target', 'Base']] }));
    const after = signed(summary('target', { [field]: [['Target', 'Other']] }));
    expect(changedNames(before, after)).toEqual(new Set(['Target']));
  });

  it("invalidates a Java chained caller when a method's declared result changes, inherited or not", () => {
    // `i.getUrl().get()` where Invoker inherits getUrl from Base: the caller
    // names `getUrl`, never `Base.getUrl`.
    const java = SupportedLanguages.Java;
    const before = signed(summary('Base.java', { language: java, receiverFactories: [['Base.getUrl', 'URL']] }));
    const after = signed(summary('Base.java', { language: java, receiverFactories: [['Base.getUrl', 'URI']] }));
    expect(changedNames(before, after)).toEqual(new Set(['Base.getUrl', 'getUrl']));
    const table = new Map([
      ['Base.java', entry(after)],
      ['Use.java', entry(summary('Use.java', { language: java, refs: ['Invoker', 'Invoker.getUrl', 'Invoker.getUrl().get', 'get', 'getUrl'] }))],
      ['Other.java', entry(summary('Other.java', { language: java, refs: ['Other.run'] }))],
    ]);
    expect(findDependents(table, changedNames(before, after), [], new Set(['Base.java']))).toEqual(['Use.java']);
    // A changed class reaches callers chained through a method returning it.
    const holder = new Map([
      ['Invoker.java', entry(summary('Invoker.java', { language: java, receiverFactories: [['Invoker.getUrl', 'URL']] }))],
      ['Use.java', entry(summary('Use.java', { language: java, refs: ['getUrl', 'get'] }))],
    ]);
    expect(findDependents(holder, new Set(['URL']), [], new Set())).toEqual(['Use.java']);
    // Scala factories keep naming the factory only.
    const scala = signed(summary('Mk.scala', { language: SupportedLanguages.Scala, receiverFactories: [['Mk.apply', 'T']] }));
    expect(changedNames(scala, signed({ ...scala, receiverFactories: [['Mk.apply', 'U']] }))).toEqual(new Set(['Mk.apply']));
  });

  it("invalidates a subclass when only its file's imports pick a different superclass", () => {
    const before = signed(summary('child.scala', { receiverHeritage: [['Child', 'Parent']], imports: [{ dstName: 'p1.Parent' }] }));
    const after = signed(summary('child.scala', { receiverHeritage: [['Child', 'Parent']], imports: [{ dstName: 'p2.Parent' }] }));
    expect(changedNames(before, after)).toEqual(new Set(['Child']));
  });

  it('changes no names when the signature is the same, and the symmetric difference otherwise', () => {
    const before = summary('m.ts', { sig: 's1', qkeys: [['add', 'add'], ['sub', 'sub']] });
    expect(changedNames(before, summary('m.ts', { sig: 's1', qkeys: [['add', 'add'], ['sub', 'sub']] }))).toEqual(new Set());
    const after = summary('m.ts', { sig: 's2', qkeys: [['add', 'add'], ['minus', 'minus']], exportPublicNames: [['default', 'add']] });
    expect(changedNames(before, after)).toEqual(new Set(['sub', 'minus', 'default']));
    // Added or deleted: every name it defines.
    expect(changedNames(undefined, before)).toEqual(new Set(['add', 'sub']));
    expect(changedNames(before, undefined)).toEqual(new Set(['add', 'sub']));
    expect(definedNames(summary('p.php', { phpTypes: [['App\\Foo', 'Foo']] }))).toEqual(new Set(['App\\Foo', 'Foo']));
  });

  it("names a barrel's renamed or retargeted export * as ns, and a TypeScript global that came or went", () => {
    const barrel = summary('m/index.ts', { sig: 's1', importAliases: { 'export:ns': './a' } });
    expect(changedNames(barrel, { ...barrel, sig: 's2', importAliases: { 'export:ns': './b' } })).toEqual(new Set(['ns']));
    expect(changedNames(barrel, { ...barrel, sig: 's2', importAliases: { 'export:other': './a' } })).toEqual(new Set(['ns', 'other']));
    // A file's own namespace import is not something an importer binds to.
    expect(changedNames(barrel, { ...barrel, sig: 's2', importAliases: { 'export:ns': './a', ns: './c' } })).toEqual(new Set());
    const script = summary('base.ts', { sig: 's1', qkeys: [['Base', 'Base']], tsGlobalTypes: ['Base'] });
    expect(changedNames(script, { ...script, sig: 's2', tsGlobalTypes: undefined })).toEqual(new Set(['Base']));
    const table = new Map([
      ['use.ts', entry(summary('use.ts', { refs: ['ns.Base'] }))],
      ['other.ts', entry(summary('other.ts', { refs: ['Other'] }))],
    ]);
    expect(findDependents(table, new Set(['ns']), [], new Set())).toEqual(['use.ts']);
  });

  it('finds files that refer to a changed name, by whole name or by segment, or import a path that came or went', () => {
    const table = new Map([
      ['main.ts', entry(summary('main.ts', { refs: ['sub'], imports: [{ dstName: './math', importRaw: './math' }] }))],
      ['obj.ts', entry(summary('obj.ts', { refs: ['calc.sub'] }))],
      ['mod.py', entry(summary('mod.py', { refs: ['Mod::sub'] }))],
      ['other.ts', entry(summary('other.ts', { refs: ['mul'], imports: [{ dstName: './util' }] }))],
      ['uses-new.ts', entry(summary('uses-new.ts', { refs: [], imports: [{ dstName: './added', importRaw: './added' }] }))],
      ['math.ts', entry(summary('math.ts', { refs: ['sub'] }))],
    ]);
    expect(findDependents(table, new Set(['sub']), [], new Set(['math.ts']))).toEqual(['main.ts', 'mod.py', 'obj.ts']);
    expect(findDependents(table, new Set(), ['web/added.ts'], new Set())).toEqual(['uses-new.ts']);
    expect(findDependents(table, new Set(), ['pkg/util/index.ts'], new Set())).toEqual(['other.ts']);
    expect(findDependents(table, new Set(), [], new Set())).toEqual([]);
  });

  it('counts a name whose binding moved, and an import change, though no name came or went', () => {
    const was = summary('b.ts', { sig: 's1', exportPublicNames: [['foo', 'a']], imports: [{ dstName: 'x', importRaw: './x' }] });
    const now = summary('b.ts', { sig: 's2', exportPublicNames: [['foo', 'b']], imports: [{ dstName: 'y', importRaw: './y' }] });
    expect(changedNames(was, now)).toEqual(new Set(['foo']));
    expect(importsChanged(was, now)).toBe(true);
    expect(importsChanged(was, { ...was })).toBe(false);
    // An added or deleted file is a changed path already.
    expect(importsChanged(undefined, now)).toBe(false);
  });

  it('counts adding or dropping a Python import alias as an import change', () => {
    const plain = summary('m.py', { imports: [{ dstName: 'torch.nn', importRaw: 'torch.nn' }] });
    const aliased = summary('m.py', { imports: [{ dstName: 'torch.nn', importRaw: 'torch.nn', importAliased: true }] });
    expect(importsChanged(plain, aliased)).toBe(true);
    expect(importsChanged(aliased, plain)).toBe(true);
    expect(importsChanged(aliased, { ...aliased })).toBe(false);
  });

  it('matches an import by path segment, not by substring', () => {
    const table = new Map([
      ['uses-a.ts', entry(summary('uses-a.ts', { refs: [], imports: [{ dstName: 'a', importRaw: './a.js' }] }))],
      ['uses-data.ts', entry(summary('uses-data.ts', { refs: [], imports: [{ dstName: 'data', importRaw: './data' }] }))],
      ['uses-pkg-a.py', entry(summary('uses-pkg-a.py', { refs: [], imports: [{ dstName: 'pkg.a', importRaw: 'pkg.a' }] }))],
    ]);
    expect(findDependents(table, new Set(), ['web/a.ts'], new Set())).toEqual(['uses-a.ts', 'uses-pkg-a.py']);
  });

  it('re-resolves the Python files below a __init__.py that came or went, whatever they import', () => {
    const py = (filePath: string, imports: Array<{ dstName: string; importRaw?: string }>) =>
      entry(summary(filePath, { language: SupportedLanguages.Python, refs: [], imports }));
    const table = new Map([
      ['tools/main.py', py('tools/main.py', [{ dstName: 'helpers', importRaw: 'helpers' }])],
      ['tools/deep/run.py', py('tools/deep/run.py', [{ dstName: 'json', importRaw: 'json' }])],
      ['tools/plain.py', py('tools/plain.py', [])],
      ['tools/main.ts', entry(summary('tools/main.ts', { language: SupportedLanguages.TypeScript, refs: [], imports: [{ dstName: './x', importRaw: './x' }] }))],
      ['toolsx/main.py', py('toolsx/main.py', [{ dstName: 'helpers', importRaw: 'helpers' }])],
      ['top.py', py('top.py', [{ dstName: 'helpers', importRaw: 'helpers' }])],
    ]);
    expect(findDependents(table, new Set(), ['tools/__init__.py'], new Set(), ['tools/__init__.py']))
      .toEqual(['tools/deep/run.py', 'tools/main.py']);
    expect(findDependents(table, new Set(), [], new Set(['tools/main.py']), ['tools\\__init__.py'])).toEqual(['tools/deep/run.py']);
    // A root-level __init__.py covers every Python file with imports.
    expect(findDependents(table, new Set(), [], new Set(), ['__init__.py']))
      .toEqual(['tools/deep/run.py', 'tools/main.py', 'toolsx/main.py', 'top.py']);
    // Only an __init__.py counts, and only when passed as one that came or went.
    expect(findDependents(table, new Set(), [], new Set(), ['tools/helpers.py'])).toEqual([]);
    expect(findDependents(table, new Set(), ['tools/__init__.py'], new Set())).toEqual([]);
  });
});
