// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { buildGlobalResolutionIndex, parseFile, summarizeParseResult, type FileParseResult } from '../index.js';
import { resolveEdges } from './helpers/untiered.js';

// Python call resolution through absolute imports, package `__init__.py`
// files, aliased module imports and typed receivers inside methods. Every
// fixture has a same-named decoy elsewhere in the repo: an edge must come
// from the import path or a declared type, never from a guess by name.

function py(filePath: string, source: string): FileParseResult {
  const result = parseFile(filePath, source);
  if (!result) throw new Error(`parse failed: ${filePath}`);
  return result;
}

type Edge = ReturnType<typeof resolveEdges>[number];

function callsTo(edges: Edge[], dstFilePath: string): Edge[] {
  return edges.filter(e => e.predicate === 'CALLS' && e.dstFilePath === dstFilePath);
}

function importsOf(edges: Edge[], srcFilePath: string, dstFilePath: string): Edge[] {
  return edges.filter(e => e.predicate === 'IMPORTS' && e.srcFilePath === srcFilePath && e.dstFilePath === dstFilePath);
}

const MOD = '/repo/pkg/sub/mod.py';
const OTHER_MOD = '/repo/other/mod.py';

const mod = () => py(MOD, 'def load():\n    return 1\n');
const otherMod = () => py(OTHER_MOD, 'def load():\n    return 2\n');

