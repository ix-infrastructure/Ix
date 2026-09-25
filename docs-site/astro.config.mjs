// Copyright 2026 Ix Infrastructure Inc.

import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightOpenAPI, { createOpenAPISidebarGroup } from 'starlight-openapi'

const apiSidebarGroup = createOpenAPISidebarGroup()

export default defineConfig({
  site: 'https://docs.ix-infra.com',
  integrations: [
    starlight({
      title: 'Ix Docs',
      description: 'Documentation for Ix, the persistent codebase graph for humans and AI agents.',
      logo: {
        light: './src/assets/logo-light.png',
        dark: './src/assets/logo-dark.png',
        alt: 'Ix',
      },
      favicon: '/favicon.png',
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.ix-infra.com/og-image.png' } },
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
          items: ['getting-started/introduction', 'getting-started/installation', 'getting-started/quickstart'],
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
          items: ['community/contributing', 'community/security', 'community/support'],
        },
      ],
    }),
  ],
})
