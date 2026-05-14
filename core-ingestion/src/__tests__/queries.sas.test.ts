import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

describe('SAS queries', () => {
  it('detects language as SAS', () => {
    const result = parseFile('/repo/analysis.sas', `
data mydata; run;
`);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.SAS);
  });

  it('captures macro definition', () => {
    const result = parseFile('/repo/macros.sas', `
%macro greet(name);
  %put Hello &name.;
%mend greet;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'macro' }),
    );
  });

  it('captures macro definition with no parameters', () => {
    const result = parseFile('/repo/macros.sas', `
%macro setup;
  libname mylib '/data';
%mend setup;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'setup', kind: 'macro' }),
    );
  });

  it('captures multiple macro definitions', () => {
    const result = parseFile('/repo/utils.sas', `
%macro clean(ds);
  proc sort data=&ds.; by id; run;
%mend clean;

%macro summarize(ds, var);
  proc means data=&ds.; var &var.; run;
%mend summarize;
`);
    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['clean', 'summarize']),
    );
  });

  it('emits CALLS for macro call statement', () => {
    const result = parseFile('/repo/main.sas', `
%macro run_all;
  %clean(rawdata);
%mend run_all;
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'clean', predicate: 'CALLS' }),
    );
  });

  it('emits CALLS for inline macro call inside DATA step', () => {
    const result = parseFile('/repo/main.sas', `
data out;
  set %getdata();
run;
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'getdata', predicate: 'CALLS' }),
    );
  });

  it('captures DATA step as module entity', () => {
    const result = parseFile('/repo/datastep.sas', `
data myoutput;
  set myinput;
  keep id name;
run;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'myoutput', kind: 'module' }),
    );
  });

  it('captures PROC step as module entity', () => {
    const result = parseFile('/repo/procs.sas', `
proc means data=mydata;
  var age weight;
run;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'means', kind: 'module' }),
    );
  });

  it('emits IMPORTS for %INCLUDE', () => {
    const result = parseFile('/repo/main.sas', `
%include '/shared/macros/utils.sas';
`);
    expect(result).not.toBeNull();
    // paths are normalized to basename by normalizeCapturedImport
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'utils.sas' }),
    );
  });

  it('emits IMPORTS for LIBNAME path', () => {
    const result = parseFile('/repo/setup.sas', `
libname mylib '/data/project';
`);
    expect(result).not.toBeNull();
    // paths are normalized to basename by normalizeCapturedImport
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'project' }),
    );
  });

  it('captures nested macro definitions', () => {
    const result = parseFile('/repo/nested.sas', `
%macro outer;
  %macro inner;
    %put inner called;
  %mend inner;
  %inner;
%mend outer;
`);
    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['outer', 'inner']),
    );
  });

  it('returns null for non-SAS extensions', () => {
    const result = parseFile('/repo/script.unknown', '%macro foo; %mend foo;');
    expect(result).toBeNull();
  });
});