describe('Python absolute imports resolve by full module path', () => {
  it('from pkg.sub.mod import load resolves to pkg/sub/mod.py when another mod.py exists', () => {
    const caller = py('/repo/app/main.py', 'from pkg.sub.mod import load\n\ndef main():\n    return load()\n');
    const edges = resolveEdges([caller, mod(), otherMod()]);

    expect(edges).toContainEqual({
      srcFilePath: '/repo/app/main.py',
      srcName: 'main',
      dstFilePath: MOD,
      dstName: 'load',
      dstQualifiedKey: 'load',
      predicate: 'CALLS',
      confidence: 0.9,
    });
    expect(importsOf(edges, '/repo/app/main.py', MOD)).toHaveLength(1);
    expect(callsTo(edges, OTHER_MOD)).toEqual([]);
    expect(importsOf(edges, '/repo/app/main.py', OTHER_MOD)).toEqual([]);
  });

  it('resolves the same way across batches through the global index', () => {
    const caller = py('/repo/app/main.py', 'from pkg.sub.mod import load\n\ndef main():\n    return load()\n');
    const all = [caller, mod(), otherMod()];
    // What the CLI does: index every file by its summary, resolve one batch.
    const index = buildGlobalResolutionIndex(all.map(r => r.filePath), undefined, undefined, new Map(all.map(r => [r.filePath, summarizeParseResult(r)])));
    const edges = resolveEdges([caller], undefined, index);

    expect(callsTo(edges, MOD)).toHaveLength(1);
    expect(callsTo(edges, OTHER_MOD)).toEqual([]);
  });

  it('import pkg.sub.mod as m; m.load() resolves through the alias', () => {
    const caller = py('/repo/app/main.py', 'import pkg.sub.mod as m\n\ndef main():\n    return m.load()\n');
    expect(caller.importAliases).toEqual({ m: 'pkg.sub.mod' });
    const edges = resolveEdges([caller, mod(), otherMod()]);

    expect(callsTo(edges, MOD)).toContainEqual(
      expect.objectContaining({ srcName: 'main', dstName: 'm.load', dstQualifiedKey: 'load', confidence: 0.9 }),
    );
    expect(importsOf(edges, '/repo/app/main.py', MOD)).toHaveLength(1);
    expect(callsTo(edges, OTHER_MOD)).toEqual([]);
  });

  it('import torch.nn as nn does not bind a local nn.py by stem', () => {
    // A third-party module: no file has the full path torch/nn.py. The alias was
    // never resolved before, so it gets no stem fallback (unlike `import torch.nn`).
    const NN = '/repo/models/nn.py';
    const local = py(NN, 'def relu(x):\n    return x\n\nclass Linear:\n    pass\n');
    const caller = py('/repo/app/main.py', 'import torch.nn as nn\n\ndef main(a):\n    nn.Linear()\n    return nn.relu(a)\n');
    expect(caller.relationships).toContainEqual(expect.objectContaining({ predicate: 'IMPORTS', dstName: 'torch.nn', importAliased: true }));
    expect(summarizeParseResult(caller).imports).toEqual([{ dstName: 'torch.nn', importRaw: 'torch.nn', importAliased: true }]);
    const edges = resolveEdges([caller, local]);

    expect(importsOf(edges, '/repo/app/main.py', NN)).toEqual([]);
    expect(callsTo(edges, NN).filter(e => e.confidence >= 0.9)).toEqual([]);
  });

  it('import yaml as y binds a local yaml.py only under a root that contains the importing file', () => {
    const elsewhere = py('/repo/tools/yaml.py', 'def load(x):\n    return x\n');
    const caller = py('/repo/app/main.py', 'import yaml as y\n\ndef main(a):\n    return y.load(a)\n');
    const edges = resolveEdges([caller, elsewhere]);

    expect(importsOf(edges, caller.filePath, elsewhere.filePath)).toEqual([]);
    expect(callsTo(edges, elsewhere.filePath).filter(e => e.confidence >= 0.6)).toEqual([]);

    const beside = py('/repo/app/yaml.py', 'def load(x):\n    return x\n');
    const withBeside = resolveEdges([caller, elsewhere, beside]);
    expect(importsOf(withBeside, caller.filePath, beside.filePath)).toHaveLength(1);
    expect(callsTo(withBeside, beside.filePath)).toContainEqual(
      expect.objectContaining({ srcName: 'main', dstQualifiedKey: 'load', confidence: 0.9 }),
    );
    expect(importsOf(withBeside, caller.filePath, elsewhere.filePath)).toEqual([]);
    expect(callsTo(withBeside, elsewhere.filePath).filter(e => e.confidence >= 0.6)).toEqual([]);
  });

  it('import json as j inside a package does not bind the package\'s own json.py', () => {
    // myapp has an __init__.py, so it is a package, not a source root: under
    // Python 3 absolute imports `import json` there is the stdlib json.
    const init = py('/repo/src/myapp/__init__.py', '');
    const local = py('/repo/src/myapp/json.py', 'def dumps(x):\n    return x\n');
    const caller = py('/repo/src/myapp/views.py', 'import json as j\n\ndef v(a):\n    return j.dumps(a)\n');
    const all = [caller, init, local];
    const index = buildGlobalResolutionIndex(all.map(r => r.filePath), undefined, undefined, new Map(all.map(r => [r.filePath, summarizeParseResult(r)])));

    for (const edges of [resolveEdges(all), resolveEdges([caller], undefined, index)]) {
      expect(importsOf(edges, caller.filePath, local.filePath)).toEqual([]);
      expect(callsTo(edges, local.filePath).filter(e => e.confidence >= 0.6)).toEqual([]);
    }

    // A json.py under the source root above the package is what Python finds.
    const top = py('/repo/src/json.py', 'def dumps(x):\n    return x\n');
    const withTop = resolveEdges([caller, init, local, top]);
    expect(importsOf(withTop, caller.filePath, top.filePath)).toHaveLength(1);
    expect(callsTo(withTop, top.filePath)).toContainEqual(
      expect.objectContaining({ srcName: 'v', dstQualifiedKey: 'dumps', confidence: 0.9 }),
    );
    expect(importsOf(withTop, caller.filePath, local.filePath)).toEqual([]);
  });

  it('import logging inside a package does not bind the package\'s own logging/ subpackage', () => {
    const init = py('/repo/myapp/__init__.py', '');
    const nested = py('/repo/myapp/logging/__init__.py', 'def getLogger():\n    return 1\n');
    const caller = py('/repo/myapp/views.py', 'import logging\n\ndef v():\n    return logging.getLogger()\n');
    const edges = resolveEdges([caller, init, nested]);

    expect(importsOf(edges, caller.filePath, nested.filePath)).toEqual([]);
    expect(callsTo(edges, nested.filePath).filter(e => e.confidence >= 0.6)).toEqual([]);
  });

  it('import torch.nn as nn stays unbound across batches too', () => {
    const NN = '/repo/models/nn.py';
    const local = py(NN, 'def relu(x):\n    return x\n');
    const caller = py('/repo/app/main.py', 'import torch.nn as nn\n\ndef main(a):\n    return nn.relu(a)\n');
    const all = [caller, local];
    const index = buildGlobalResolutionIndex(all.map(r => r.filePath), undefined, undefined, new Map(all.map(r => [r.filePath, summarizeParseResult(r)])));
    const edges = resolveEdges([caller], undefined, index);

    expect(importsOf(edges, '/repo/app/main.py', NN)).toEqual([]);
    expect(callsTo(edges, NN).filter(e => e.confidence >= 0.9)).toEqual([]);
  });

  it('an aliased import in an imported module does not reach a same-stem file transitively', () => {
    const NN = '/repo/models/nn.py';
    const local = py(NN, 'def relu(x):\n    return x\n');
    const shim = py('/repo/app/shim.py', 'import torch.nn as nn\n');
    const caller = py('/repo/app/main.py', 'import app.shim\n\ndef main(a):\n    return relu(a)\n');
    const edges = resolveEdges([caller, shim, local]);

    expect(callsTo(edges, NN).filter(e => e.confidence >= 0.6)).toEqual([]);
  });

  it('import pkg.sub.mod; pkg.sub.mod.load() resolves to that module', () => {
    const caller = py('/repo/app/main.py', 'import pkg.sub.mod\n\ndef main():\n    return pkg.sub.mod.load()\n');
    const edges = resolveEdges([caller, mod(), otherMod()]);

    expect(callsTo(edges, MOD)).toEqual([
      expect.objectContaining({ srcName: 'main', dstName: 'load', dstQualifiedKey: 'load', confidence: 0.9 }),
    ]);
    expect(importsOf(edges, '/repo/app/main.py', MOD)).toHaveLength(1);
    expect(callsTo(edges, OTHER_MOD)).toEqual([]);
  });

  it('declines when no matching root contains the importing file, however much path it shares', () => {
    // svc1/src shares more of the path with svc1/tests than svc2/src does, but
    // neither root contains the test, so neither is where Python looks.
    const caller = py('/repo/svc1/tests/test_main.py', 'from app.util import load\n\ndef test_main():\n    return load()\n');
    const mine = py('/repo/svc1/src/app/util.py', 'def load():\n    return 1\n');
    const theirs = py('/repo/svc2/src/app/util.py', 'def load():\n    return 2\n');
    const edges = resolveEdges([caller, mine, theirs]);

    expect(edges.filter(e => e.predicate === 'CALLS')).toEqual([]);
    expect(edges.filter(e => e.predicate === 'IMPORTS' && e.dstName === 'app.util')).toEqual([]);
  });

  it('a test does not bind a fixture copy of the package over the real src package', () => {
    const caller = py('/repo/tests/test_mod.py', 'from pkg.sub.mod import load\n\ndef test_it():\n    return load()\n');
    const real = py('/repo/src/pkg/sub/mod.py', 'def load():\n    return 1\n');
    const fixture = py('/repo/tests/fixtures/pkg/sub/mod.py', 'def load():\n    return 2\n');
    const edges = resolveEdges([caller, real, fixture]);

    expect(importsOf(edges, caller.filePath, fixture.filePath)).toEqual([]);
    expect(callsTo(edges, fixture.filePath).filter(e => e.confidence >= 0.6)).toEqual([]);
    expect(callsTo(edges, real.filePath).filter(e => e.confidence >= 0.6)).toEqual([]);
  });

  it('prefers the deepest source root that contains the importing file', () => {
    const top = py('/repo/app/util.py', 'def load():\n    return 1\n');
    const nested = py('/repo/services/x/app/util.py', 'def load():\n    return 2\n');
    const source = 'from app.util import load\n\ndef main():\n    return load()\n';

    // services/y is under the repo root only: the top-level package, even
    // though services/x shares more of its path.
    const sibling = py('/repo/services/y/main.py', source);
    const fromSibling = resolveEdges([sibling, top, nested]);
    expect(callsTo(fromSibling, top.filePath)).toHaveLength(1);
    expect(callsTo(fromSibling, nested.filePath)).toEqual([]);

    // services/x is its own source root: its own package.
    const inside = py('/repo/services/x/main.py', source);
    const fromInside = resolveEdges([inside, top, nested]);
    expect(callsTo(fromInside, nested.filePath)).toHaveLength(1);
    expect(callsTo(fromInside, top.filePath)).toEqual([]);
  });

  it('declines when two full-path matches are equally close', () => {
    const caller = py('/repo/main.py', 'from app.util import load\n\ndef main():\n    return load()\n');
    const a = py('/repo/svc1/app/util.py', 'def load():\n    return 1\n');
    const b = py('/repo/svc2/app/util.py', 'def load():\n    return 2\n');
    const edges = resolveEdges([caller, a, b]);

    expect(edges.filter(e => e.predicate === 'CALLS')).toEqual([]);
    expect(edges.filter(e => e.predicate === 'IMPORTS' && e.dstName === 'app.util')).toEqual([]);
  });

  it('two same-stem files with no full-path match stay unresolved, as before', () => {
    const caller = py('/repo/app/main.py', 'from vendor.lib.mod import load\n\ndef main():\n    return load()\n');
    const edges = resolveEdges([caller, mod(), otherMod()]);

    expect(edges.filter(e => e.predicate === 'CALLS')).toEqual([]);
  });

  it('a module-level load and a same-named method elsewhere stay unconnected', () => {
    const caller = py('/repo/app/main.py', 'from pkg.sub.mod import load\n\ndef main():\n    return load()\n');
    const target = py(MOD, 'def other():\n    return 1\n');
    const method = py('/repo/lib/thing.py', 'class Thing:\n    def load(self):\n        return 1\n');
    const edges = resolveEdges([caller, target, method]);

    expect(callsTo(edges, method.filePath)).toEqual([]);
  });
});

