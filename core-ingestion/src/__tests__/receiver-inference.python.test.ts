// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';
import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult } from '../index.js';
import { buildPatch, buildPatchWithResolution } from '../patch-builder.js';

const parse = (path: string, source: string) => {
  const result = parseFile(`/repo/${path}`, source)!;
  expect(result).not.toBeNull();
  expect(result.hasParseErrors).toBeUndefined();
  return result;
};
const model = parse('src/pkg/model.py', `class Target:
    def run(self): pass
class Other:
    def run(self): pass
`);

describe('Python receiver and package resolution', () => {
  it.each([
    ['exception alias', 'try:\n        pass\n    except Exception as local:\n        local.run()'],
    ['exception group alias', 'try:\n        pass\n    except* Exception as local:\n        local.run()'],
    ['capture', 'match value:\n        case local:\n            local.run()'],
    ['guard capture', 'match value:\n        case local if local.run():\n            local.run()'],
    ['as capture', 'match value:\n        case _ as local:\n            local.run()'],
    ['sequence capture', 'match value:\n        case [local]:\n            local.run()'],
    ['sequence splat', 'match value:\n        case [*local]:\n            local.run()'],
    ['tuple capture', 'match value:\n        case (_, local):\n            local.run()'],
    ['mapping capture', "match value:\n        case {'key': local}:\n            local.run()"],
    ['mapping splat', 'match value:\n        case {**local}:\n            local.run()'],
    ['nested class capture', 'match value:\n        case Other(field=Other(local)):\n            local.run()'],
    ['keyword capture', 'match value:\n        case Other(field=local):\n            local.run()'],
    ['alternative capture', 'match value:\n        case [local] | (local,):\n            local.run()'],
  ])('invalidates a stale receiver after binding: %s', (_label, body) => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
def execute():
    local = Target()
    ${body}
    local.run()
`);
    const edges = resolveEdges([model, use]);
    expect(edges.filter(e => e.predicate === 'CALLS' && e.dstQualifiedKey.endsWith('.run'))).toEqual([]);
    for (const patch of [buildPatch(use, 'hash', 'workspace'), buildPatchWithResolution(use, 'hash', 'workspace', edges)]) {
      expect(patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS' && op.attrs?.tier === 'type')).toEqual([]);
      expect(patch.ops).toContainEqual(expect.objectContaining({
        type: 'UpsertNode', attrs: expect.objectContaining({ unresolved_calls: expect.arrayContaining(['local.run']) }),
      }));
    }
    const summaries = new Map([model, use].map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([use], undefined, index)).toEqual(edges.filter(e => e.srcFilePath === use.filePath));
  });

  it.each([
    'try:\n        pass\n    except Exception as local:\n        local.run()',
    'match value:\n        case local:\n            local.run()',
  ])('preserves earlier calls and restores a receiver after reassignment: %s', body => {
    const use = parse('src/pkg/use.py', `from .model import Target
def execute():
    local = Target()
    local.run()
    ${body}
    local.run()
    local = Target()
    local.run()
`);
    const calls = resolveEdges([model, use]).filter(e => e.dstQualifiedKey === 'Target.run');
    const sites = use.relationships.filter(r => r.dstName === 'local.run').map(r => r.callSite);
    expect(calls.map(e => e.callSite)).toEqual([sites[0], sites.at(-1)]);
  });

  it.each([
    'try:\n        pass\n    except Exception as helper:\n        helper.run()',
    'match value:\n        case helper:\n            helper.run()',
  ])('invalidates a module import alias after binding: %s', body => {
    const helper = parse('src/pkg/helper.py', 'def run(): pass\n');
    const use = parse('src/pkg/use.py', `def execute():
    import pkg.helper as helper
    helper.run()
    ${body}
    helper.run()
`);
    const calls = resolveEdges([helper, use]).filter(e => e.predicate === 'CALLS');
    expect(calls).toEqual([expect.objectContaining({
      dstFilePath: helper.filePath, dstQualifiedKey: 'run', tier: 'binding',
      callSite: use.relationships.find(r => r.dstName === 'helper.run')!.callSite,
    })]);
  });

  it.each(['local()', 'Other(local=_)', 'local.VALUE', '{local.KEY: _}', '_', '[*_]'])('preserves pattern references and wildcards: %s', pattern => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
def execute():
    local = Target()
    local.run()
    match value:
        case ${pattern}:
            local.run()
    local.run()
`);
    expect(resolveEdges([model, use]).filter(e => e.dstQualifiedKey === 'Target.run')).toHaveLength(3);
  });

  it.each([
    'with unknown() as local:\n        local.run()',
    'with unknown() as (local, other):\n        local.run()',
    '[local.run() for local in unknown()]',
    '{local.run() for local in unknown()}',
    '{local: local.run() for local in unknown()}',
    '(local.run() for local in unknown())',
    '[local.run() for (local, other) in unknown()]',
  ])('shadows a receiver in binding constructs: %s', body => {
    const use = parse('src/pkg/use.py', `from .model import Target
def execute():
    local = Target()
    ${body}
`);
    expect(resolveEdges([model, use]).filter(e => e.dstQualifiedKey === 'Target.run')).toEqual([]);
  });

  it('keeps comprehension bindings separate from the enclosing receiver', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
def execute():
    local = Target()
    [local.run() for local in unknown()]
    local.run()
`);
    expect(resolveEdges([model, use]).filter(e => e.dstQualifiedKey === 'Target.run')).toHaveLength(1);
  });

  it('evaluates the first comprehension iterable in the enclosing scope', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
def execute():
    local = Target()
    [local.run() for local in local.run()]
`);
    const calls = resolveEdges([model, use]).filter(e => e.dstQualifiedKey === 'Target.run');
    expect(calls).toHaveLength(1);
    expect(calls[0].callSite).toBe(use.relationships.filter(r => r.dstName === 'local.run')[1].callSite);
  });

  it.each(['Target()', 'unknown()'])('retains later receiver targets after %s', initial => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
def execute():
    local = ${initial}
    local.run()
    local = Other()
    local.run()
    local.run()
`);
    const edges = resolveEdges([model, use]);
    const typed = edges.filter(e => e.tier === 'type');
    expect(new Set(typed.map(e => e.dstQualifiedKey))).toEqual(new Set(initial === 'Target()' ? ['Target.run', 'Other.run'] : ['Other.run']));
    const calls = buildPatchWithResolution(use, 'hash', 'workspace', edges).ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS' && op.attrs?.tier === 'type');
    expect(calls).toHaveLength(initial === 'Target()' ? 2 : 1);
    expect(new Set(calls.map(op => op.dst)).size).toBe(calls.length);
    if (initial === 'unknown()') {
      expect(buildPatchWithResolution(use, 'hash', 'workspace', edges).ops).toContainEqual(expect.objectContaining({
        type: 'UpsertNode', attrs: expect.objectContaining({ unresolved_calls: expect.arrayContaining(['local.run']) }),
      }));
    }
    const summaries = new Map([model, use].map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([use], undefined, index)).toEqual(edges.filter(e => e.srcFilePath === use.filePath));
  });

  it('keeps an unknown module call separate from a later imported binding', () => {
    const helper = parse('src/pkg/helper.py', 'def run(): pass\n');
    const use = parse('src/pkg/use.py', `def execute():
    helper.run()
    import pkg.helper as helper
    helper.run()
`);
    const edges = resolveEdges([helper, use]);
    expect(edges.filter(e => e.predicate === 'CALLS')).toEqual([
      expect.objectContaining({ dstFilePath: helper.filePath, dstQualifiedKey: 'run', tier: 'binding' }),
    ]);
    const patch = buildPatchWithResolution(use, 'hash', 'workspace', edges);
    expect(patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toHaveLength(1);
    expect(patch.ops).toContainEqual(expect.objectContaining({
      type: 'UpsertNode', attrs: expect.objectContaining({ unresolved_calls: ['helper.run'] }),
    }));
  });

  it.each(['..', '...'])('preserves every dot in parent-relative type imports: %s', dots => {
    const parent = parse('src/pkg/__init__.py', 'class Target:\n    def run(self): pass\n');
    const nearer = parse('src/pkg/nested/__init__.py', 'class Target:\n    def run(self): pass\n');
    const use = parse(`src/pkg/nested/${dots === '...' ? 'deeper/' : ''}use.py`, `from ${dots} import Target as Item
def execute():
    local = Item()
    local.run()
`);
    expect(resolveEdges([parent, nearer, use]).filter(e => e.tier === 'type')).toEqual([
      expect.objectContaining({ dstFilePath: parent.filePath, dstQualifiedKey: 'Target.run' }),
    ]);
  });

  it.each(['.', '..'])('imports names defined in a relative package initializer: %s', dots => {
    const init = parse('src/pkg/__init__.py', 'class Target: pass\n');
    const use = parse(`src/pkg/${dots === '..' ? 'nested/' : ''}use.py`, `from ${dots} import Target`);
    expect(resolveEdges([init, use]).filter(e => e.predicate === 'IMPORTS')).toEqual([
      expect.objectContaining({ dstFilePath: init.filePath, dstQualifiedKey: '__init__.py' }),
    ]);
  });

  it('does not expose function-local class or module imports to siblings', () => {
    const helper = parse('src/pkg/helper.py', 'def run(): pass\n');
    const use = parse('src/pkg/use.py', `def first():
    from .model import Target
    import pkg.helper as helper
    local = Target()
    local.run()
    helper.run()
def second():
    local = Target()
    local.run()
    helper.run()
def third(local: Target):
    local.run()
`);
    const calls = resolveEdges([model, helper, use]).filter(e => e.predicate === 'CALLS');
    expect(calls).toHaveLength(3);
    expect(calls.every(e => e.srcName === 'first')).toBe(true);
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
    expect(resolveEdges([model, use])).toContainEqual(expect.objectContaining({
      srcName: 'Service.execute', dstFilePath: model.filePath, dstQualifiedKey: 'Target.run', tier: 'type', confidence: 0.95,
    }));
  });

  it('resolves class annotations, local constructors and inherited self calls incrementally', () => {
    const base = parse('src/pkg/base.py', `from .model import Target as Item
class Base:
    def inherited(self): pass
`);
    const use = parse('src/pkg/use.py', `from .model import Target as Item
from .base import Base
class Service(Base):
    dep: Item
    def execute(self):
        self.dep.run()
        self.inherited()
        self.own()
    def own(self): pass
def execute():
    local = Item()
    local.run()
`);
    const files = [model, base, use];
    const edges = resolveEdges(files);
    for (const [srcName, dstQualifiedKey] of [['Service.execute', 'Target.run'], ['Service.execute', 'Base.inherited'], ['Service.execute', 'Service.own'], ['execute', 'Target.run']]) {
      expect(edges).toContainEqual(expect.objectContaining({ srcName, dstQualifiedKey, tier: 'type' }));
    }
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([use], undefined, index)).toEqual(edges.filter(e => e.srcFilePath === use.filePath));
    expect(buildPatchWithResolution(use, 'hash', 'workspace', edges).ops).toContainEqual(expect.objectContaining({
      type: 'UpsertEdge', predicate: 'CALLS', attrs: { confidence: 0.95, tier: 'type' },
    }));
  });

  it.each(['from pkg import model as m', 'import pkg.model as m', 'from . import model as m'])('maps module imports and calls: %s', statement => {
    const use = parse('src/pkg/use.py', `${statement}
def execute():
    local = m.Target()
    local.run()
`);
    const edges = resolveEdges([model, use]);
    expect(edges).toContainEqual(expect.objectContaining({ predicate: 'IMPORTS', dstFilePath: model.filePath }));
    expect(edges).toContainEqual(expect.objectContaining({ predicate: 'CALLS', dstFilePath: model.filePath, dstQualifiedKey: 'Target.run', tier: 'type' }));
  });

  it.each(['from a.b import c', 'from a.b import Missing'])('maps imported modules or the package initializer: %s', statement => {
    const init = parse('src/a/b/__init__.py', 'class Missing: pass\n');
    const child = parse('src/a/b/c.py', 'def work(): pass\n');
    const unrelated = parse('src/elsewhere/c.py', 'def work(): pass\n');
    const use = parse('src/use.py', statement);
    const edges = resolveEdges([use, init, child, unrelated]).filter(e => e.predicate === 'IMPORTS');
    expect(edges).toContainEqual(expect.objectContaining({ dstFilePath: statement.endsWith(' c') ? child.filePath : init.filePath }));
    expect(edges.some(e => e.dstFilePath === unrelated.filePath)).toBe(false);
  });

  it('does not guess ambiguous or unknown receivers, reassignments or out-of-scope locals', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
def known():
    local = Target()
    local = unknown()
    local.run()
def other(local):
    local.run()
class Service:
    def execute(self):
        self.missing.run()
        self.run()
`);
    const edges = resolveEdges([model, use]).filter(e => e.predicate === 'CALLS' && e.dstQualifiedKey.endsWith('.run'));
    expect(edges).toEqual([]);
    const ambiguous = parse('src/pkg/model_duplicate.py', 'class Target:\n    def run(self): pass\n');
    const unknown = parse('src/use.py', 'def execute(obj):\n    obj.run()\n');
    expect(resolveEdges([model, ambiguous, unknown]).filter(e => e.predicate === 'CALLS')).toEqual([]);
  });

  it('uses annotated initializer parameters and quoted annotations', () => {
    const use = parse('src/pkg/use.py', `from .model import Target
class Service:
    def __init__(self, dep: Target):
        self.dep = dep
    def execute(self):
        self.dep.run()
def execute(local: "Target"):
    local.run()
`);
    expect(resolveEdges([model, use]).filter(e => e.tier === 'type').map(e => e.srcName)).toEqual(['Service.execute', 'execute']);
  });

  it.each([
    'local = Target()\n    local, other = unknown()',
    'local = Target()\n    del local',
    'local = Target()\n    if flag:\n        local = unknown()',
    'local = Target()\n    for local in values:\n        pass',
    'local = Target()\n    with unknown() as local:\n        pass',
    'local = Target()\n    with unknown() as (local, other):\n        pass',
  ])('invalidates uncertain local assignments: %s', body => {
    const use = parse('src/pkg/use.py', `from .model import Target\ndef execute():\n    ${body}\n    local.run()\n`);
    expect(resolveEdges([model, use]).filter(e => e.dstQualifiedKey === 'Target.run')).toEqual([]);
  });

  it('does not resolve module aliases shadowed by parameters', () => {
    const module = parse('src/pkg/helper.py', 'def run(): pass\n');
    const use = parse('src/pkg/use.py', 'import pkg.helper as helper\ndef execute(helper):\n    helper.run()\n');
    expect(resolveEdges([module, use]).filter(e => e.predicate === 'CALLS')).toEqual([]);
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
    expect(resolveEdges([model, use]).filter(e => e.tier === 'type')).toEqual([]);
  });

  it('keeps unknown calls in patch diagnostics without guessing a local method', () => {
    const use = parse('src/pkg/use.py', 'class Service:\n    def run(self): pass\ndef execute(obj):\n    obj.run()\n');
    const patch = buildPatch(use, 'hash', 'workspace');
    expect(patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toEqual([]);
    expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertNode', attrs: expect.objectContaining({ unresolved_calls: ['obj.run'] }) }));
    expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'AssertClaim', field: 'calls:obj.run', value: 'obj.run' }));
  });

  it('does not resolve missing package imports by a coincidental symbol name', () => {
    const use = parse('src/pkg/use.py', 'from missing.module import Target\ndef execute():\n    local = Target()\n    local.run()\n');
    expect(resolveEdges([model, use]).filter(e => e.predicate === 'IMPORTS' || e.predicate === 'CALLS')).toEqual([]);
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
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    const edges = resolveEdges(files);
    const expected = expect.objectContaining({ srcFilePath: use.filePath, srcName: 'Service.execute',
      dstName: 'item.run', dstFilePath: base.filePath, dstQualifiedKey: 'Base.run', predicate: 'CALLS',
      tier: 'type', callSite: expect.any(Number) });
    expect(edges).toContainEqual(expected);
    expect(edges).toContainEqual(expect.objectContaining({ srcFilePath: child.filePath,
      srcName: 'Child', dstName: 'base.Base', dstFilePath: base.filePath, dstQualifiedKey: 'Base', predicate: 'EXTENDS' }));
    expect(edges.some(e => e.dstFilePath === decoy.filePath)).toBe(false);
    expect(resolveEdges([use], undefined, index)).toEqual(edges.filter(e => e.srcFilePath === use.filePath));
  });

  it('uses superclass import aliases from stored summaries', () => {
    const base = parse('src/pkg/base.py', 'class Base:\n    def run(self): pass\n');
    const middle = parse('src/pkg/middle.py', 'from .base import Base as Parent\nclass Middle(Parent): pass\n');
    const use = parse('src/pkg/use.py', 'from .middle import Middle\nclass Service(Middle):\n    def execute(self):\n        self.run()\n');
    const files = [base, middle, use];
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    const edges = resolveEdges([use], undefined, index);
    expect(edges).toContainEqual(expect.objectContaining({ dstFilePath: base.filePath, dstQualifiedKey: 'Base.run', tier: 'type' }));
    const changed = summarizeParseResult(parse('src/pkg/middle.py', 'from .other import Base as Parent\nclass Middle(Parent): pass\n'));
    expect(changed.sig).not.toBe(summaries.get(middle.filePath)!.sig);
  });

  it('resolves src packages from tests outside src and supports parent-relative imports', () => {
    const test = parse('tests/test_model.py', 'from pkg.model import Target\ndef execute():\n    local = Target()\n    local.run()\n');
    const nested = parse('src/pkg/nested/use.py', 'from ..model import Target\ndef execute():\n    local = Target()\n    local.run()\n');
    const files = [model, test, nested];
    for (const srcFilePath of [test.filePath, nested.filePath]) {
      expect(resolveEdges(files)).toContainEqual(expect.objectContaining({ srcFilePath, dstFilePath: model.filePath, dstQualifiedKey: 'Target.run', tier: 'type' }));
    }
  });

  it('leaves ambiguous module roots unresolved', () => {
    const first = parse('first/src/pkg/helper.py', 'def run(): pass\n');
    const second = parse('second/src/pkg/helper.py', 'def run(): pass\n');
    const use = parse('tests/test_helper.py', 'import pkg.helper as helper\ndef execute():\n    helper.run()\n');
    expect(resolveEdges([first, second, use]).filter(e => e.predicate === 'IMPORTS' || e.predicate === 'CALLS')).toEqual([]);
  });

  it('does not select an ambiguous module root by the receiver class name', () => {
    const first = parse('first/src/pkg/model.py', 'class Target:\n    def run(self): pass\n');
    const second = parse('second/src/pkg/model.py', 'class Other:\n    def run(self): pass\n');
    const use = parse('tests/test_model.py', 'from pkg.model import Target\ndef execute(item: Target):\n    item.run()\n');
    const files = [first, second, use];
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    for (const edges of [resolveEdges(files), resolveEdges([use], undefined, index)]) {
      expect(edges.filter(e => e.predicate === 'IMPORTS' || e.predicate === 'CALLS')).toEqual([]);
    }
  });

  it('does not borrow a constructor hidden by an instance or module reassignment', () => {
    const use = parse('src/pkg/use.py', `from .model import Target, Other
import pkg.model as module
module = unknown()
def execute():
    Target = Other()
    local = Target()
    local.run()
    module.run()
`);
    expect(resolveEdges([model, use]).filter(e => e.tier === 'type')).toEqual([]);
  });

  it('does not guess between imports of the same name in different functions', () => {
    const other = parse('src/pkg/other.py', 'class Target:\n    def run(self): pass\n');
    const use = parse('src/pkg/use.py', `def first():
    from .model import Target
    local = Target()
    local.run()
def second():
    from .other import Target
    local = Target()
    local.run()
`);
    expect(resolveEdges([model, other, use]).filter(e => e.tier === 'type')).toEqual([]);
  });
});
