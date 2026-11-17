// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { grammarStatus, isGrammarSupported } from '../index.js';
import { SupportedLanguages } from '../languages.js';
import { OPTIONAL_GRAMMAR_PACKAGES, REQUIRED_GRAMMARS } from './helpers/grammars.js';

// #967: an optional grammar that failed to load used to leave no trace but a
// count of unparsed files. grammarStatus() is what `ix map` and `ix doctor`
// read to name it, so it has to cover every grammar and keep the reason.

/** Formats parsed by hand, with no tree-sitter grammar to report. */
const HAND_PARSED = new Set<string>([
  SupportedLanguages.YAML, SupportedLanguages.Dockerfile, SupportedLanguages.SQL,
  SupportedLanguages.JSON, SupportedLanguages.TOML, SupportedLanguages.Markdown,
  SupportedLanguages.LaTeX, SupportedLanguages.Proto,
]);

describe('grammarStatus', () => {
  const status = grammarStatus();
  const byLanguage = new Map(status.map((s) => [s.language, s]));

  it('lists every language that has a grammar, once, sorted', () => {
    const expected = Object.values(SupportedLanguages).filter((l) => !HAND_PARSED.has(l)).sort();
    expect(status.map((s) => s.language)).toEqual(expected);
  });

  it('reports every required grammar as loaded', () => {
    for (const language of REQUIRED_GRAMMARS) {
      expect(byLanguage.get(language), language).toMatchObject({ loaded: true });
      expect(byLanguage.get(language)?.reason, language).toBeUndefined();
    }
  });

  it('names the package of each optional grammar, and why one did not load', () => {
    for (const [language, pkg] of Object.entries(OPTIONAL_GRAMMAR_PACKAGES)) {
      const entry = byLanguage.get(language);
      expect(entry?.package, language).toBe(pkg);
      if (entry?.loaded) {
        expect(entry.reason, language).toBeUndefined();
      } else {
        // The reason is one line of the import error, never a stack.
        expect(entry?.reason, language).toMatch(/\S/);
        expect(entry?.reason, language).not.toContain('\n');
      }
    }
  });

  it('agrees with isGrammarSupported', () => {
    const samplePath: Partial<Record<string, string>> = { kotlin: 'a.kt', sas: 'a.sas', lua: 'a.lua', css: 'a.css', xml: 'a.xml' };
    for (const [language, path] of Object.entries(samplePath)) {
      expect(byLanguage.get(language)?.loaded, language).toBe(isGrammarSupported(path!));
    }
  });
});
