// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFile, bindBehaviorIds, summarizeParseResult } from '../index.js';
import { behaviorLimits, extractBehavior, type BehaviorWrite } from '../behavior.js';
import { buildPatch, symbolNodeId } from '../patch-builder.js';
import { positiveCases, negativeCases } from './fixtures/behavior-cases.js';

function parsed(source: string, path = 'src/job.ts') {
  const result = parseFile(path, source);
  expect(result, path).toBeTruthy();
  expect(result!.hasParseErrors).toBeUndefined();
  return result!;
}

function writes(source: string, path?: string) {
  return parsed(source, path).behavior?.writes ?? [];
}

function slice(source: string, [line, col, endLine, endCol]: number[]) {
  const lines = source.split('\n');
  const selected = lines.slice(line - 1, endLine);
  selected[selected.length - 1] = selected.at(-1)!.slice(0, endCol);
  selected[0] = selected[0].slice(col);
  return selected.join('\n');
}

function ids(write: BehaviorWrite, workspace = 'ws', path = 'src/job.ts') {
  return bindBehaviorIds(write, key => symbolNodeId(workspace, path, key));
}

describe.each(['ts', 'tsx', 'js', 'jsx'])('labeled writes, lexical guards and candidate priors in .%s', ext => {
  const path = 'src/job.' + ext;
  it.each(positiveCases)('$name', ({ source, sites }) => {
    const behavior = parsed(source, path).behavior!;
    expect(behavior.coverage).toBe('complete');
    const detected = behavior.writes.map(w => {
      const { guards, assignment, to } = w.observed;
      for (const g of guards) expect(slice(source, g.span)).toBe(g.expression);
      const prior = w.inferred;
      if (prior.from !== 'unknown' && 'guardIndex' in prior) {
        expect(prior.basis).toBe('direct-same-slot-equality');
        const target = w.slotKind === 'local' ? w.slotName : 'this.' + w.slotName;
        expect(guards[prior.guardIndex]).toMatchObject({ sameSlot: true, arm: 'then',
          conditionKey: ['strictEqual', target, ['string', prior.from.value]] });
      }
      return {
        owner: w.ownerKey, assignment: slice(source, assignment), to: to.value,
        guards: guards.map(g => [g.expression, g.arm, g.sameSlot]),
        ...(prior.from === 'unknown' ? {} : { prior: prior.from.value }),
      };
    });
    expect(detected).toStrictEqual(sites);
  });

  const rejections = negativeCases.filter(([, , tsOnly]) => !tsOnly || ext.startsWith('ts'));
  it.each(rejections)('rejects %s', (_, source) => {
    expect(parsed(source, path).behavior).toBeUndefined();
  });

  it('recognizes a mixed field/local method without crossing binding boundaries', () => {
    const list = writes(`class A {
      go() {
        let status;
        if (this.status === "x") status = "local";
        function deferred() { status = "captured"; }
        if (status === "local") this.status = "field";
      }
    }`, path);
    expect(list.map(w => [w.declaringKey, w.slotKind, w.slotName, w.observed.guards[0].sameSlot, w.inferred]))
      .toEqual([['A.go', 'local', 'status', false, { from: 'unknown' }], ['A', 'instanceField', 'status', false, { from: 'unknown' }]]);
  });
});

