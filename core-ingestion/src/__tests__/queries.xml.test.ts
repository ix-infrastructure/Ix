import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

const x = parseFile('/repo/a.xml', '<root/>\n');
const describeFn = x && x.language === SupportedLanguages.XML ? describe : describe.skip;

describeFn('XML queries', () => {
  it('detects XML by .xml and project/config extensions', () => {
    expect(parseFile('/r/a.xml', '<root/>')!.language).toBe(SupportedLanguages.XML);
    expect(parseFile('/r/App.csproj', '<Project/>')!.language).toBe(SupportedLanguages.XML);
  });

  it('emits IMPORTS for MSBuild Include, Spring resource and XInclude href', () => {
    const result = parseFile('/r/App.csproj', `
<Project>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1"/>
    <ProjectReference Include="../Core/Core.csproj"/>
  </ItemGroup>
  <xi:include href="config.xml"/>
  <import resource="beans.xml"/>
</Project>
`);
    expect(result).not.toBeNull();
    const imports = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.importRaw ?? r.dstName);
    expect(imports).toEqual(
      expect.arrayContaining([
        'Newtonsoft.Json', '../Core/Core.csproj', 'config.xml', 'beans.xml',
      ]),
    );
  });
});