describe('Python package __init__.py', () => {
  it('from pkg import load resolves to load defined in pkg/__init__.py', () => {
    const caller = py('/repo/app/main.py', 'from pkg import load\n\ndef main():\n    return load()\n');
    const init = py('/repo/pkg/__init__.py', 'def load():\n    return 1\n');
    const decoy = py('/repo/elsewhere/tools.py', 'def load():\n    return 2\n');
    const edges = resolveEdges([caller, init, decoy]);

    expect(callsTo(edges, init.filePath)).toEqual([
      expect.objectContaining({ srcName: 'main', dstName: 'load', dstQualifiedKey: 'load', confidence: 0.9 }),
    ]);
    expect(importsOf(edges, '/repo/app/main.py', init.filePath)).toHaveLength(1);
    expect(callsTo(edges, decoy.filePath)).toEqual([]);
  });

  it('from pkg.sub import load resolves to pkg/sub/__init__.py, not another sub package', () => {
    const caller = py('/repo/app/main.py', 'from pkg.sub import load\n\ndef main():\n    return load()\n');
    const init = py('/repo/pkg/sub/__init__.py', 'def load():\n    return 1\n');
    const decoy = py('/repo/other/sub/__init__.py', 'def load():\n    return 2\n');
    const edges = resolveEdges([caller, init, decoy]);

    expect(callsTo(edges, init.filePath)).toHaveLength(1);
    expect(callsTo(edges, decoy.filePath)).toEqual([]);
  });

  it('from pkg import tools still resolves to the submodule pkg/tools.py', () => {
    const caller = py('/repo/app/main.py', 'from pkg import tools\n\ndef main():\n    return tools.run()\n');
    const init = py('/repo/pkg/__init__.py', 'VERSION = 1\n');
    const sub = py('/repo/pkg/tools.py', 'def run():\n    return 1\n');
    const edges = resolveEdges([caller, init, sub]);

    // As before: `tools.run()` reaches pkg/tools.py by the member name. That
    // holds only while no other tools.py exists; see the next case.
    expect(callsTo(edges, sub.filePath)).toEqual([
      expect.objectContaining({ srcName: 'main', dstQualifiedKey: 'run' }),
    ]);
    expect(callsTo(edges, init.filePath)).toEqual([]);
  });

  it('from pkg import tools with another tools.py elsewhere guesses neither', () => {
    const caller = py('/repo/app/main.py', 'from pkg import tools\n\ndef main():\n    return tools.run()\n');
    const init = py('/repo/pkg/__init__.py', 'VERSION = 1\n');
    const sub = py('/repo/pkg/tools.py', 'def run():\n    return 1\n');
    const decoy = py('/repo/other/tools.py', 'def run():\n    return 2\n');
    const edges = resolveEdges([caller, init, sub, decoy]);

    // Unresolved, as on the base: the submodule is named by a bare imported
    // name, which still matches by stem. What matters is no edge to the decoy.
    expect(callsTo(edges, decoy.filePath)).toEqual([]);
    expect(callsTo(edges, init.filePath)).toEqual([]);
  });

  it('from . import x resolves to x defined in the package __init__.py', () => {
    const caller = py('/repo/pkg/main.py', 'from . import helper\n\ndef main():\n    return helper()\n');
    const init = py('/repo/pkg/__init__.py', 'def helper():\n    return 1\n');
    const decoy = py('/repo/other/__init__.py', 'def helper():\n    return 2\n');
    const edges = resolveEdges([caller, init, decoy]);

    expect(callsTo(edges, init.filePath)).toEqual([
      expect.objectContaining({ srcName: 'main', dstName: 'helper', dstQualifiedKey: 'helper' }),
    ]);
    expect(callsTo(edges, decoy.filePath)).toEqual([]);
  });

  it('from . import x still treats a submodule x as a module', () => {
    const caller = py('/repo/pkg/main.py', 'from . import utils\n\ndef main():\n    return utils.target()\n');
    const init = py('/repo/pkg/__init__.py', 'def utils():\n    return 0\n');
    const sub = py('/repo/pkg/utils.py', 'def target():\n    return 1\n');
    const edges = resolveEdges([caller, init, sub]);

    expect(callsTo(edges, sub.filePath)).toEqual([
      expect.objectContaining({ srcName: 'main', dstQualifiedKey: 'target', confidence: 0.9 }),
    ]);
    expect(callsTo(edges, init.filePath)).toEqual([]);
  });
});

