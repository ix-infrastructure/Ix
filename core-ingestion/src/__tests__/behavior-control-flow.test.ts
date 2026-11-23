// Copyright 2026 Ix Infrastructure Inc.
import { describe, expect, it } from 'vitest';
import { parseFile, bindBehaviorIds } from '../index.js';
import { flowCases } from './fixtures/behavior-control-flow-cases.js';
import type { BehaviorSpan } from '../schema.js';

function decodeMarks(marked: string) {
  let source = '', offset = 0;
  const starts = new Map<string, number>();
  const spans = new Map<string, BehaviorSpan>();
  const position = (index: number): [number, number] => {
    const lines = source.slice(0, index).split('\n');
    return [lines.length, lines.at(-1)!.length];
  };
  for (const m of marked.matchAll(/«(\/?)(\w+)»/gu)) {
    source += marked.slice(offset, m.index);
    if (m[1]) spans.set(m[2], [...position(starts.get(m[2])!), ...position(source.length)]);
    else starts.set(m[2], source.length);
    offset = m.index + m[0].length;
  }
  source += marked.slice(offset);
  function text(name: string) {
    const [a,b,c,d] = spans.get(name)!;
    const lines = source.split('\n').slice(a-1,c);
    lines[lines.length-1] = lines.at(-1)!.slice(0,d);
    lines[0] = lines[0].slice(b);
    return lines.join('\n');
  }
  return {source, spans, text};
}
describe.each(['ts','tsx','js','jsx'])('control-flow oracle .%s', ext => {
  it.each(flowCases)('$id', sample => {
    const {source, spans, text} = decodeMarks(sample.marked);
    const result = parseFile('task.'+ext, source)!;
    expect(result.hasParseErrors).toBeFalsy();
    const actual = result.behavior?.writes ?? [];
    expect(actual).toHaveLength(sample.sites.length);
    if (actual.length) expect(result.behavior!.coverage).toBe('complete');
    for (const label of sample.sites) {
      const w = actual.find(w => String(w.observed.assignment) === String(spans.get(label.assignment)))!;
      expect([w.ownerKey,w.slotName,w.observed.to]).toEqual([sample.owner,label.slot,{kind:typeof label.to,value:label.to}]);
      expect(w.inferred.from).toEqual(label.prior === null ? 'unknown' : {kind:typeof label.prior, value:label.prior});
      expect(w.observed.guards.map(g => [g.expression,g.span,g.arm])).toEqual(label.guards.map(([k,arm])=>[text(k),spans.get(k),arm]));
      expect(w.observed.controlFlow).toEqual(label.frames.map(f => ({
        kind:f.kind, span:spans.get(f.construct),body:spans.get(f.body),guardDepth:f.guardDepth,
        ...(f.kind==='try' ? {arm:f.arm,form:f.form} : {header:spans.get(f.header!),headerKey:expect.stringMatching(/^[a-f0-9]{64}$/),
          test:f.test ? {expression:text(f.test),span:spans.get(f.test)} : null}),
      })));
    }
  });
});
it('separates nested identities from flat writes, and ignores coordinates and header trivia', () => {
  const code='class Job { go(){while(active) this.state="x"; this.state="x"; try{}finally{this.state="x";}}}';
  const ids = (s:string) => parseFile('job.ts',s)!.behavior!.writes.map(w=>bindBehaviorIds(w,k=>k).id);
  const initial = ids(code);
  expect(new Set(initial).size).toBe(3);
  expect(ids('\n'+code.replace('(active)','( /* why */ active )'))).toEqual(initial);
  expect(ids(code.replace('while(active) this.state="x";',''))).toEqual([initial[0],initial[2]]);
  expect(ids(code.replace('active','other'))[1]).not.toBe(initial[1]);
});
it('retains flat evidence when a nested header or depth exhausts the optional budget', () => {
  for(const stmt of ['while('+'x'.repeat(1030)+')this.state="nested";','while(ok){'.repeat(40)+'this.state="nested";'+'}'.repeat(40)]){
    const r=parseFile('x.ts','class A{go(){'+stmt+' this.status="flat";}}')!;
    expect(r.behavior).toMatchObject({coverage:'partial', writes:[{observed:{controlFlow:[],to:{value:'flat'}}}]});
    expect(r.entities.some(e=>e.name==='go')).toBe(true);
  }
});

import { formerFlowExclusions } from './fixtures/behavior-cases.js';
it.each(formerFlowExclusions)('recovers the formerly excluded string write in %s', source => {
  const writes = parseFile('task.ts', source)?.behavior?.writes;
  expect(writes).toHaveLength(1);
  expect(writes![0].observed.to).toEqual({kind:'string', value:'x'});
  expect(writes![0].observed.controlFlow).toHaveLength(1);
});
