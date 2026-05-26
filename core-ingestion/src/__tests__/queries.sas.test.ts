import { describe, it, expect } from 'vitest';
import { parseFile, buildGlobalResolutionIndex } from '../index.js';
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

  // SPF production style — inline block comments in parameter lists
  it('captures macro with trailing inline block comment on parameter (Mode 1)', () => {
    const result = parseFile('/repo/loadpackage.sas', `
%macro loadPackage(
  packageName /* name of a package */
, path = %sysfunc(pathname(packages)) /* location of a package */
, options = %str(LOWCASE_MEMNAME)     /* possible options */
);
%mend loadPackage;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'loadPackage', kind: 'macro' }),
    );
  });

  it('captures macro with multi-line inline block comment on parameter (Mode 1 multi-line)', () => {
    const result = parseFile('/repo/spf.sas', `
%macro installPackage(
  packagesNames /* space separated list of packages names,
                   without the zip extension */
, sourcePath =  /* location of the package,
                   e.g. "www.some.page/", mind the "/" at the end */
);
%mend installPackage;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'installPackage', kind: 'macro' }),
    );
  });

  it('captures macro with block comment as default value (Mode 2)', () => {
    const result = parseFile('/repo/spf.sas', `
%macro loadPackage(
  source2 = /*source2*/ /* option to print out details */
);
%mend loadPackage;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'loadPackage', kind: 'macro' }),
    );
  });

  it('captures macro with standalone block comment between parameters (Mode 3)', () => {
    const result = parseFile('/repo/generatepackage.sas', `
%macro generatePackage(
  filesLocation   /* location of package files */
, buildLocation=  /* location of package ZIP file */
/* testing options: */
, testPackage=Y   /* indicator if tests should be executed */
, packages=       /* location of other packages */
);
%mend generatePackage;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'generatePackage', kind: 'macro' }),
    );
  });

  it('captures macro with /options and des= clause (Mode 4)', () => {
    const result = parseFile('/repo/spfinit.sas', `
%macro SPFinit_intrnl_forceV7DSname(
  mcParam /* name of a macro parameter */
)/secure minoperator
des='SAS Packages Framework internal macro.';
%mend SPFinit_intrnl_forceV7DSname;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'SPFinit_intrnl_forceV7DSname', kind: 'macro' }),
    );
  });

  // Bug 1 regression — fileref %INCLUDE forms (82% of production SAS uses these, not string literals)
  it('emits IMPORTS for %INCLUDE with fileref(member) syntax', () => {
    const result = parseFile('/repo/main.sas', `
%include PROGRMS(IQI_HOSP_FORMATS.SAS);
`);
    expect(result).not.toBeNull();
    // normalizeCapturedImport extracts the member name from FILEREF(member)
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'IQI_HOSP_FORMATS.SAS' }),
    );
  });

  it('emits IMPORTS for %INCLUDE with bare fileref syntax', () => {
    const result = parseFile('/repo/main.sas', `
%include MacLib;
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'MacLib' }),
    );
  });

  it('emits IMPORTS for %INCLUDE fileref(member) with lowercase extension', () => {
    const result = parseFile('/repo/main.sas', `
%include MacLib(MHI_MEASURES_macro.sas);
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'MHI_MEASURES_macro.sas' }),
    );
  });

  // Bug 2 regression — indented %MACRO definitions must be indexed for cross-file resolution
  it('indexes indented %MACRO definitions for cross-file macro resolution', () => {
    const sources = new Map([
      ['/repo/macros.sas', ' %MACRO MDX(FMT);\n  %put &FMT;\n %MEND MDX;\n\n %MACRO MDX1(FMT);\n %MEND MDX1;\n'],
    ]);
    const index = buildGlobalResolutionIndex(['/repo/macros.sas'], sources);
    expect(index.symbolToFiles.get('MDX')).toContain('/repo/macros.sas');
    expect(index.symbolToFiles.get('MDX1')).toContain('/repo/macros.sas');
  });

  it('does not index column-0-only when macros are indented (confirms old regex was broken)', () => {
    const brokenRe = /^%macro\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[(/;]/gim;
    const fixedRe  = /^\s*%macro\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[(/;]/gim;
    const src = ' %MACRO MDX(FMT);\n %MEND MDX;\n';
    expect(src.match(brokenRe)).toBeNull();
    expect(src.match(fixedRe)).not.toBeNull();
  });

  // v0.3.6 fix #1 — &var.suffix macro references parsed as one token; previously
  // &dsname. stopped at the dot leaving the suffix as a stray identifier that could
  // corrupt surrounding parse nodes.
  it('captures DATA step whose name is a macro variable reference with dot-suffix', () => {
    const result = parseFile('/repo/datastep.sas', `
data &filesWithCodes.addCnt;
  set &dsname.base;
run;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: '&filesWithCodes.addCnt', kind: 'module' }),
    );
  });

  // v0.3.6 fix #2 — %" inside double-quoted strings does not close the string early
  it('parses double-quoted string containing %" without breaking', () => {
    const result = parseFile('/repo/labels.sas', `
%macro addLabel;
  title "value is %str(%'%")";
%mend addLabel;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'addLabel', kind: 'macro' }),
    );
  });

  // v0.3.6 fix #3 — '' escape inside single-quoted strings not consumed by %' pattern
  it('parses single-quoted string with escaped quote without cascade failure', () => {
    const result = parseFile('/repo/generatepackage.sas', `
%macro generatePackage(
  filesLocation
, buildLocation=
, testPackage=Y
, packages=
);
  data _null_;
    x = 'it''s fine';
    y = 'another ''quoted'' value';
  run;
%mend generatePackage;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'generatePackage', kind: 'macro' }),
    );
  });

  // v0.4.2 fix #1 — parenthesized macro-expression body without a trailing semicolon
  it('captures macro definition with paren-led expression body', () => {
    const result = parseFile('/repo/iqi.sas', `
%MACRO MDX1(FMT);
 ((put(DX1,&FMT.) = '1'))
%MEND;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'MDX1', kind: 'macro' }),
    );
  });

  // v0.4.2 fix #2 — %DO/%END used inside a parenthesized expression generator
  it('captures macro definition with %DO loop inside parenthesized expression body', () => {
    const result = parseFile('/repo/iqi.sas', `
%MACRO MDX(FMT);
 (%DO I = 1 %TO &NDX.-1;
  (put(DX&I.,&FMT.) = '1') or
  %END;
  (put(DX&NDX.,&FMT.) = '1'))
%MEND;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'MDX', kind: 'macro' }),
    );
  });

  // v0.4.2 fix #3 — final body item can end immediately before %MEND
  it('captures macro definition whose body ends without semicolon before %MEND', () => {
    const result = parseFile('/repo/iqi.sas', `
%MACRO MDX2Q2(FMT);
 result = 0;
 if result = 1
%MEND;
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'MDX2Q2', kind: 'macro' }),
    );
  });
});