describe('Python typed receivers inside methods', () => {
  const query = () => py('/repo/db/query.py', 'class Query:\n    def filter(self):\n        return self\n');
  const builder = () => py('/repo/db/builder.py', 'class Builder:\n    def build(self):\n        return 1\n');
  // Same method names on unrelated classes: a bare-name guess is ambiguous.
  const decoy = () => py('/repo/other/decoy.py', 'class Sieve:\n    def filter(self):\n        return 0\n\nclass Factory:\n    def build(self):\n        return 0\n');

  it('a typed parameter of a method resolves to the declared class', () => {
    const caller = py('/repo/app/service.py', [
      'from db.query import Query',
      '',
      'class Service:',
      '    def run(self, q: Query):',
      '        return q.filter()',
      '',
    ].join('\n'));
    expect(caller.relationships).toContainEqual({ srcName: 'Service.run', dstName: 'Query.filter', predicate: 'CALLS' });
    const edges = resolveEdges([caller, query(), decoy()]);

    expect(callsTo(edges, '/repo/db/query.py')).toContainEqual(
      expect.objectContaining({ srcName: 'Service.run', dstName: 'Query.filter', dstQualifiedKey: 'Query.filter' }),
    );
    expect(callsTo(edges, '/repo/other/decoy.py')).toEqual([]);
  });

  it('a constructor-assigned local of a method resolves to the class', () => {
    const caller = py('/repo/app/service.py', [
      'from db.builder import Builder',
      '',
      'class Service:',
      '    def run(self):',
      '        x = Builder()',
      '        return x.build()',
      '',
    ].join('\n'));
    expect(caller.relationships).toContainEqual({ srcName: 'Service.run', dstName: 'Builder.build', predicate: 'CALLS' });
    const edges = resolveEdges([caller, builder(), decoy()]);

    expect(callsTo(edges, '/repo/db/builder.py')).toContainEqual(
      expect.objectContaining({ srcName: 'Service.run', dstName: 'Builder.build', dstQualifiedKey: 'Builder.build' }),
    );
    expect(callsTo(edges, '/repo/other/decoy.py')).toEqual([]);
  });

  it('a same-named module-level function keeps its own map', () => {
    const caller = py('/repo/app/service.py', [
      'class Service:',
      '    def run(self, q: Query):',
      '        return q.filter()',
      '',
      'def run(q):',
      '    return q.filter()',
      '',
    ].join('\n'));
    const calls = caller.relationships.filter(r => r.predicate === 'CALLS');
    expect(calls).toContainEqual({ srcName: 'Service.run', dstName: 'Query.filter', predicate: 'CALLS' });
    expect(calls).toContainEqual({ srcName: 'run', dstName: 'q.filter', predicate: 'CALLS' });
    expect(calls).not.toContainEqual({ srcName: 'run', dstName: 'Query.filter', predicate: 'CALLS' });
  });
});

