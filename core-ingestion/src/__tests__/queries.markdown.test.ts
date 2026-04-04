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

  it('parent section spans full subtree including nested headings', () => {
    // H1 section should extend to EOF (no sibling H1), spanning all 4 lines.
    // H2 section should extend to EOF as well (no next H2 or H1 after it).
    const source = ['# Title', 'intro text', '## Install', 'install steps'].join('\n');
    const result = parseFile('/repo/README.md', source);

    expect(result).not.toBeNull();
    const titleSection = result!.chunks.find(c => c.name === 'Title' && c.chunkKind === 'section');
    const installSection = result!.chunks.find(c => c.name === 'Install' && c.chunkKind === 'section');

    expect(titleSection).toBeDefined();
    expect(installSection).toBeDefined();

    // Title (H1) section must span to end of file — it has no sibling H1 after it
    expect(titleSection!.lineEnd).toBe(4);
    // Install (H2) section spans to end of file
    expect(installSection!.lineEnd).toBe(4);

    // Title section must start before Install section
    expect(titleSection!.lineStart).toBeLessThan(installSection!.lineStart);
    // Title section must end no earlier than Install section
    expect(titleSection!.lineEnd).toBeGreaterThanOrEqual(installSection!.lineEnd);
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

  it('strips VitePress anchor ID suffix {#...} from heading names', () => {
    const result = parseFile('/repo/docs.md', '## What is Vue? {#what-is-vue}');
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'What is Vue?', kind: 'heading' }));
  });

  it('preserves component names inside backticks when heading contains angle brackets', () => {
    const result = parseFile('/repo/docs.md', '## `<Transition>` {#transition}');
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: '<Transition>', kind: 'heading' }));
  });

  it('handles backslash-escaped angle brackets in heading names', () => {
    const result = parseFile('/repo/docs.md', '# \\<script setup> {#script-setup}');
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: '<script setup>', kind: 'heading' }));
  });

  it('strips backtick delimiters and VitePress stability markers', () => {
    const result = parseFile('/repo/docs.md', '### `ref()` \\*\\* {#ref}');
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'ref()', kind: 'heading' }));
  });

  it('strips inline HTML badges and normalizes whitespace', () => {
    const result = parseFile(
      '/repo/docs.md',
      '## app.onUnmount() <sup class="vt-badge" data-text="3.5+" /> {#app-onunmount}',
    );
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'app.onUnmount()', kind: 'heading' }));
  });

  it('handles component names in backticks combined with inline HTML badges', () => {
    const result = parseFile(
      '/repo/docs.md',
      '## `<Suspense>` <sup class="vt-badge experimental" /> {#suspense}',
    );
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: '<Suspense>', kind: 'heading' }));
  });

  // Bug 1: frontmatter + no headings
  it('produces file_body chunk for body content when file has frontmatter but no headings', () => {
    const result = parseFile(
      '/repo/post.md',
      ['---', 'title: Hello', '---', '', 'Some body content.'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.chunks).toContainEqual(expect.objectContaining({ chunkKind: 'frontmatter' }));
    expect(result!.chunks).toContainEqual(expect.objectContaining({ chunkKind: 'file_body' }));
  });

  // Bug 2: setext headings
  it('parses setext h1 headings (=== underline)', () => {
    const result = parseFile(
      '/repo/README.md',
      ['My Project', '==========', '', 'Some text.'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'My Project',
      kind: 'heading',
    }));
  });

  it('parses setext h2 headings (--- underline)', () => {
    const result = parseFile(
      '/repo/README.md',
      ['Overview', '--------', '', 'Details.'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Overview',
      kind: 'heading',
    }));
  });

  it('nests setext heading under a preceding ATX heading', () => {
    const result = parseFile(
      '/repo/README.md',
      ['# Guide', '', 'Installation', '------------'].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Installation',
      kind: 'heading',
      container: 'Guide',
    }));
  });

  it('does not parse setext underline inside a fenced code block', () => {
    const result = parseFile(
      '/repo/README.md',
      ['# Real', '```', 'not a heading', '=============', '```'].join('\n'),
    );

    const headings = result!.entities.filter(e => e.kind === 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].name).toBe('Real');
  });

  // Bug 3: fenced code block delimiter matching
  it('does not close a backtick fence with a tilde line', () => {
    const result = parseFile(
      '/repo/README.md',
      ['# Real', '```', '~~~', '# Not A Heading', '~~~', '```'].join('\n'),
    );

    const headings = result!.entities.filter(e => e.kind === 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].name).toBe('Real');
  });

  it('does not close a tilde fence with a backtick line', () => {
    const result = parseFile(
      '/repo/README.md',
      ['# Real', '~~~', '```', '# Not A Heading', '```', '~~~'].join('\n'),
    );

    const headings = result!.entities.filter(e => e.kind === 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].name).toBe('Real');
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
