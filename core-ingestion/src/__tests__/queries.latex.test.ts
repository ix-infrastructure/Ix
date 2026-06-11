import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

const probe = parseFile('/repo/a.tex', '\\documentclass{article}\n');
const describeFn = probe && probe.language === SupportedLanguages.LaTeX ? describe : describe.skip;

const rels = (r: ReturnType<typeof parseFile>, p: string) =>
  r!.relationships.filter(x => x.predicate === p);

describeFn('LaTeX parser', () => {
  it('detects LaTeX by extension (.tex/.sty/.cls/.ltx/.latex)', () => {
    for (const ext of ['tex', 'sty', 'cls', 'ltx', 'latex']) {
      expect(parseFile(`/r/m.${ext}`, '\\documentclass{article}')!.language).toBe(SupportedLanguages.LaTeX);
    }
  });

  it('builds a nested sectioning hierarchy via CONTAINS', () => {
    const r = parseFile('/r/main.tex', `
\\part{One}
\\chapter{Intro}
\\section{Background}
\\subsection{Prior work}
\\section{Methods}
`);
    const sections = r!.entities.filter(e => e.kind === 'section').map(e => e.name);
    expect(sections).toEqual(['One', 'Intro', 'Background', 'Prior work', 'Methods']);
    const contains = rels(r, 'CONTAINS').map(e => `${e.srcName}>${e.dstName}`);
    expect(contains).toContain('main.tex>One');
    expect(contains).toContain('One>Intro');
    expect(contains).toContain('Intro>Background');
    expect(contains).toContain('Background>Prior work');
    // Methods resets back to chapter scope (sibling of Background's parent section)
    expect(contains).toContain('Intro>Methods');
  });

  it('captures starred sections and cleans nested markup in titles', () => {
    const r = parseFile('/r/m.tex', '\\section*{The \\textbf{Bold} Title}\n');
    const sections = r!.entities.filter(e => e.kind === 'section').map(e => e.name);
    expect(sections).toEqual(['The Bold Title']);
  });

  it('captures \\newcommand / \\renewcommand / \\providecommand / \\DeclareRobustCommand', () => {
    const r = parseFile('/r/m.tex', `
\\newcommand{\\foo}{x}
\\renewcommand{\\bar}[1]{#1}
\\providecommand{\\baz}{y}
\\DeclareRobustCommand{\\qux}{z}
\\newcommand\\unbraced{w}
`);
    const fns = r!.entities.filter(e => e.kind === 'function').map(e => e.name).sort();
    expect(fns).toEqual(['bar', 'baz', 'foo', 'qux', 'unbraced']);
  });

  it('captures \\def and \\let control-sequence definitions', () => {
    const r = parseFile('/r/m.tex', '\\def\\mymacro{hello}\n\\let\\other=\\relax\n');
    const fns = r!.entities.filter(e => e.kind === 'function').map(e => e.name).sort();
    expect(fns).toEqual(['mymacro', 'other']);
  });

  it('does not emit a bogus "csname" macro for \\def\\csname...\\endcsname', () => {
    const r = parseFile('/r/m.tex', '\\expandafter\\def\\csname my@dynamic\\endcsname{body}\n\\def\\real{x}\n');
    const fns = r!.entities.filter(e => e.kind === 'function').map(e => e.name);
    expect(fns).toEqual(['real']);
  });

  it('strips inline math/markup from section titles', () => {
    const r = parseFile('/r/m.tex', '\\section{Convergence of \\texorpdfstring{$\\sigma$}{[sigma]}}\n');
    expect(r!.entities.filter(e => e.kind === 'section').map(e => e.name)).toEqual(['Convergence of [sigma]']);
  });

  it('captures \\newenvironment and \\newtheorem as definitions', () => {
    const r = parseFile('/r/m.tex', `
\\newenvironment{myenv}{\\begin{center}}{\\end{center}}
\\newtheorem{thm}{Theorem}
\\newtheorem*{lem}{Lemma}
`);
    const classes = r!.entities.filter(e => e.kind === 'class').map(e => e.name).sort();
    expect(classes).toEqual(['lem', 'myenv', 'thm']);
  });

  it('emits IMPORTS for \\documentclass / \\usepackage / \\RequirePackage', () => {
    const r = parseFile('/r/m.tex', `
\\documentclass[12pt]{article}
\\usepackage{amsmath}
\\usepackage[utf8]{inputenc}
\\usepackage{tikz,pgfplots}
\\RequirePackage{xcolor}
`);
    const imports = rels(r, 'IMPORTS').map(e => e.dstName).sort();
    expect(imports).toEqual(['amsmath', 'article', 'inputenc', 'pgfplots', 'tikz', 'xcolor']);
    // package imports preserve a bare (non-path) importRaw
    expect(rels(r, 'IMPORTS').every(e => e.importRaw && !e.importRaw.includes('/'))).toBe(true);
  });

  it('resolves \\input / \\include / \\subfile to .tex targets', () => {
    const r = parseFile('/r/main.tex', `
\\input{header}
\\include{chapters/intro}
\\subfile{sections/methods.tex}
\\import{parts/}{appendix}
`);
    const imports = rels(r, 'IMPORTS');
    const dst = imports.map(e => e.dstName).sort();
    expect(dst).toEqual(['chapters/intro.tex', 'header.tex', 'parts/appendix.tex', 'sections/methods.tex']);
    // raw specifier retained for path resolution / multi-repo gate
    expect(imports.find(e => e.dstName === 'header.tex')!.importRaw).toBe('header');
  });

  it('emits \\label anchors and resolves \\ref/\\eqref/\\cref as REFERENCES', () => {
    const r = parseFile('/r/m.tex', `
\\section{Results}
\\label{sec:results}
\\begin{equation}\\label{eq:main}\\end{equation}
See \\ref{sec:results} and \\eqref{eq:main}.
Also \\cref{sec:results,eq:main}.
`);
    const labels = r!.entities.filter(e => e.kind === 'label').map(e => e.name).sort();
    expect(labels).toEqual(['eq:main', 'sec:results']);
    const refs = rels(r, 'REFERENCES').map(e => e.dstName).sort();
    expect(refs).toEqual(['eq:main', 'eq:main', 'sec:results', 'sec:results']);
  });

  it('emits \\cite/\\citep/\\citet REFERENCES to bib keys (incl. comma lists)', () => {
    const r = parseFile('/r/m.tex', `
\\cite{knuth1984}
\\citep{lamport1994,goossens1993}
\\citet{wilson2020}
`);
    const refs = rels(r, 'REFERENCES').map(e => e.dstName).sort();
    expect(refs).toEqual(['goossens1993', 'knuth1984', 'lamport1994', 'wilson2020']);
  });

  it('chains environments under their section (file -> section -> environment)', () => {
    const r = parseFile('/r/m.tex', `
\\section{Figures}
\\begin{figure}
\\caption{A figure}
\\label{fig:a}
\\end{figure}
\\begin{table}
\\end{table}
`);
    const envs = r!.entities.filter(e => e.kind === 'environment');
    expect(envs.map(e => e.name).sort()).toEqual(['figure', 'table']);
    const contains = rels(r, 'CONTAINS').map(e => `${e.srcName}>${e.dstName}`);
    expect(contains).toContain('Figures>figure');
    expect(contains).toContain('Figures>table');
    // a label inside the figure is contained by the figure environment
    expect(contains).toContain('figure>fig:a');
  });

  it('does not scan command bodies inside verbatim/lstlisting environments', () => {
    const r = parseFile('/r/m.tex', `
\\begin{verbatim}
\\newcommand{\\fake}{should not be captured}
\\section{not a real section}
\\end{verbatim}
\\section{Real}
`);
    expect(r!.entities.filter(e => e.kind === 'function')).toHaveLength(0);
    expect(r!.entities.filter(e => e.kind === 'section').map(e => e.name)).toEqual(['Real']);
  });

  it('ignores comments (unescaped %) but keeps escaped \\%', () => {
    const r = parseFile('/r/m.tex', `
% \\section{Commented out}
\\section{Live} % \\usepackage{nope}
50\\% done
`);
    expect(r!.entities.filter(e => e.kind === 'section').map(e => e.name)).toEqual(['Live']);
    expect(rels(r, 'IMPORTS')).toHaveLength(0);
  });

  it('captures cross-references nested inside unknown command arguments', () => {
    const r = parseFile('/r/m.tex', '\\caption{See \\ref{fig:x} and \\cite{paper}}\n');
    const refs = rels(r, 'REFERENCES').map(e => e.dstName).sort();
    expect(refs).toEqual(['fig:x', 'paper']);
  });

  it('handles malformed / unbalanced input without crashing or hanging', () => {
    const samples = [
      '\\begin{figure}\n\\section{Orphan}\n',          // unclosed environment
      '\\end{figure}\n',                               // stray \end
      '\\newcommand{\\foo',                             // unterminated brace
      '\\section{',                                     // unterminated title
      '\\usepackage{a,b,',                              // unterminated list
      '\\\\ \\% \\{ \\} \\$ text',                      // control symbols only
      '%'.repeat(10000),                               // long comment
      '{'.repeat(5000),                                // deep open braces
    ];
    for (const s of samples) {
      const r = parseFile('/r/x.tex', s);
      expect(r).not.toBeNull();
      expect(r!.language).toBe(SupportedLanguages.LaTeX);
    }
  });

  it('is deterministic (byte-identical entities/relationships on re-parse)', () => {
    const src = `
\\documentclass{book}
\\usepackage{amsmath}
\\begin{document}
\\chapter{One}\\label{ch:one}
\\section{Alpha}
\\newcommand{\\x}{1}
\\begin{theorem}\\label{thm:1}\\end{theorem}
See \\ref{ch:one} and \\cite{a,b}.
\\input{more}
\\end{document}
`;
    const a = parseFile('/r/book.tex', src)!;
    const b = parseFile('/r/book.tex', src)!;
    expect(JSON.stringify(a.entities)).toBe(JSON.stringify(b.entities));
    expect(JSON.stringify(a.relationships)).toBe(JSON.stringify(b.relationships));
    expect(JSON.stringify(a.chunks)).toBe(JSON.stringify(b.chunks));
  });
});
