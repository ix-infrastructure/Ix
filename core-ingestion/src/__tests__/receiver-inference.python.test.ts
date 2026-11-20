// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';
import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult, type FileParseResult } from '../index.js';
import { buildPatch, buildPatchWithResolution } from '../patch-builder.js';

const parse = (path: string, source: string) => {
  const result = parseFile(`/repo/${path}`, source)!;
  expect(result).not.toBeNull();
  expect(result.hasParseErrors).toBeUndefined();
  return result;
};
/** `[caller, receiverType]` of each typed relationship. */
const typed = (result: FileParseResult) =>
  result.relationships.filter(r => r.receiverType).map(r => [r.srcName, r.receiverType]);
const typeEdges = (files: FileParseResult[]) => resolveEdges(files).filter(e => e.tier === 'type');
/** The same edges from stored summaries, resolving only `file`. */
const incremental = (files: FileParseResult[], file: FileParseResult) => {
  const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
  const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
  return resolveEdges([file], undefined, index);
};
const model = parse('src/pkg/model.py', `class Target:
    def run(self): pass
class Other:
    def run(self): pass
`);

describe('Python receiver inference', () => {
  it('adds a typed relationship and keeps the call\'s own relationships', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
def execute():
    local = Target()
    local.run()
    local.missing()
`);
    expect(typed(use)).toEqual([['execute', '.model.Target'], ['execute', '.model.Target']]);
    // Unchanged from before inference: bare and qualified names stay, untyped.
    const names = use.relationships.filter(r => r.predicate === 'CALLS').map(r => r.dstName);
    expect(names).toEqual(expect.arrayContaining(['Target', 'run', 'Target.run', 'missing', 'Target.missing']));
    expect(use.relationships.filter(r => r.receiverOnly)).toEqual([]);
    expect(typeEdges([model, use])).toEqual([expect.objectContaining({
      srcName: 'execute', dstFilePath: model.filePath, dstQualifiedKey: 'Target.run', confidence: 0.95,
    })]);
    // An unknown member keeps its name fallback and its diagnostics.
    const patch = buildPatchWithResolution(use, 'hash', 'workspace', resolveEdges([model, use]));
    expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'AssertClaim', field: 'calls:Target.missing' }));
  });

  it.each([
    ['exception alias', 'try:\n        pass\n    except Exception as local:\n        local.run()'],
    ['exception group alias', 'try:\n        pass\n    except* Exception as local:\n        local.run()'],
    ['capture', 'match value:\n        case local:\n            local.run()'],
    ['as capture', 'match value:\n        case _ as local:\n            local.run()'],
    ['sequence capture', 'match value:\n        case [local]:\n            local.run()'],
    ['sequence splat', 'match value:\n        case [*local]:\n            local.run()'],
    ['mapping capture', "match value:\n        case {'key': local}:\n            local.run()"],
    ['mapping splat', 'match value:\n        case {**local}:\n            local.run()'],
    ['keyword capture', 'match value:\n        case Other(field=local):\n            local.run()'],
    ['with alias', 'with unknown() as local:\n        local.run()'],
    ['with tuple alias', 'with unknown() as (local, other):\n        local.run()'],
    ['comprehension', '[local.run() for local in unknown()]'],
    ['tuple assignment', 'local, other = unknown()\n    local.run()'],
    ['starred assignment', '*local, other = unknown()\n    local.run()'],
    ['del', 'del local\n    local.run()'],
    ['conditional assignment', 'if flag:\n        local = unknown()\n    local.run()'],
    ['for target', 'for local in values:\n        pass\n    local.run()'],
  ])('drops a stale receiver after rebinding: %s', (_label, body) => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
def execute():
    local = Target()
    ${body}
`);
    expect(typed(use)).toEqual([]);
  });

  it.each([
    ['subscript', 'self.cache[k] = v'],
    ['tuple of fields', 'self.a, self.b = 1, 2'],
    ['del subscript', 'del self.d[k]'],
    ['subscript by self', 'x[self] = 1'],
    ['del attribute subscript', 'del _limbo[self]'],
    ['starred field', 'first, *self.rest = values'],
  ])('keeps self typed after a target that mentions it: %s', (_label, statement) => {
    const use = parse('src/pkg/use.py', `class C:
    def flush(self): pass
    def put(self, k, v, x, values):
        ${statement}
        self.flush()
`);
    expect(typed(use)).toEqual([['C.put', 'C']]);
  });

  it('does not let a tuple-assigned field keep an initializer type', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
class Service:
    def __init__(self):
        self.dep = Target()
    def reset(self):
        self.dep, self.other = None, None
    def execute(self):
        self.dep.run()
`);
    expect(typed(use).filter(([src]) => src === 'Service.execute')).toEqual([]);
  });

  it.each(['local()', 'Other(local=_)', 'local.VALUE', '{local.KEY: _}', '_'])('keeps a receiver through pattern references and wildcards: %s', pattern => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
def execute():
    local = Target()
    match value:
        case ${pattern}:
            pass
    local.run()
`);
    expect(typed(use)).toEqual([['execute', '.model.Target']]);
  });

  it('evaluates the first comprehension iterable in the enclosing scope', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
def execute():
    local = Target()
    [local.run() for local in local.run()]
`);
    expect(typed(use)).toEqual([['execute', '.model.Target']]);
  });

  it.each([
    'self.dep = Target()',
    'self.dep: Target = Target()',
    'self.dep: Target',
  ])('resolves an initializer field: %s', assignment => {
    const use = parse('src/pkg/use.py', `from .model import Target
class Service:
    def __init__(self):
        ${assignment}
    def execute(self):
        self.dep.run()
`);
    expect(typeEdges([model, use])).toContainEqual(expect.objectContaining({
      srcName: 'Service.execute', dstFilePath: model.filePath, dstQualifiedKey: 'Target.run', confidence: 0.95,
    }));
  });

  it('resolves class annotations, local constructors and inherited self calls, also from summaries', () => {
    const base = parse('src/pkg/base.py', 'class Base:\n    def inherited(self): pass\n');
    const use = parse('src/pkg/use.py', `from .model import Target as Item
from .base import Base
class Service(Base):
    dep: Item
    def execute(self):
        self.dep.run()
        self.inherited()
def execute():
    local = Item()
    local.run()
`);
    const files = [model, base, use];
    const edges = typeEdges(files);
    for (const [srcName, dstQualifiedKey] of [['Service.execute', 'Target.run'], ['Service.execute', 'Base.inherited'], ['execute', 'Target.run']]) {
      expect(edges).toContainEqual(expect.objectContaining({ srcName, dstQualifiedKey }));
    }
    expect(incremental(files, use)).toEqual(resolveEdges(files).filter(e => e.srcFilePath === use.filePath));
    expect(buildPatchWithResolution(use, 'hash', 'workspace', resolveEdges(files)).ops).toContainEqual(expect.objectContaining({
      type: 'UpsertEdge', predicate: 'CALLS', attrs: { confidence: 0.95, tier: 'type' },
    }));
  });

  it.each(['from pkg import model as m', 'import pkg.model as m', 'from . import model as m'])('types a constructor through a module import: %s', statement => {
    const use = parse('src/pkg/use.py', `${statement}
def execute():
    local = m.Target()
    local.run()
`);
    expect(typeEdges([model, use])).toEqual([expect.objectContaining({ dstFilePath: model.filePath, dstQualifiedKey: 'Target.run' })]);
  });

  it('types a constructor through a dotted module import', () => {
    const use = parse('src/app/use.py', 'import pkg.model\ndef execute():\n    local = pkg.model.Target()\n    local.run()\n');
    expect(typed(use)).toEqual([['execute', 'pkg.model.Target']]);
    expect(typeEdges([model, use])).toEqual([expect.objectContaining({ dstFilePath: model.filePath, dstQualifiedKey: 'Target.run' })]);
  });

  it.each(['..', '...'])('keeps every dot of a parent-relative type import: %s', dots => {
    const parent = parse('src/pkg/__init__.py', 'class Target:\n    def run(self): pass\n');
    const nearer = parse('src/pkg/nested/__init__.py', 'class Target:\n    def run(self): pass\n');
    const use = parse(`src/pkg/nested/${dots === '...' ? 'deeper/' : ''}use.py`, `from ${dots} import Target as Item
def execute():
    local = Item()
    local.run()
`);
    expect(typeEdges([parent, nearer, use])).toEqual([
      expect.objectContaining({ dstFilePath: parent.filePath, dstQualifiedKey: 'Target.run' }),
    ]);
  });

  it('resolves src packages from tests outside src', () => {
    const test = parse('tests/test_model.py', 'from pkg.model import Target\ndef execute():\n    local = Target()\n    local.run()\n');
    expect(typeEdges([model, test])).toEqual([expect.objectContaining({ dstFilePath: model.filePath, dstQualifiedKey: 'Target.run' })]);
  });

  it('does not expose function-local imports to siblings', () => {
    const use = parse('src/pkg/use.py', `def first():
    from .model import Target
    local = Target()
    local.run()
def second():
    local = Target()
    local.run()
`);
    expect(typed(use)).toEqual([['first', '.model.Target']]);
  });

  it('does not guess between imports of one name from different modules', () => {
    const use = parse('src/pkg/use.py', `def first():
    from .model import Target
    local = Target()
    local.run()
def second():
    from .other import Target
    local = Target()
    local.run()
`);
    expect(typed(use)).toEqual([]);
  });

  it('does not borrow a constructor hidden by a local or module reassignment', () => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
import pkg.model as module
module = unknown()
def execute():
    Target = Other()
    local = Target()
    local.run()
    other = module.Target()
    other.run()
`);
    expect(typed(use)).toEqual([]);
  });

  it('does not infer a field with conflicting writes or a fake self parameter', () => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
class Service:
    def __init__(self):
        self.dep = Target()
        self.dep = Other()
    def execute(self):
        self.dep.run()
    @staticmethod
    def fake(self):
        self.execute()
`);
    expect(typed(use)).toEqual([]);
  });

  it('does not type a keyword argument as a member of the call receiver', () => {
    const use = parse('src/pkg/use.py', `class C:
    def run(self): pass
    def go(self, cb): pass
    def execute(self):
        self.go(cb=run)
`);
    expect(typed(use)).toEqual([['C.execute', 'C']]);
    expect(use.relationships.filter(r => r.receiverType).map(r => r.dstName)).toEqual(['C.go']);
  });

  it('does not resolve a missing or ambiguous module by a coincidental symbol', () => {
    const missing = parse('src/pkg/use.py', 'from missing.model import Target\ndef execute():\n    local = Target()\n    local.run()\n');
    expect(typeEdges([model, missing])).toEqual([]);
    const first = parse('first/src/pkg/model.py', 'class Target:\n    def run(self): pass\n');
    const second = parse('second/src/pkg/model.py', 'class Target:\n    def run(self): pass\n');
    const test = parse('tests/test_model.py', 'from pkg.model import Target\ndef execute(item: Target):\n    item.run()\n');
    expect(typeEdges([first, second, test])).toEqual([]);
    expect(incremental([first, second, test], test).filter(e => e.tier === 'type')).toEqual([]);
  });

  it.each(['base.Base', 'base.Base[int]'])('resolves inherited typed calls through %s across batches', baseType => {
    const base = parse('src/pkg/base.py', 'class Base:\n    def run(self): pass\n');
    const child = parse('src/pkg/child.py', `from pkg import base
class Child(${baseType}): pass
`);
    const use = parse('src/app/service.py', `from pkg.child import Child
class Service:
    def execute(self, item: Child):
        item.run()
`);
    const decoy = parse('src/other/base.py', 'class Base:\n    def run(self): pass\n');
    const files = [base, child, use, decoy];
    expect(child.receiverHeritage).toEqual([['Child', 'pkg.base.Base']]);
    expect(typeEdges(files)).toEqual([expect.objectContaining({ srcFilePath: use.filePath, srcName: 'Service.execute',
      dstFilePath: base.filePath, dstQualifiedKey: 'Base.run' })]);
    // child.py is not in the batch: its stored heritage needs no import facts.
    expect(incremental(files, use).filter(e => e.tier === 'type')).toEqual([expect.objectContaining({ dstFilePath: base.filePath, dstQualifiedKey: 'Base.run' })]);
  });

  it('resolves through a superclass imported under an alias', () => {
    const base = parse('src/pkg/base.py', 'class Base:\n    def run(self): pass\n');
    const middle = parse('src/pkg/middle.py', 'from .base import Base as Parent\nclass Middle(Parent): pass\n');
    const use = parse('src/pkg/use.py', 'from .middle import Middle\nclass Service(Middle):\n    def execute(self):\n        self.run()\n');
    const files = [base, middle, use];
    expect(incremental(files, use).filter(e => e.tier === 'type')).toEqual([expect.objectContaining({ dstFilePath: base.filePath, dstQualifiedKey: 'Base.run' })]);
    const changed = summarizeParseResult(parse('src/pkg/middle.py', 'from .other import Base as Parent\nclass Middle(Parent): pass\n'));
    expect(changed.sig).not.toBe(summarizeParseResult(middle).sig);
  });

  it('resolves super().m() to the single base class, not the override', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
class Base:
    def save(self): pass
class Child(Base):
    def save(self):
        super().save()
class Named(Base):
    def save(self):
        super(Named, self).save()
class Imported(Target):
    def run(self):
        super().run()
class Two(Base, Target):
    def run(self):
        super().run()
`);
    expect(typed(use)).toEqual([['Child.save', 'Base'], ['Named.save', 'Base'], ['Imported.run', '.model.Target']]);
    expect(typeEdges([model, use]).map(e => [e.srcName, e.dstFilePath, e.dstQualifiedKey])).toEqual([
      ['Child.save', use.filePath, 'Base.save'],
      ['Named.save', use.filePath, 'Base.save'],
      ['Imported.run', model.filePath, 'Target.run'],
    ]);
  });

  it('types a class defined later in the module from a function body', () => {
    const use = parse('src/pkg/use.py', `def make():
    local = Later()
    local.run()
class Early:
    def build(self):
        return Later().run()
    def use(self):
        item = Later()
        item.run()
class Later:
    def run(self): pass
Twice = Later
def ambiguous():
    local = Twice()
    local.run()
Twice = None
`);
    expect(typed(use)).toEqual([['make', 'Later'], ['Early.use', 'Later']]);
    expect(typeEdges([use]).map(e => e.srcName)).toEqual(['make', 'Early.use']);
  });

  it('does not type a module name rebound to another class from a function body', () => {
    const use = parse('src/pkg/use.py', `class A:
    def run(self): pass
class B:
    def run(self): pass
x = A()
def use():
    x.run()
x = B()
x.run()
def annotated(item: x):
    item.run()
`);
    // Module-level `x.run()` runs after `x = B()`: positional typing holds there.
    expect(typed(use).filter(([src]) => src === 'use' || src === 'annotated')).toEqual([]);
    expect(typeEdges([use]).filter(e => e.srcName === 'use' || e.srcName === 'annotated')).toEqual([]);
    expect(use.relationships.filter(r => r.predicate === 'CALLS' && r.srcName === 'use').map(r => r.dstName)).toEqual(expect.arrayContaining(['run']));
  });

  it('keeps unknown receivers on their name-based relationships only', () => {
    const use = parse('src/pkg/use.py', 'class Service:\n    def run(self): pass\ndef execute(obj):\n    obj.run()\n');
    expect(typed(use)).toEqual([]);
    expect(use.relationships.filter(r => r.predicate === 'CALLS').map(r => r.dstName)).toEqual(expect.arrayContaining(['run', 'obj.run']));
  });
});
