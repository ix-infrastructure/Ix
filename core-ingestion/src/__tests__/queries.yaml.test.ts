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
      kind: 'config_entry',
      language: SupportedLanguages.YAML,
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'api',
      kind: 'config_entry',
      container: 'services',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'PORT',
      kind: 'config_entry',
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
      kind: 'config_entry',
      container: 'jobs',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'image',
      kind: 'config_entry',
      container: 'jobs',
    }));
  });

  it('recognizes Dockerfile names and parses stages plus stage imports', () => {
    expect(languageFromPath('/repo/Dockerfile')).toBe(SupportedLanguages.Dockerfile);
    expect(languageFromPath('/repo/docker/prod.dockerfile')).toBe(SupportedLanguages.Dockerfile);

    const result = parseFile(
      '/repo/Dockerfile',
      [
        'FROM node:20 AS build',
        'WORKDIR /app',
        'COPY package.json ./',
        'RUN npm ci \\',
        '  --omit=dev',
        'FROM nginx:alpine',
        'COPY --from=build /app/dist /usr/share/nginx/html',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.Dockerfile);
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'build',
      kind: 'config',
      language: SupportedLanguages.Dockerfile,
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'node:20',
      kind: 'module',
      container: 'build',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'copy:--from=build',
      kind: 'config_entry',
      container: 'stage-1',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'build',
      dstName: 'node:20',
      predicate: 'IMPORTS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'stage-1',
      dstName: 'build',
      predicate: 'IMPORTS',
    });
    expect(result!.chunks).toContainEqual(expect.objectContaining({
      name: 'run',
      chunkKind: 'docker_instruction',
      lineStart: 4,
      lineEnd: 5,
    }));
  });
});
