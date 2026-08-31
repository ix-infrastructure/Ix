# Contributing to Ix

## Getting Started

### Prerequisites

- Node.js 22+
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

### Exit codes

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
