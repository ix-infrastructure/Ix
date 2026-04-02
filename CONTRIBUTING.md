# Contributing to Ix

## Getting Started

### Prerequisites

- Node.js 20+
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

| What changed | Run |
|---|---|
| CLI code | `cd ix-cli && npm test` |
| Any change | Full test suite before opening PR |

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

## Security Checks

PRs and pushes to `main` run automated security checks:

- **Dependency review** — flags new dependencies with known vulnerabilities (PRs only)
- **Trivy scanning** — scans the repo filesystem and Docker image for vulnerabilities and misconfigurations
- **Config security** — scans Docker Compose and deployment configs for unsafe exposure (e.g., auth disabled with public port bindings, `0.0.0.0` bindings). Local-only configs that bind to `127.0.0.1` are allowed.

All checks fail on CRITICAL or HIGH severity findings. If a check fails on your PR, inspect the output and either fix the vulnerability or document why it's a false positive.

## Backend Development

The Scala backend (memory-layer) lives in a [separate private repo](https://github.com/ix-infrastructure/ix-memory-layer). For backend changes, clone that repo directly.

## OSS vs Pro Boundary

This repository contains open-source Ix functionality. Some features are available only in Ix Pro.

Contributors must:
- Not reintroduce Pro-only features into this repository
- Not bypass licensing boundaries
- Respect the separation between OSS and Pro functionality

If you're unsure whether a feature belongs in OSS or Pro, ask in your PR.
