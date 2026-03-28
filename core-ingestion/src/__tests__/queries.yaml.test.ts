import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { languageFromPath, SupportedLanguages } from '../languages.js';

describe('YAML parsing', () => {
  it('recognizes .yaml and .yml as YAML', () => {
    expect(languageFromPath('/repo/docker-compose.yaml')).toBe(SupportedLanguages.YAML);
    expect(languageFromPath('/repo/docker-compose.yml')).toBe(SupportedLanguages.YAML);
  });

  it('parses nested config keys from .yaml files', () => {
    const result = parseFile(
      '/repo/docker-compose.yaml',
      [
        'services:',
        '  api:',
        '    image: ix/api:latest',
        '    environment:',
        '      PORT: 8090',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.YAML);
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'services',
      kind: 'config_key',
      language: SupportedLanguages.YAML,
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'api',
      kind: 'config_key',
      container: 'services',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'PORT',
      kind: 'config_key',
      container: 'environment',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'docker-compose.yaml',
      dstName: 'services',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'services',
      dstName: 'api',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'environment',
      dstName: 'PORT',
      predicate: 'CONTAINS',
    });
  });

  it('parses list item mappings from .yml files', () => {
    const result = parseFile(
      '/repo/pipeline.yml',
      [
        'jobs:',
        '  - name: build',
        '    image: node:20',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'name',
      kind: 'config_key',
      container: 'jobs',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'image',
      kind: 'config_key',
      container: 'jobs',
    }));
  });
});