describe('grammar, provenance and owner identity', () => {
  it.each(['ts','tsx','js','jsx','mjs','cjs'])('uses the normal .%s grammar', ext => {
    const annotation = ext.startsWith('ts') ? ': string' : '';
    const jsx = ext.endsWith('x') ? 'const view = <Item status="ignored" />;' : '';
    const source = `export function move() { let phase${annotation}; ${jsx} if (phase === 'idle') phase = 'busy' }`;
    const list = writes(source, 'dir/source.' + ext);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ownerKey: 'move', declaringKey: 'move', slotKind: 'local',
      slotName: 'phase', inferred: { from: { kind: 'string', value: 'idle' }, guardIndex: 0 } });
  });

  it('cites original CRLF and UTF-16 columns, including astral characters and multiline guards', () => {
    const source = ['class A {', '  go() {', '    /*😀é*/ if (', '      this.status ===', '      "💤"',
      '    ) { /*😀*/ this.status = "é🟢"; }', '  }', '}'].join('\r\n');
    const [write] = writes(source);
    expect(write.observed.assignment).toEqual([6, 15, 6, 34]);
    expect(write.observed.guards[0].span).toEqual([4, 6, 5, 10]);
    expect(slice(source, write.observed.assignment)).toBe('this.status = "é🟢"');
    expect(write.observed.guards[0].expression).toBe('this.status ===\r\n      "💤"');
    expect(slice(source, write.observed.guards[0].span)).toBe(write.observed.guards[0].expression);
    expect(write.inferred.from).toEqual({ kind: 'string', value: '💤' });
  });

  it('keeps adjacent method identities and class/local namespaces distinct', () => {
    const source = `class A {
      up(){this.state='s'} down(){this.state='s'}
    }
    class B {
      up(){this.state='s'}
    }
    function up(){let state;state='s'}
    function down(){let state;state='s'}`;
    const list = writes(source);
    expect(list.map(w => w.ownerKey)).toEqual(['A.up','A.down','B.up','up','down']);
    const bound = list.map(w => ids(w));
    expect(bound[0].slotId).toBe(bound[1].slotId);
    expect(new Set(bound.map(w => w.slotId)).size).toBe(4);
    expect(new Set(bound.map(w => w.id)).size).toBe(5);
    expect(ids(list[0], 'other')).not.toEqual(bound[0]);
    expect(ids(list[0], 'ws', 'other.ts')).not.toEqual(bound[0]);
  });

  it('rejects collisions even when one claimant is excluded by the syntax rules', () => {
    expect(writes('class A { go(){this.status="x"} static go(){} }')).toEqual([]);
    expect(writes('class A { go(){this.state="a"} } class B { go(){this.state="b"} }')).toEqual([]);
    expect(writes('class A { go(){} } function run(){let state;state="x"}')).toEqual([]);
  });

  it('deduplicates captures of one exported arrow and accepts an overload implementation', () => {
    const source = `export const one = () => { let state; state = "one" };
    function two(): void;
    function two(){ let state; state = "two" }`;
    expect(writes(source).map(w => w.ownerKey)).toEqual(['one','two']);
  });

  it('stabilizes semantic identities across trivia, equivalent literals, line shifts and other sites', () => {
    const src = `class Item {
      run(){ if (allowed("a") && ok) { this.phase='one'; this.phase='one'; }
      if (this.phase === "one") this.phase="two"; }
    }`;
    const changed = '\n// unrelated\n' + src.replace('allowed("a") && ok', "allowed( /* trivia */ 'a')&&ok")
      .replace("this.phase='one';", String.raw`this.phase = "extra"; this.phase = "\u006fne";`)
      .replace('this.phase === "one"', "((this.phase) === 'one')");
    const before = writes(src);
    const after = writes(changed);
    expect(before.map(w => w.duplicateOrdinal)).toEqual([0,1,0]);
    expect(after.map(w => w.duplicateOrdinal)).toEqual([0,0,1,0]);
    expect(before.map(w => ids(w))).toEqual(after.slice(1).map(w => ids(w)));
    expect(ids(before[0]).id).not.toBe(ids(before[1]).id);
    expect(ids(writes(src.replace('&& ok','|| ok'))[0]).id).not.toBe(ids(before[0]).id);
    expect(ids(writes(src.replace('this.phase="two";','{} else this.phase="two";')).at(-1)!).id).not.toBe(ids(before[2]).id);
    expect(writes(src)).toStrictEqual(before);
  });

  it('handles comments on either side of the assignment operator', () => {
    const source = 'class A { go() { this /* gap */ . status /* gap */ = /* gap */ "yes"; } }';
    expect(writes(source)[0].observed.to.value).toBe('yes');
  });

  it('cites distinct occurrences of otherwise identical guards', () => {
    const line = '  if (ready) this.phase = "x";';
    const list = writes(['class A { go() {', line, line, '} }'].join('\n'));
    expect(list.map(w => w.observed.guards[0].span)).toEqual([[2, 6, 2, 11], [3, 6, 3, 11]]);
    expect(list.map(w => w.duplicateOrdinal)).toEqual([0, 1]);
  });

  it('skips recovered trees and declaration files and preserves structural results', () => {
    const bad = parseFile('a.ts', 'class A { go(){this.state="x"} broken( {');
    expect(bad?.hasParseErrors).toBe(true);
    expect(bad?.behavior).toBeUndefined();
    expect(bad?.entities.length).toBeGreaterThan(0);
    expect(parsed('class A { go(){ this.state = "a" } }', 'a.d.ts').behavior).toBeUndefined();
    expect(parsed('def run():\n    state = "ok"', 'a.py').behavior).toBeUndefined();
  });

  it('passes plain records across structured clone and leaves graph patches and resolution summaries equivalent', () => {
    const result = parsed(positiveCases[0].source);
    const { behavior, ...structural } = result;
    expect(behavior?.writes.length).toBe(5);
    expect(structuredClone(behavior)).toStrictEqual(behavior);
    expect(JSON.parse(JSON.stringify(behavior))).toStrictEqual(behavior);
    expect(summarizeParseResult(result)).toStrictEqual(summarizeParseResult(structural));
    const patch = buildPatch(result, 'hash', 'ws');
    const ordinaryOps = patch.ops.map(op => {
      if (op.type !== 'UpsertNode' || !('behavior_v1' in op.attrs)) return op;
      expect(op.kind).toBe('method');
      const { behavior_v1, ...attrs } = op.attrs;
      expect(behavior_v1).toMatchObject({ coverage: 'complete' });
      return { ...op, attrs };
    });
    expect(ordinaryOps).toStrictEqual(buildPatch(structural, 'hash', 'ws').ops);
    expect(JSON.stringify(patch)).toContain('behavior_v1');
  });

  it('emits no evidence for the real closure-based drain gate', () => {
    const source = readFileSync(new URL('../../../ix-cli/src/cli/commit-breaker.ts', import.meta.url), 'utf8');
    const result = parsed(source);
    expect(result.entities.some(e => e.name === 'createDrainGate')).toBe(true);
    expect(result.behavior?.writes.some(w => w.ownerKey === 'createDrainGate')).toBeFalsy();
  });
});

