import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { languageFromPath, SupportedLanguages } from '../languages.js';

describe('Markdown parsing', () => {
  it('recognizes .md and .markdown extensions', () => {
    expect(languageFromPath('/repo/README.md')).toBe(SupportedLanguages.Markdown);
    expect(languageFromPath('/repo/guide.markdown')).toBe(SupportedLanguages.Markdown);
  });

  it('parses a single top-level heading', () => {
    const result = parseFile('/repo/README.md', '# Getting Started\n\nSome text here.');

    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.Markdown);
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Getting Started',
      kind: 'heading',
      language: SupportedLanguages.Markdown,
      container: undefined,
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'README.md',
      dstName: 'Getting Started',
      predicate: 'CONTAINS',
    });
  });

  it('nests h2 headings under the nearest h1', () => {
    const result = parseFile(
      '/repo/README.md',
      ['# Title', '## Installation', '## Usage'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Installation',
      kind: 'heading',
      container: 'Title',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Usage',
      kind: 'heading',
      container: 'Title',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'Title',
      dstName: 'Installation',
      predicate: 'CONTAINS',
    });
  });

  it('nests h3 under h2, not h1', () => {
    const result = parseFile(
      '/repo/docs.md',
      ['# Guide', '## Setup', '### Prerequisites'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Prerequisites',
      kind: 'heading',
      container: 'Setup',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'Setup',
      dstName: 'Prerequisites',
      predicate: 'CONTAINS',
    });
  });

  it('resets heading scope when a higher-level heading appears', () => {
    const result = parseFile(
      '/repo/docs.md',
      ['# Part One', '## Chapter A', '# Part Two', '## Chapter B'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Chapter A',
      container: 'Part One',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Chapter B',
      container: 'Part Two',
    }));
  });

  it('emits section chunks for each heading', () => {
    const result = parseFile(
      '/repo/README.md',
      ['# Title', 'intro text', '## Install', 'install steps'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.chunks).toContainEqual(expect.objectContaining({
      name: 'Title',
      chunkKind: 'section',
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(result!.chunks).toContainEqual(expect.objectContaining({
      name: 'Install',
      chunkKind: 'section',
    }));
  });

  it('parses YAML frontmatter', () => {
    const result = parseFile(
      '/repo/post.md',
      ['---', 'title: Hello', 'date: 2024-01-01', '---', '# Content'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'frontmatter',
      kind: 'frontmatter',
    }));
    expect(result!.chunks).toContainEqual(expect.objectContaining({
      name: 'frontmatter',
      chunkKind: 'frontmatter',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'post.md',
      dstName: 'frontmatter',
      predicate: 'CONTAINS',
    });
    // Heading after frontmatter still parsed
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Content',
      kind: 'heading',
    }));
  });

  it('skips headings inside fenced code blocks', () => {
    const result = parseFile(
      '/repo/README.md',
      ['# Real Heading', '```', '# Not A Heading', '```'].join('\n'),
    );

    expect(result).not.toBeNull();
    const headings = result!.entities.filter(e => e.kind === 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].name).toBe('Real Heading');
  });

  it('produces file_body chunk for files with no headings', () => {
    const result = parseFile('/repo/notes.md', 'Just some plain text.\nNo headings here.');

    expect(result).not.toBeNull();
    expect(result!.chunks).toHaveLength(1);
    expect(result!.chunks[0].chunkKind).toBe('file_body');
  });

  it('produces file_body chunk for empty file', () => {
    const result = parseFile('/repo/empty.md', '');

    expect(result).not.toBeNull();
    expect(result!.chunks).toHaveLength(1);
    expect(result!.chunks[0].chunkKind).toBe('file_body');
  });

  it('handles ATX headings with closing hashes', () => {
    const result = parseFile('/repo/README.md', '## Section ##\nContent.');

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Section',
      kind: 'heading',
    }));
  });

  it('parses single-line HTML headings commonly used in docs', () => {
    const result = parseFile(
      '/repo/docs.md',
      ['<h1 align="center">Fastify</h1>', '', '## Routes'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Fastify',
      kind: 'heading',
      container: undefined,
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Routes',
      kind: 'heading',
      container: 'Fastify',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'docs.md',
      dstName: 'Fastify',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Fastify',
      dstName: 'Routes',
      predicate: 'CONTAINS',
    });
  });
});
