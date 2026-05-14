import { describe, expect, it } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

describe('SAS queries', () => {
  it('detects language as SAS', () => {
    const result = parseFile('/repo/analysis.sas', `
data work.out; run;
`);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.SAS);
  });

  it('captures macro definition', () => {
    const result = parseFile('/repo/macros.sas', `
%macro greet(name);
  %put Hello &name;
%mend greet;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'macro' }),
    );
  });

  it('captures multiple macro definitions', () => {
    const result = parseFile('/repo/macros.sas', `
%macro clean(ds);
  data &ds; set &ds; run;
%mend clean;

%macro report(ds, title);
  proc print data=&ds; run;
%mend report;
`);
    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['clean', 'report']),
    );
  });

  it('captures DATA step as module', () => {
    const result = parseFile('/repo/datastep.sas', `
data work.results;
  x = 1;
run;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'results', kind: 'module' }),
    );
  });

  it('captures PROC step as module', () => {
    const result = parseFile('/repo/proc.sas', `
proc means data=work.results;
  var age;
run;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'means', kind: 'module' }),
    );
  });

  it('emits CALLS for macro call statements', () => {
    const result = parseFile('/repo/main.sas', `
%macro run_all;
  %clean_data;
%mend run_all;
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'clean_data', predicate: 'CALLS' }),
    );
  });

  it('emits IMPORTS for %include', () => {
    const result = parseFile('/repo/main.sas', `
%include 'utils.sas';
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'utils.sas' }),
    );
  });

  it('emits IMPORTS for libname', () => {
    const result = parseFile('/repo/setup.sas', `
libname clinical 'clinical';
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'clinical' }),
    );
  });

  it('returns null for non-SAS extensions', () => {
    const result = parseFile('/repo/script.unknown', 'data work.out; run;');
    expect(result).toBeNull();
  });
});