describe('bounded optional analysis', () => {
  it('marks a prefix partial at the record cap, deterministically', () => {
    const source = 'class Job { go(){' + 'this.phase="go";'.repeat(behaviorLimits.writes + 1) + '} }';
    const result = parsed(source);
    expect(result.behavior).toMatchObject({ coverage: 'partial', cutReason: 'writes' });
    expect(result.behavior?.writes).toHaveLength(behaviorLimits.writes);
    expect(result.behavior).toEqual(parsed(source).behavior);
    expect(result.entities.some(e => e.name === 'go')).toBe(true);
  });

  it('caps evidence bytes and guard size, preserving only fully justified writes', () => {
    const guard = 'a'.repeat(900);
    const source = 'class Job { go(){ if (' + guard + ') {' + 'this.phase="go";'.repeat(230) + '} } }';
    const result = parsed(source);
    expect(result.behavior).toMatchObject({ coverage: 'partial', cutReason: 'bytes' });
    expect(Buffer.byteLength(JSON.stringify(result.behavior!.writes))).toBeLessThanOrEqual(behaviorLimits.bytes);
    const guardCut = parsed(source.replace(guard, guard.repeat(2))).behavior;
    expect(guardCut).toEqual({ coverage: 'partial', cutReason: 'conditionLength', writes: [] });
    const literalCut = parsed('class A { go(){ this.state="' + 'x'.repeat(129) + '" } }').behavior;
    expect(literalCut).toEqual({ coverage: 'partial', cutReason: 'literalLength', writes: [] });
  });

  it('discards locals when a binding scan is incomplete', () => {
    const source = 'function run(){ let state; state="x";' + 'noop;'.repeat(18_000) + '{let state;} }';
    expect(parsed(source).behavior).toEqual({ coverage: 'partial', cutReason: 'visits', writes: [] });
  });

  it('can exhaust the shared parse deadline during optional analysis', () => {
    const entity = parsed('function f(){}').entities[0];
    expect(extractBehavior([entity], [], '', -1, -Infinity, e => e.name)).toEqual({ coverage: 'partial', cutReason: 'deadline', writes: [] });
  });
});

