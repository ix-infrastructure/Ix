// Copyright 2026 Ix Infrastructure Inc.

// Writes the files that live at the root of the deployed site, above the docs.
//
// The docs are served under /oss/ on docs.ix-infra.com, so this site builds
// into dist/oss/ and dist/ is the root of the domain. `/` redirects to /oss/.
// It is a 302 so no browser caches it past the day a page at the root
// replaces it. The docs' 404 page is copied to the root too, so a
// mistyped URL outside /oss/ still lands on a page with a way back.

import { copyFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOCS_BASE } from '../site-base.mjs'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

await writeFile(join(dist, '_redirects'), `/  ${DOCS_BASE}/  302\n`)
await copyFile(join(dist, DOCS_BASE, '404.html'), join(dist, '404.html'))
