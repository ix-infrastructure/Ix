import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

const h = parseFile('/repo/i.html', '<html></html>\n');
const describeFn = h && h.language === SupportedLanguages.HTML ? describe : describe.skip;

describeFn('HTML queries', () => {
  it('detects language as HTML', () => {
    expect(parseFile('/repo/index.html', '<!DOCTYPE html><html></html>')!.language)
      .toBe(SupportedLanguages.HTML);
  });

  it('emits IMPORTS for script src, link href and anchor/img resources', () => {
    const result = parseFile('/repo/index.html', `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="styles/main.css">
  <script src="js/app.js"></script>
</head>
<body>
  <a href="about.html">About</a>
  <img src="logo.png">
</body>
</html>
`);
    expect(result).not.toBeNull();
    const imports = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.importRaw);
    expect(imports).toEqual(
      expect.arrayContaining(['styles/main.css', 'js/app.js', 'about.html', 'logo.png']),
    );
  });

  it('captures custom elements (web components) as definitions', () => {
    const result = parseFile('/repo/app.html', `
<body>
  <app-root></app-root>
  <my-button label="go"></my-button>
  <div class="plain"></div>
</body>
`);
    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(['app-root', 'my-button']));
    expect(names).not.toContain('div');
  });
});