describe('boolean lifecycle observations', () => {
  const gate = 'work(){ if (!this.stopped) return; tick(); }';
  const klass = (body: string) =>
    'class W { stopped=false; ' + gate + ' set(){' + body + '} }';
  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'keeps typed facts, exact guard spans and unknowns in %s',
    (ext) => {
      const source = klass(
        [
          '/*😀*/ if (this.stopped === false) this.stopped /*comment*/ = true;',
          'if (true === this.stopped) this.stopped = false;',
          'if (!this.stopped) this.stopped = true; else this.stopped = false;',
          'if (this.stopped) { this.stopped=true; this.stopped=false; }',
          'if (this.stopped === false) { tick(); this.stopped=true; }',
          'if (this.stopped == false) this.stopped=true;',
          'if (other.stopped === true) this.stopped=false;',
          'if (this.stopped === "false") this.stopped=false;',
          'if (other.ready) { if(this.stopped === true) this.stopped=false; }',
        ].join('\r\n'),
      );
      const list = writes(source, 'src/job.' + ext);
      expect(list.map((w) => w.inferred.from)).toEqual([
        { kind: 'boolean', value: false },
        { kind: 'boolean', value: true },
        ...Array(8).fill('unknown'),
        { kind: 'boolean', value: true },
      ]);
      expect(list.map((w) => w.observed.to.value)).toEqual([
        true,
        false,
        true,
        false,
        true,
        false,
        true,
        true,
        false,
        false,
        false,
      ]);
      expect(list.every((w) => w.observed.to.kind === 'boolean')).toBe(true);
      expect(
        list
          .slice(2, 4)
          .map((w) => [
            w.observed.guards[0].sameSlot,
            w.observed.guards[0].arm,
          ]),
      ).toEqual([
        [true, 'then'],
        [true, 'else'],
      ]);
      expect(list[8].observed.guards[0].sameSlot).toBe(false);
      expect(list.at(-1)!.observed.guards.map((g) => g.expression)).toEqual([
        'other.ready',
        'this.stopped === true',
      ]);
      for (const w of list) {
        expect(slice(source, w.observed.assignment)).toMatch(
          /^this\.stopped.*(?:true|false)$/,
        );
        for (const g of w.observed.guards)
          expect(slice(source, g.span)).toBe(g.expression);
      }
      expect(new Set(list.map((w) => ids(w).id)).size).toBe(list.length);
      expect(
        writes('\r\n' + source, 'src/job.' + ext).map((w) => ids(w)),
      ).toEqual(list.map((w) => ids(w)));
    },
  );
  it.each([
    [
      'metadata',
      'class Badge {running=false; paint(){this.running=true} color(){return this.running?"amber":"green"}}',
    ],
    [
      'presentation guard',
      'class Glyph {stopped=false; refresh(){this.stopped=true} label(){if(this.stopped)return "square";return "triangle"}}',
    ],
    [
      'same method',
      'class A { stopped=false; go(){ if(this.stopped)return; tick(); this.stopped=true; } }',
    ],
    [
      'wrong class',
      'class A {stopped=false; set(){this.stopped=true}} class B {work(){if(this.stopped)return;tick()}}',
    ],
    ['no declaration', 'class A {' + gate + ' set(){this.stopped=true}}'],
    [
      'unsupported destinations and ownership',
      klass(
        'let stopped=false; stopped=true; other.stopped=true; this.stopped=!this.stopped; let x=()=>{this.stopped=true};',
      ),
    ],
    [
      'unsupported for-of inside cleanup',
      klass(
        'try {for(const v of xs)this.stopped=false;} finally{later(()=>{this.stopped=false});}',
      ),
    ],
    [
      'computed alias',
      'class W { stopped=false; ["stopped"]=false; ' +
        gate +
        ' set(){this.stopped=true}}',
    ],
    [
      'decorated declaration',
      'class W { @log stopped=false; ' + gate + ' set(){this.stopped=true}}',
    ],
    [
      'parameter property',
      'class W { stopped=false; constructor(public stopped:boolean){} ' +
        gate +
        ' set(){this.stopped=true}}',
    ],
    ['incidental name', klass('this.ascii=false;')],
  ])('rejects %s', (_, code) => expect(writes(code)).toEqual([]));
  it('rejects a presentation selector even when its alternative calls a formatter', () => {
    const source = 'class Preview {running=false; seed(){this.running=true;} caption(){if(this.running)return "active";return this.formatIdle();}}';
    expect(writes(source)).toEqual([]);
    expect(writes(source + '\nfunction keep(){let state;state="ready"}').map(w => w.ownerKey)).toEqual(['keep']);
  });
  it('accepts a braced resolved-promise exit and rejects a computed or optional call', () => {
    const source = 'class Pool { dead=false; stop(){this.dead=true;} parse(){if(this.dead){note();return Promise.resolve(null);} return new Promise(work);} }';
    expect(writes(source).map(w => w.slotName)).toEqual(['dead']);
    for (const call of ['Promise["resolve"](null)', 'Promise.resolve?.(null)', 'formatDisabled()']) {
      expect(writes(source.replace('Promise.resolve(null)', call))).toEqual([]);
    }
  });
  it('permits grammar trivia and keeps a write after an earlier statement unknown', () => {
    const code = klass(
      'if (this.stopped === false) { touch(); this /*a*/ . /*b*/ stopped /*c*/ = /*d*/ true; }',
    );
    const [site] = writes(code);
    expect(site.observed.to).toEqual({ kind: 'boolean', value: true });
    expect(site.inferred.from).toBe('unknown');
    expect(slice(code, site.observed.assignment)).toBe(
      'this /*a*/ . /*b*/ stopped /*c*/ = /*d*/ true',
    );
  });
  it('preserves the string prefix and structural symbols when boolean analysis reaches the write cap', () => {
    const result = parsed(
      klass('this.stopped=true;'.repeat(258) + 'this.status="legacy";'),
    );
    expect(result.entities.some((e) => e.name === 'set')).toBe(true);
    expect(result.behavior).toMatchObject({
      coverage: 'partial',
      cutReason: 'writes',
    });
    expect(result.behavior?.writes).toHaveLength(256);
    expect(result.behavior?.writes[0].observed.to).toEqual({
      kind: 'string',
      value: 'legacy',
    });
  });
  it('keeps one slot across methods and preserves legacy string IDs and records', () => {
    const setter = 'if (this.stopped === false) this.status="new";';
    const plain = writes(klass(setter))[0];
    const mixed = writes(
      klass(setter + 'this.stopped=true;').replace(
        /} }$/,
        '} stop(){this.stopped=true;} }',
      ),
    );
    expect(mixed[0]).toEqual(plain);
    expect(ids(mixed[1]).slotId).toBe(ids(mixed[2]).slotId);
    expect(ids(mixed[1]).id).not.toBe(ids(mixed[2]).id);
  });
});
