// Copyright 2026 Ix Infrastructure Inc.

// Copies reference pages that already live elsewhere in the repo into the docs
// content tree, so the site renders them without keeping a second copy that can
// drift. The outputs are generated and gitignored; edit the sources instead.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(siteRoot, '..')
const contentDir = join(siteRoot, 'src/content/docs')
const repoBlobUrl = 'https://github.com/ix-infrastructure/Ix/blob/main'

// Repo files that are pages on this site, keyed by repo-relative path.
const SITE_PAGES = {
  'skills/ix/references/commands.md': '/reference/commands/',
  'skills/ix/references/flags.md': '/reference/flags/',
  'skills/ix/references/output-formats.md': '/concepts/output-formats/',
  'skills/ix/references/troubleshooting.md': '/guides/troubleshooting/',
  'docs/llm-format.md': '/reference/llm-format/',
  'docs/mcp.md': '/integrations/mcp/',
  'docs/api/README.md': '/api/reference/',
}

const PAGES = [
  {
    source: 'skills/ix/references/flags.md',
    out: 'reference/flags.md',
    title: 'Flag reference',
    description: 'Every ix command, its options, accepted values and defaults.',
    // The source's opening is addressed to agents loading the skill.
    intro:
      'Every flag the open-source CLI registers, command by command. For which command answers which question, ' +
      'start with the [command reference](/reference/commands/). `ix <command> --help` prints the same flags from ' +
      'the CLI.\n\nThis page is generated from the registered command tree, so it matches what the CLI accepts.',
  },
  {
    source: 'docs/llm-format.md',
    out: 'reference/llm-format.md',
    title: 'The llm output format',
    description: 'The token-minimal, line-oriented format ix prints for agents.',
  },
  {
    source: 'docs/api/README.md',
    out: 'api/reference.md',
    title: 'Full API reference',
    description: 'Every backend endpoint by area, with data models, errors, timeouts and versioning.',
    // Starlight renders its own table of contents.
    dropSections: ['Table of Contents'],
  },
]

// A relative link in a source file points at another repo file: link to its
// page here if it has one, otherwise to the file on GitHub.
function rewriteLinks(body, source) {
  return body.replace(/\]\((?!https?:|#|\/)([^)\s#]+)(#[^)\s]*)?\)/g, (match, target, hash = '') => {
    const repoPath = posix.normalize(posix.join(posix.dirname(source), target))
    if (repoPath.startsWith('..')) return match
    return SITE_PAGES[repoPath] ? `](${SITE_PAGES[repoPath]}${hash})` : `](${repoBlobUrl}/${repoPath}${hash})`
  })
}

function dropSection(body, heading) {
  const pattern = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=^## )`, 'm')
  return body.replace(pattern, '')
}

for (const page of PAGES) {
  let body = readFileSync(join(repoRoot, page.source), 'utf8')
    // The page title comes from frontmatter; drop the source's own H1.
    .replace(/^# .*\n+/, '')

  if (page.intro) body = `${page.intro}\n\n${body.slice(body.search(/^## /m))}`
  for (const heading of page.dropSections ?? []) body = dropSection(body, heading)
  body = rewriteLinks(body, page.source)

  const editUrl = `https://github.com/ix-infrastructure/Ix/edit/main/${page.source}`
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `editUrl: ${JSON.stringify(editUrl)}`,
    '---',
    '',
    `<!-- Generated from ${page.source} by scripts/sync-reference.mjs. Edit that file instead. -->`,
    '',
  ].join('\n')

  const outPath = join(contentDir, page.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, frontmatter + body)
}
