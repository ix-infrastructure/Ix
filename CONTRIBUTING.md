# Contributing to Ix

## Getting Started

### Prerequisites

- Node.js 22+ (22.22 or newer to build the docs site, which Astro requires)
- Docker and Docker Compose

### Local Setup

```bash
git clone https://github.com/ix-infrastructure/Ix.git
cd Ix
./scripts/backend.sh up    # Start ArangoDB + Memory Layer (Docker)
cd ix-cli && npm ci && npm run build
```

### Building from Source

```bash
# core-ingestion (parser library, built automatically by ix-cli)
cd core-ingestion
npm ci
npm run build

# ix-cli
cd ../ix-cli
npm ci
npm run build
```

### Verify Your Setup

From the repository root, run this quick check. See [Before you open a PR](#before-you-open-a-pr) for the full CI checks.

```bash
# CLI tests
cd ix-cli && npm test
```

## Development Workflow

1. Create a branch from `main`
2. Make your changes
3. Run tests locally
4. Open a PR using the pull request template
5. Ensure CI passes before merge

## Branch Naming

```
feat/<name>
fix/<name>
docs/<name>
refactor/<name>
test/<name>
ci/<name>
chore/<name>
```

## Commit Format

Use conventional commit prefixes:

```
feat:      New feature
fix:       Bug fix
docs:      Documentation only
refactor:  Code change that neither fixes a bug nor adds a feature
test:      Adding or updating tests
ci:        CI/CD changes
chore:     Maintenance, dependencies, tooling
```

Breaking changes: use `feat!:` or `fix!:` prefix.

## Testing

`cd ix-cli && npm test` builds core-ingestion, runs CLI unit tests and the parser
smoke test. It does not rebuild the CLI's `dist/`, run core-ingestion's own tests,
or run the real-backend scenarios.

### Before you open a PR

The required `CI Passed` check aggregates the jobs in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). From the repository root,
run these commands (parentheses keep each block's working directory local):

```bash
(
  cd ix-cli
  npm ci --silent
  npm run build
  npm run lint
  npm run typecheck
  npm run knip
  npm run test:unit
  npm run test:coverage
  npm run smoke
  node scripts/check-api-parity.mjs
  node scripts/check-doc-parity.mjs
)
(cd core-ingestion && npm test)
python3 .github/scripts/copyright-headers.py
node ix-cli/scripts/check-links.mjs
(
  cd docs-site
  npm ci
  npm run build
  node ../ix-cli/scripts/check-links.mjs --dist dist --dist-only
)
```

CI runs unit tests with coverage on Linux/Node 22 and without coverage on the
other matrix legs: Linux/Node 24, macOS/Node 22 and 24, and Windows/Node 22.
The CLI build installs and builds core-ingestion, including its native parsers.

For the real-backend correctness scenarios, Docker must be running. From the
repository root, after building the CLI:

```bash
(
  cd ix-cli
  npm run e2e:up
  IX_E2E=1 npx vitest run --config vitest.e2e.config.ts
  npm run e2e:down
)
```

Always run `npm run e2e:down` from `ix-cli/` when finished, including after a
failed run. The [real-backend harness guide](ix-cli/test/e2e/README.md) explains
the isolated stack, configuration and cleanup. Its [performance gate](ix-cli/test/e2e/README.md#performance-gate)
also runs in CI: from `ix-cli/`, with that stack running and the fixture checked
out as described in the guide, run
`IX_E2E=1 node scripts/perf-gate.mjs <fixture-path>`. CI adds
`--out "$RUNNER_TEMP/perf-results.json"` to save the results.

The following required checks use inline scripts or isolated runner fixtures;
their full setup and assertions live in the linked workflow steps:

| Gate | Commands and CI setup |
|---|---|
| Raw NUL-byte guard | The `static` job's “No raw NUL bytes in tracked sources” step checks tracked JS/TS sources with `git ls-files`, `tr` and `wc`. |
| Workflow wiring | `./actionlint -shellcheck= -pyflakes=` from the repository root, using the checksum-verified actionlint version in the `static` job. |
| Backend write/read smoke | The `e2e` job runs `docker compose -f docker-compose.standalone.yml up -d --wait --wait-timeout 180`, then `node dist/cli/main.js` with `status`, `map`, `search` and `doctor`, checking results and the unmapped-directory error. Use the job's isolated fixture setup. |
| Harness install smoke (Linux and Windows/Git Bash) | The `harness-install-smoke` and `harness-install-smoke-windows` jobs run `node ix-cli/scripts/skill-harnesses.mjs --probe`, `bash scripts/install-skill.sh --dry-run`, `bash scripts/install-skill.sh --help`, `bash scripts/install-skill.sh --dry-run --json`, and (from `ix-cli/`) `node dist/cli/main.js mcp install --host claude codex openclaw --dry-run --format json`. The jobs supply fake harnesses and isolated home directories; copy their setup to reproduce the assertions. |

Separate PR workflows also report security and policy checks; see
[Security Checks](#security-checks). The config policy command is
`bash scripts/ci/check-config-security.sh` from the repository root.

## CLI Standards

### Output quality
- Clean, minimal output — no unnecessary verbosity
- Consistent formatting across all commands

### Error handling
- No raw stack traces in normal mode
- Use the structured error system (`ix-cli/src/cli/errors.ts`)
- `--debug` may show detailed output

### Language consistency
- Follow existing Ix command voice and terminology
- Match output patterns of existing commands

### Exit codes

The graph commands share one set of codes, defined in
`ix-cli/src/cli/outcome.ts`: `0` results, `1` error, `2` ambiguous target
(only with `--strict` / `IX_STRICT_TARGETS=1`; otherwise the top candidate is
answered with a notice), `3` target not found anywhere (a name in source files
is answered with them), `4` workspace not mapped (`IX_LEGACY_EXIT_CODES=1`
collapses 2-4 to 1). A hook that runs `ix` exits with its own status, never
ix's: Claude Code treats a hook's exit `2` as a block. Report a resolution
failure through `resolveFileOrReport` or `reportResolutionFailure` rather than
setting `process.exitCode` yourself,
and the right code follows. `ix read`'s ambiguity is the one exception: it
exits 0 with its own `ambiguous` record, as it always has (see below for why
adding a non-zero exit is not free).

Making a command exit non-zero is a **breaking change to every plugin and MCP
client**, even when the payload it prints is an improvement. Both consumers
throw stdout away on a failed run:

- **Plugins** run `ix` through wrappers that treat a non-zero exit as an error
  and discard the output — bun's `` $`…` `` throws, and the shell hooks branch on
  `||` under `set -euo pipefail`.
- **`ix mcp`** prefers stderr over stdout when the exit is non-zero
  (`runCommand` in `ix-cli/src/mcp/server.ts`), so a structured record written
  to stdout is replaced by whatever prose happened to reach stderr — usually
  the resolver's human guidance.

The failure mode is counter-intuitive: you add `{"error": "...", "message": "..."}`
so machine callers can tell a refusal from an empty result, set the exit code
to match, and the exit code is what stops anyone from ever seeing the payload.

**Before adding a non-zero exit to an existing command, check whether anything
calls it programmatically:**

```bash
# from a directory holding checkouts of the plugin repos
grep -rnE '\$`ix <command>|runIx\(\["<command>"|\$\(ix <command>' . | grep -v '\.md:'
```

Those three forms cover every call site today — bun shell, the TypeScript
`runIx` helper, and shell command substitution. They are literal on purpose:
no plugin builds the command name from a variable, so a literal search is
exhaustive. Re-check that assumption if the grep comes back empty for a command
you expected to find.

Matches in `.md` files or agent prompt strings are prose telling a model to run
the command — those are fine, the model sees stdout either way. Matches in
`.ts`, `.sh` or `.py` are runners, and those break.

If a runner consumes it, the plugin change has to land **first**, in its own
repo, and the Ix change follows. Say so in the PR body and open it as a draft
until the dependency is merged.

Applies to: `ix-claude-plugin`, `ix-codex-plugin`, `ix-cursor-plugin`,
`ix-gemini-plugin`, `ix-openclaw-plugin`, `ix-opencode-plugin`. Five of the six
carry runners today, so "no plugin calls this" is a claim to verify, not
assume.

## Copyright Headers

Every source file starts with the copyright line, in that language's comment syntax:

```ts
// Copyright 2026 Ix Infrastructure Inc.
```

A shebang stays on line 1 — the header goes directly beneath it. This is enforced
by the `Lint & Typecheck` job, so it gates merges through the required `CI Passed`
check. If you add a file and it goes red, fix every offender at once:

```bash
python3 .github/scripts/copyright-headers.py --fix
```

Test fixtures, vendored code, and anything marked `linguist-generated` in
`.gitattributes` are deliberately exempt — the parser tests snapshot fixture line
numbers, and generated files lose the header on their next regeneration.

## Security Checks

PRs and pushes to `main` run automated security checks:

- **Dependency review** — flags new dependencies with known vulnerabilities (PRs only)
- **Trivy scanning** — scans the repository filesystem for vulnerabilities; the Config Security workflow separately scans filesystem configuration for misconfigurations. These workflows do not scan a Docker image.
- **Config security** — scans Docker Compose and deployment configs for unsafe exposure (e.g., auth disabled with public port bindings, `0.0.0.0` bindings). Local-only configs that bind to `127.0.0.1` are allowed.

All checks fail on CRITICAL or HIGH severity findings. If a check fails on your PR, inspect the output and either fix the vulnerability or document why it's a false positive.

## Backend Development

The Scala memory-layer backend is developed in a separate, **private** repository
(`ix-infrastructure/Ix-memory`). Its source is not publicly accessible, so cloning
it is a maintainer-only step. Note that `ix-memory-layer` — the name used in the
release notes, `docker-compose.standalone.yml` and the image path in
`.github/workflows/` — is the published *artifact*, not a repository you can
clone.

**You do not need the backend source to work on this repository.** Everything in
the `ix` CLI is developed against the published backend image, which is public and
pullable anonymously. `./scripts/backend.sh up` in [Local Setup](#local-setup)
starts it (`ghcr.io/ix-infrastructure/ix-memory-layer:latest` on
`127.0.0.1:8090`, plus ArangoDB with no host port). It installs nothing itself — it runs
`docker compose -f docker-compose.standalone.yml` against an already-installed
Docker. What the `curl | sh` *installer* puts on the machine is a separate list:
[docs/prerequisites.md](docs/prerequisites.md).

If a change you want needs the backend itself — a new endpoint, a different
response shape, a query that is too slow — open an issue here describing the CLI
behaviour you need and what the backend would have to do. A maintainer will carry
it across. Please do not open a PR against this repository that assumes an
endpoint the released backend does not serve. `ix doctor` reports the running
graph schema version, and `curl -s localhost:8090/v1/health` returns both that
and the backend's release version — that release is what to write against.

## OSS vs Pro Boundary

This repository contains open-source Ix functionality. Some features are available only in Ix Pro.

Contributors must:
- Not reintroduce Pro-only features into this repository
- Not bypass licensing boundaries
- Respect the separation between OSS and Pro functionality

If you're unsure whether a feature belongs in OSS or Pro, ask in your PR.