describe('Python packages are found only where the import can reach them', () => {
  it('import logging does not resolve to a nested myapp/logging/ package', () => {
    const caller = py('/repo/app/main.py', 'import logging\n\ndef main():\n    return logging.getLogger()\n');
    const nested = py('/repo/myapp/logging/__init__.py', 'def getLogger():\n    return 1\n');
    const edges = resolveEdges([caller, nested]);

    expect(importsOf(edges, caller.filePath, nested.filePath)).toEqual([]);
    expect(callsTo(edges, nested.filePath).filter(e => e.confidence >= 0.9)).toEqual([]);
  });

  it('import pkg resolves to pkg/__init__.py under a root that contains the importing file', () => {
    const caller = py('/repo/app/main.py', 'import pkg\n\ndef main():\n    return pkg.entry()\n');
    const init = py('/repo/pkg/__init__.py', 'def entry():\n    return 1\n');
    const nested = py('/repo/vendor/lib/pkg/__init__.py', 'def entry():\n    return 2\n');
    const edges = resolveEdges([caller, init, nested]);

    expect(importsOf(edges, caller.filePath, init.filePath)).toHaveLength(1);
    expect(importsOf(edges, caller.filePath, nested.filePath)).toEqual([]);
  });

  it('a package beside a same-named module under one root wins, as in Python', () => {
    const caller = py('/repo/app/main.py', 'from a.b import fetch\n\ndef main():\n    return fetch()\n');
    const module = py('/repo/a/b.py', 'def fetch():\n    return 1\n');
    const pkg = py('/repo/a/b/__init__.py', 'def fetch():\n    return 2\n');
    const edges = resolveEdges([caller, module, pkg]);

    expect(importsOf(edges, caller.filePath, pkg.filePath)).toHaveLength(1);
    expect(importsOf(edges, caller.filePath, module.filePath)).toEqual([]);
    expect(callsTo(edges, pkg.filePath)).toEqual([
      expect.objectContaining({ srcName: 'main', dstQualifiedKey: 'fetch', confidence: 0.9 }),
    ]);
    expect(callsTo(edges, module.filePath)).toEqual([]);
  });
});
