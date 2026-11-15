// Copyright 2026 Ix Infrastructure Inc.

import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightOpenAPI, { createOpenAPISidebarGroup } from 'starlight-openapi'

import { baseLinksPlugin } from './scripts/base-links-plugin.mjs'
import { DOCS_BASE } from './site-base.mjs'

const apiSidebarGroup = createOpenAPISidebarGroup()

export default defineConfig({
  site: 'https://docs.ix-infra.com',
  // Served at docs.ix-infra.com/oss/.
  // Astro does not nest the output under the base, so it is built into
  // dist/oss/ and dist/ stays the root of the domain (scripts/finalize-dist.mjs).
  base: DOCS_BASE,
  outDir: `./dist${DOCS_BASE}`,
  markdown: {
    processor: satteri({ mdastPlugins: [baseLinksPlugin(DOCS_BASE)] }),
  },
  integrations: [
    starlight({
      title: 'Ix Docs',
      description: 'Documentation for Ix, the persistent codebase graph for humans and AI agents.',
      components: {
        // ix-infra.com's look: its wordmark in the header, and dark only.
        SiteTitle: './src/components/SiteTitle.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      favicon: '/favicon.png',
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `https://docs.ix-infra.com${DOCS_BASE}/og-image.png` } },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ix-infrastructure/Ix' },
        { icon: 'discord', label: 'Discord', href: 'https://discord.gg/ncEYVHVqZ8' },
      ],
      editLink: {
        baseUrl: 'https://github.com/ix-infrastructure/Ix/edit/main/docs-site/',
      },
      lastUpdated: true,
      customCss: ['@fontsource-variable/inter', './src/styles/theme.css'],
      plugins: [
        starlightOpenAPI([
          {
            base: 'api/endpoints',
            schema: '../docs/api/openapi.yaml',
            sidebar: { label: 'Endpoints', group: apiSidebarGroup },
          },
        ]),
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Overview', link: '/' },
            'getting-started/introduction',
            'getting-started/installation',
            'getting-started/quickstart',
          ],
        },
        {
          label: 'Concepts',
          items: ['concepts/how-it-works', 'concepts/output-formats'],
        },
        {
          label: 'Guides',
          items: ['guides/everyday-workflows', 'guides/compass', 'guides/troubleshooting'],
        },
        {
          label: 'AI agents',
          items: ['integrations/overview', 'integrations/mcp', 'integrations/agent-skill', 'integrations/plugins'],
        },
        {
          label: 'Reference',
          items: [
            'reference/commands',
            'reference/flags',
            'reference/llm-format',
            'reference/configuration',
            'reference/languages',
          ],
        },
        {
          label: 'HTTP API',
          items: ['api/overview', apiSidebarGroup, 'api/reference'],
        },
        {
          label: 'Community',
          items: ['community/contributing', 'community/adding-a-language', 'community/security', 'community/support'],
        },
      ],
    }),
  ],
})
