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

```bash
# CLI unit tests and the parser smoke test
cd ix-cli && npm test
```

This is a quick check that the build works. It is not everything CI runs: see
[Before you open a PR](#before-you-open-a-pr).

## Development Workflow

For a map of the code — the two packages, how commands are registered, how a
file becomes graph patches, and the rules that hold it together — read
[docs/architecture.md](docs/architecture.md) first.

1. Create a branch from `main`
2. Make your changes
3. Run the checks in [Before you open a PR](#before-you-open-a-pr)
4. Open a PR using the pull request template
5. Ensure CI passes before merge

## Before you open a PR

The one required check on `main` is `CI Passed`, and it waits for every job in
`.github/workflows/ci.yml`. These are the commands those jobs run, in the
directory each one runs in. `cd ix-cli && npm test` covers only the unit tests
and the parser smoke test.

```bash
# From the repo root
python3 .github/scripts/copyright-headers.py   # copyright header on every source file (--fix adds them)
node ix-cli/scripts/check-links.mjs            # dead links in markdown (--offline skips the URL probes)

cd ix-cli
npm run lint
npm run typecheck
npm run knip                                   # unused files and exports, in ix-cli and core-ingestion
npm run build                                  # also builds core-ingestion; doc-parity reads dist/
npm run test:unit
npm run smoke                                  # parser smoke test
node scripts/check-api-parity.mjs              # docs/api matches the HTTP client
node scripts/check-doc-parity.mjs              # registered flags match the flag reference
cd ..

cd core-ingestion                              # installed and built by the ix-cli build above
npm test
cd ..

cd docs-site                                   # needs Node 22.22+
npm ci
npm run build
node ../ix-cli/scripts/check-links.mjs --dist dist --dist-only
cd ..
```

CI also runs the real-backend scenarios, which need Docker. They start their
own throwaway stack on ports 8290 and 8729, so they do not touch a backend you
already run. [ix-cli/test/e2e/README.md](ix-cli/test/e2e/README.md) explains
what they check, how to configure them and how they run in CI.

```bash
cd ix-cli
npm run e2e:up                  # start the pinned backend and ArangoDB
IX_E2E=1 npm run test:e2e       # build dist/, then run the scenarios
npm run e2e:down                # remove the containers and the volume
```

Some CI steps need the CI machine and have no local command. You can read them
in `ci.yml`:

- `Lint & Typecheck` also rejects raw NUL bytes in tracked JS/TS sources and
  runs `actionlint` over `.github/workflows/`.
- `E2E (real backend)` also smokes the write→read path against
  `docker-compose.standalone.yml` and runs a performance gate
  (`ix-cli/scripts/perf-gate.mjs`) on a pinned fixture checkout.
- `Harness install smoke` (Linux and Windows) installs the agent skill and runs
  `ix mcp install --dry-run` against a fixture.

Other workflows report on the PR as well. The PR title must be a conventional
commit (`pr-title.yml`). The [security checks](#security-checks) also run.
A change under `ix-cli/src/cli/` runs the advisory plugin contract check
(`plugin-contract.yml`): the commands, flags, json fields and MCP tool names
the editor plugins use. Its scope and its ignore list are described at the top
of `ix-cli/scripts/check-plugin-contract.mjs`. It also reads the MCP tool lists
in `ix-cli/src/mcp/server.ts`, but a PR that only changes `ix-cli/src/mcp/`
does not trigger it: there it runs nightly, or by hand with
`npm run build && node scripts/check-plugin-contract.mjs --clone` in `ix-cli/`.

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
| CLI code | `cd ix-cli && npm test` while you work |
| Any change | Everything in [Before you open a PR](#before-you-open-a-pr) |

## CLI Standards

### Adding a command

1. Write `ix-cli/src/cli/commands/<name>.ts`, with the copyright header and a
   `register<Name>Command(program)` function that declares the command.
2. Add one entry for it at the end of `OSS_COMMANDS` in
   `ix-cli/src/cli/register/commands.ts`: every name and alias it registers,
   its `load` import, and its `ix --help` line. Put the help line's name in a
   `ROOT_HELP_SECTIONS` section in the same file. Leave `help` out only for a
   command that should not be listed.

Do not reorder the existing entries. The fast-path table, `registerOssCommands()`
and the root help are all built from that list, and Ix Pro registers its
commands after them. When a name is registered twice, the first registration wins.

Declare shared options with the builders in `ix-cli/src/cli/options.ts` rather than
copying a neighbour's: `formatOption()` for `--format`, `choiceOption()` for an
option with a fixed set of values, `addTargetOptions()` and `addPagingOptions()`
for the target and paging flags. `command-manifest.test.ts`,
`help-coverage.test.ts` and `startup-fast-path.test.ts` fail if the entry and the
command disagree.

### Output quality
- Clean, minimal output — no unnecessary verbosity
- Consistent formatting across all commands
- A new command's output is a `Renderer<T>` (`text`, `json`, `llm`) in
  `ix-cli/src/cli/render/<command>.ts`, printed with `emit(renderer, value, format)`
  from `ix-cli/src/cli/output/emit.ts`. Do not compare `format` by hand, and do
  not add renderers to `format.ts`: it only re-exports names that moved out of it

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
- **Trivy scanning** — scans the repository's files for vulnerable dependencies (`security.yml`) and for misconfigurations (`config-security.yml`). No workflow in this repository scans a container image. The backend image is scanned where it is built.
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
