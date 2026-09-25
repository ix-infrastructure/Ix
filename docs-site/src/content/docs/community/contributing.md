---
title: Contributing
description: Set up Ix locally, follow the project's conventions and open your first pull request.
---

Issues and pull requests are welcome. This page summarizes
[CONTRIBUTING.md](https://github.com/ix-infrastructure/Ix/blob/main/CONTRIBUTING.md), the authoritative guide.

## Local setup

You need Node.js 22+ and Docker with Docker Compose.

```bash
git clone https://github.com/ix-infrastructure/Ix.git
cd Ix
./scripts/backend.sh up           # start ArangoDB + the memory layer in Docker
cd ix-cli && npm ci && npm run build
npm test                          # verify your setup
```

You don't need the backend source. The CLI is developed against the published backend image
(`ghcr.io/ix-infrastructure/ix-memory-layer`), which anyone can pull. If a change needs something new from the
backend, open an issue describing what the CLI needs, and a maintainer will carry it across.

## Workflow

1. Branch from `main` with a prefix: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `ci/` or `chore/`.
2. Make your change and run the tests (`cd ix-cli && npm test`).
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:` and so
   on). Use `feat!:` or `fix!:` for breaking changes.
4. Open a pull request using the template, and make sure CI passes.

## Conventions

- **Copyright header.** Every source file starts with `// Copyright 2026 Ix Infrastructure Inc.` in its language's
  comment syntax. CI enforces it. `python3 .github/scripts/copyright-headers.py --fix` adds any that are missing.
- **Clean output.** No raw stack traces in normal mode. Use the structured errors in `ix-cli/src/cli/errors.ts`.
- **Exit codes are an API.** The editor plugins and `ix mcp` discard output from a failed run, so making a command
  exit non-zero can break them. Read the exit-code section of CONTRIBUTING.md before changing one.
- **OSS and Pro.** Some features belong to Ix Pro. Don't move Pro features into this repository. If you're unsure
  where something belongs, ask in your pull request.

## Improving these docs

Every page has an **Edit page** link at the bottom. The site's source is in
[`docs-site/`](https://github.com/ix-infrastructure/Ix/tree/main/docs-site). To preview changes locally:

```bash
cd docs-site
npm ci
npm run dev
```

The flag reference, the llm format spec and the API endpoints are generated from `skills/ix/references/flags.md`,
`docs/llm-format.md` and `docs/api/openapi.yaml`. Edit those files, not the generated pages.
