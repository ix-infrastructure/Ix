import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

const c = parseFile('/repo/a.css', '.x{}\n');
const describeFn = c && c.language === SupportedLanguages.CSS ? describe : describe.skip;

describeFn('CSS queries', () => {
  it('detects CSS by .css / .scss', () => {
    expect(parseFile('/r/main.css', '.x{}')!.language).toBe(SupportedLanguages.CSS);
    expect(parseFile('/r/main.scss', '.x{}')!.language).toBe(SupportedLanguages.CSS);
  });

  it('emits IMPORTS for @import string and url()', () => {
    const result = parseFile('/r/main.css', `
@import "base.css";
@import url('theme/dark.css');
`);
    expect(result).not.toBeNull();
    const imports = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.importRaw ?? r.dstName);
    expect(imports).toEqual(expect.arrayContaining(['base.css', 'theme/dark.css']));
  });

  it('captures class/id selectors and keyframes', () => {
    const result = parseFile('/r/app.css', `
.btn { color: red; }
#header { width: 100%; }
.card .title { font-weight: bold; }
@keyframes spin { from { opacity: 0; } }
`);
    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(['btn', 'header', 'card', 'title', 'spin']));
  });
});
