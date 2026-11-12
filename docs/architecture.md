# How the Ix code is put together

A map of this repository for contributors: the packages, the paths a command
and a file take through them, and the rules that hold them together. For how
Ix works from a user's side, read
[How Ix works](../docs-site/src/content/docs/concepts/how-it-works.md). For
setup, conventions and the checks to run, read
[CONTRIBUTING.md](../CONTRIBUTING.md).

This page covers what is stable. For detail, follow the file paths into the
code; the comments there explain the reasons. Every repo path this page names
in backticks is checked to exist (`ix-cli/src/cli/__tests__/contributor-docs.test.ts`).

## The pieces

| Path | What it is |
|---|---|
| `ix-cli/` | The `@ix/cli` package: the `ix` command, the HTTP client for the backend, and the MCP server. TypeScript, compiled to `dist/` by `tsc`. |
| `core-ingestion/` | The `@ix/core-ingestion` package: tree-sitter parsing, role classification, edge resolution and the builders that turn a parsed file into graph patches. No network and no backend knowledge. |
| `skills/ix/` | The agent skill shipped with Ix (`SKILL.md`, `references/`, bootstrap scripts). |
| `docs/` | Reference documents, including the backend HTTP API (`docs/api/`). |
| `docs-site/` | The Starlight documentation site. |
| `scripts/` | Repo scripts: the local backend (`scripts/backend.sh`), the `curl \| sh` installer (`scripts/install/`), skill deployment. |
| `Formula/ix.rb` | The Homebrew formula. |

The backend is not in this repository. It is the released
`ghcr.io/ix-infrastructure/ix-memory-layer` Docker image with ArangoDB, started
from `docker-compose.standalone.yml`, and the CLI talks to it over HTTP on
`localhost:8090`. The System Compass visualizer behind `ix view` is also built
elsewhere; the release workflow adds its bundle to the CLI archive.

## How `ix-cli` loads `core-ingestion`

`core-ingestion` is not an npm dependency of `ix-cli`. The two are siblings:

- **Build.** `ix-cli/scripts/build-core-ingestion.mjs` builds `core-ingestion`
  first, installing its dependencies when they are missing. `npm run build`, `npm test` and `npm run dev` in
  `ix-cli/` all run it, so a CLI build always has a parser build beside it.
- **Runtime.** `ix-cli/src/cli/commands/ingestion-loader.ts` imports
  `core-ingestion`'s built `dist/*.js` modules by file URL, four directories
  above the compiled loader (`dist/cli/commands/`). The parse worker
  (`dist/parse-worker.js`) is found the same way from
  `ix-cli/src/cli/commands/ingest.ts`. The modules are imported when a
  command first needs them, not at start-up.
- **Types.** The CLI's `rootDir` is `ix-cli/src`, so it cannot import
  `core-ingestion` source. It declares the shapes it calls in
  `ingestion-loader.ts`, and the graph patch schema is kept as two identical
  files: `core-ingestion/src/schema.ts` is canonical and
  `ix-cli/src/client/graph-schema.ts` is a byte-for-byte copy. Edit the first,
  copy it over the second; `ix-cli/src/client/__tests__/graph-schema.test.ts`
  fails when they differ.

**Rule:** every install layout must keep `core-ingestion/` four directories
above the CLI's `dist/cli/commands/`. The source checkout, the release archive
and Homebrew each do (see [Install layouts](#install-layouts-and-the-release)).

**Rule:** the extensions the CLI discovers (`ix-cli/src/cli/supported-extensions.ts`)
must match the ones `core-ingestion` parses (`core-ingestion/src/languages.ts`).
[Adding a language](../docs-site/src/content/docs/community/adding-a-language.md)
lists every file a new language touches.

## Start-up and command registration

`ix-cli/src/cli/main.ts` is the `bin` entry. It does only what must happen
before the command tree loads: the Node version check, the compile cache, and
the dispatch of `ix hook <subcommand>` (the list is in
`ix-cli/src/cli/hook/subcommands.ts`), which runs on every hooked agent event
and must not pay for loading every command. Everything else goes to
`ix-cli/src/cli/run-cli.ts`, which:

1. Asks `planStartup()` (`ix-cli/src/cli/register/oss-table.ts`) how much of
   the registry this invocation needs. With Ix Pro absent, `ix <command> …`
   loads only that command's module; help, unknown words and Pro installs load
   everything.
2. Registers the OSS commands. They are listed once, in `OSS_COMMANDS`
   (`ix-cli/src/cli/register/commands.ts`); the fast-path table, the
   all-commands registration (`registerOssCommands()` in
   `ix-cli/src/cli/register/oss.ts`) and the root help
   (`ix-cli/src/cli/help-text.ts`) are all built from that list. Shared setup
   for every command, such as enforcing fixed option values, is in
   `ix-cli/src/cli/register/oss-setup.ts`.
3. Loads Ix Pro if it is installed (`tryLoadProCommands()` in
   `ix-cli/src/cli/register/pro-loader.ts`): the optional `@ix/pro` package
   exports `registerProCommands(program)` from `@ix/pro/register`, which adds
   its commands to the same commander program after OSS.
4. Without Pro, registers the OSS fallbacks for `ix note` and `ix session`
   (`ix-cli/src/cli/register/oss-fallbacks.ts`) and a stub for each Pro
   command (`ix-cli/src/cli/register/pro-stubs.ts`) that explains it needs Pro.
5. Parses argv. A thrown error is rendered by `ix-cli/src/cli/errors.ts`, in the
   format the caller asked for, without a stack trace.

The rules of this seam:

- **A new OSS command is one module and one manifest entry.** Write
  `ix-cli/src/cli/commands/<name>.ts` and add its entry at the end of
  `OSS_COMMANDS`. See [Adding a command](../CONTRIBUTING.md#adding-a-command);
  `command-manifest.test.ts`, `help-coverage.test.ts` and
  `startup-fast-path.test.ts` fail if the entry and the command disagree.
- **First registration wins.** OSS registers before Pro, so a name both define
  is OSS's. Do not reorder `OSS_COMMANDS`.
- **The OSS/Pro boundary is derived at run time.** `run-cli.ts` records the
  OSS command names before Pro loads; whatever Pro adds after that is a Pro
  command. Moving a command into the manifest makes it OSS.
- **The Pro surface is one table.** `PRO_COMMANDS`, `PRO_RETIRED` and the Pro
  MCP tool names live in `ix-cli/src/cli/register/pro-surface.ts`; the stubs,
  the help topics, the MCP server and the plugin contract check all read it.
  Do not add a stub for a command OSS implements: the stub would shadow it.
- **A broken Pro install is not an absent one.** `tryLoadProCommands()` throws
  when `@ix/pro` is installed but cannot load, and the CLI stops rather than
  running without Pro's guard. Only the repair commands in
  `ix-cli/src/cli/register/pro-failure.ts` continue.
- **Exit codes and `--format json` / `--format llm` output are a contract.**
  The editor plugins and `ix mcp` act on them. Read
  [Exit codes](../CONTRIBUTING.md#exit-codes) and
  [`--format llm`](llm-format.md) before changing either.
- **Output goes through `ix-cli/src/cli/output/`.** `output/json.ts` prints
  json payloads (`printJson`, `captureJson`, `--pretty`, resolution
  notices); `output/slice.ts` cuts lists to `--limit`/`--offset` and words the
  truncation hints; `output/emit.ts` holds `Renderer<T>` and `emit`, which picks
  the form for `--format`. One command's renderer lives in
  `ix-cli/src/cli/render/<command>.ts`. `format.ts` only re-exports the names
  that moved out of it, for the modules that still import them from there.

## Ingest: from a file to graph patches

`ix map` (`ix-cli/src/cli/commands/map.ts`) and `ix ingest`
(`ix-cli/src/cli/commands/ingest.ts`) both end in `ingestFiles()` in
`ingest.ts`. In order, it:

1. **Discovers files.** `ix-cli/src/cli/file-discovery.ts` is the one
   implementation used by map, ingest, watch and status: `git ls-files` in a
   repository, a filesystem walk otherwise, filtered by the supported
   extensions, `.ixignore` and `--exclude`.
2. **Skips unchanged files.** The per-root ingest baseline
   (`ix-cli/src/cli/ingest-baseline.ts`) records each file's mtime from the
   last clean run; a file whose mtime matches is not read. The rest are hashed
   (SHA-256) and compared with the hashes the backend holds
   (`POST /v1/source-hashes`).
3. **Parses.** Changed files go to a worker pool
   (`ix-cli/src/cli/commands/parse-pool.ts`) running
   `core-ingestion/src/parse-worker.ts`, which calls `parseFile()` in
   `core-ingestion/src/index.ts`: tree-sitter with the queries in
   `core-ingestion/src/queries.ts`, roles from
   `core-ingestion/src/role-classifier.ts`.
4. **Resolves edges.** `buildGlobalResolutionIndex()` and `resolveEdges()`
   (`core-ingestion/src/index.ts`) link calls, imports and references across
   files, using a small per-file summary (`core-ingestion/src/symbol-index.ts`)
   so unchanged files need not be parsed again.
5. **Builds patches.** `buildPatchWithResolution()` and, for deleted files,
   `buildDeletionPatch()` in `core-ingestion/src/patch-builder.ts`. The patch
   shapes are defined in `core-ingestion/src/schema.ts`.
6. **Commits.** Files are parsed, resolved and committed in batches, so memory
   stays bounded by the batch rather than the repository. Patches go to
   `POST /v1/patches/bulk`, split further when the backend answers that a
   payload is too large, and to `POST /v1/patch` one at a time where a patch
   must be committed alone. Entities a file no longer has are reconciled, and
   orphaned nodes swept.
7. **Re-resolves dependents.** Files that import a name whose definition
   changed are resolved again (`findDependents()` in `symbol-index.ts`).
8. **Stitches.** For a system of several repositories, `POST /v1/stitch` links
   the workspaces.
9. **Saves the baseline**, only when the run was clean
   (`persistIngestBaselineIfClean()`), so a failed run is retried next time
   instead of being recorded as done.

Two things force a full re-ingest: a change of extractor (`extractorName()` in
`patch-builder.ts`, compared by `extractorChanged()` in `ingest-baseline.ts`)
and a backend whose graph `schema_version` differs from
`CLIENT_EXPECTED_SCHEMA_VERSION` (`ix-cli/src/cli/backend-status.ts`).

**Rule:** every per-project-root state file under `IX_HOME` is registered in
`WORKSPACE_STATE_FILES` (`ix-cli/src/cli/state-paths.ts`). Its group decides
whether `ix reset`, a workspace migration or a forced re-ingest clears it, and
the registry test fails for one that is not listed.

## The HTTP client and the factory rule

`IxClient` (`ix-cli/src/client/api.ts`) is how commands talk to the backend
API, and the list of routes the CLI depends on (the `ix view` proxy forwards
requests without defining any, and `ix docker` and `ix upgrade` probe
`/v1/health` directly). Its response types are in
`ix-cli/src/client/types.ts`. It retries reads only; a write, including a patch
upload, is never retried.

**Rule:** every client comes from `createClient()` in
`ix-cli/src/client/factory.ts`. That is where the auth token, the in-flight
limit, the read deadline and the abort signal of the current MCP tool call are
applied, so a client built any other way silently misses them. An ESLint rule
in `ix-cli/eslint.config.js` rejects `new IxClient(` outside
`ix-cli/src/client/` and tests; the one exception carries a disable comment
explaining why.

Which optional backend routes the CLI uses, and how it falls back on a backend
that lacks one, is decided in one place: `ix-cli/src/client/features.ts`.

## The MCP server

`ix mcp` (`ix-cli/src/mcp/server.ts`) serves the graph tools over stdio. A tool
is not separate code: each call runs the matching CLI command with
`--format json` or `--format llm` and returns its output. So a change to a
command's output or exit code changes the tool too.

Commands run in the server's own process (`createInProcessRunner()` in
`ix-cli/src/mcp/runner.ts`), one at a time, on a command tree built fresh for
each call. Output and `process.exitCode` are process-wide, which is why calls
are serialized. `IX_MCP_SUBPROCESS=1` runs each call as a child process
instead. The Pro tools are advertised only when Pro is installed.

`ix mcp install` (`ix-cli/src/mcp/install.ts`, `ix-cli/src/mcp/hosts.ts`)
registers the server with each AI client; see [`ix mcp`](mcp.md).

## The backend contract

- **Routes.** [`docs/api/README.md`](api/README.md) and `docs/api/openapi.yaml`
  are written from the client. `ix-cli/scripts/check-api-parity.mjs` fails when
  the client calls a route the reference does not document, or the reverse, or
  when a documented schema has no type in `types.ts`.
  `ix-cli/test/e2e/api-reference.e2e.ts` checks every documented route exists
  on the pinned backend.
- **Versions.** `GET /v1/health` reports the backend's `release_version` and
  its graph `schema_version`. `MIN_BACKEND_VERSION` in `features.ts` is the
  oldest release the CLI supports; `ix doctor` warns below it and on a schema
  mismatch.
- **Optional routes.** A route an older backend lacks is found by calling it.
  Commands ask `features.ts` what a failure means rather than reading status
  codes themselves. `GET /v1/capabilities` does not yet list features, so
  release gates use `release_version`.
- **Backend changes** happen in the backend's own repository. Do not write CLI
  code against an endpoint the released backend does not serve; see
  [Backend Development](../CONTRIBUTING.md#backend-development).

## Install layouts and the release

There are three ways the CLI reaches a machine, and each has its own layout:

| Path | Layout |
|---|---|
| Source checkout | `ix-cli/dist/` beside `core-ingestion/dist/` in the repository |
| Release archive (used by `scripts/install/install.sh` and `install.ps1`, extracted to `~/.ix/cli`) | `cli/` (the CLI's `dist/`, `node_modules/`, `package.json`, `scripts/`, `assets/`), `core-ingestion/`, `compass/` |
| Homebrew (`Formula/ix.rb`) | the CLI under `libexec/`, `core-ingestion/` under the formula prefix |

**Rule:** a file the CLI reads at run time from outside `dist/` must be
packaged in all three. Examples are `docker-compose.standalone.yml` (copied
into `dist/` by the `build` script in `ix-cli/package.json`) and the banner
inputs `ix-cli/scripts/render-logo.mjs` and `ix-cli/assets/logo.png`. Add a new
one to the `build` script or to the staging step in
`.github/workflows/release.yml`, and to `Formula/ix.rb`, which runs `tsc`
directly rather than `npm run build`. Missing from one path, it fails only on
that kind of install.

The release (`.github/workflows/release.yml`) runs when a `v*` tag is pushed.
It builds the CLI and `core-ingestion` on a native runner per platform,
because the tree-sitter bindings are compiled from source, stamps the version
from the tag, packages one archive per platform with checksums and an SBOM,
creates the GitHub release, and opens a pull request that updates the Homebrew
formula. On a pull request that touches packaging it runs as a dry run with
nothing published. Versions in the repository are not bumped by hand.

## Tests and CI

| Layer | Where | Run locally | CI job (`.github/workflows/ci.yml`) |
|---|---|---|---|
| Lint, types, dead code (both packages), copyright headers, workflow lint | `ix-cli/src`, `core-ingestion/src`, `.github/` | `npm run lint`, `npm run typecheck`, `npm run knip` (repo root) | `static` |
| CLI unit tests | `ix-cli/src/**/__tests__/` | `cd ix-cli && npm run test:unit` | `test` (Linux, macOS and Windows; coverage on one leg) |
| Parser smoke test | `ix-cli/test/parser.smoke.mjs` | `npm run smoke` | `test` |
| Parser tests | `core-ingestion/src/__tests__/` | `cd core-ingestion && npm test` | `test` |
| End-to-end, against a real backend, and the performance gate | `ix-cli/test/e2e/`, `ix-cli/scripts/perf-gate.mjs` | see [the e2e README](../ix-cli/test/e2e/README.md) | `e2e` |
| API reference parity | `ix-cli/scripts/check-api-parity.mjs` | `node scripts/check-api-parity.mjs` | `api-parity` |
| Flag reference parity (reads the built `dist/`) | `ix-cli/scripts/check-doc-parity.mjs` | `node scripts/check-doc-parity.mjs` | `doc-parity` |
| Markdown links | `ix-cli/scripts/check-links.mjs` | `node ix-cli/scripts/check-links.mjs` | `links` |
| Docs site build, and links in the built site | `docs-site/` | `cd docs-site && npm run build` | `docs-site` |
| Skill and MCP installers | `scripts/install-skill.sh`, `ix mcp install` | — | `harness-install-smoke`, `harness-install-smoke-windows` |
| All of the above passed | — | — | `ci-success` |

Slow scale tests (`*.slow.test.ts`, `npm run test:slow`) are not run in CI.
Other workflows run separately: `plugin-contract.yml` (every `ix` invocation in
the editor plugins names a real command and flags; advisory and nightly),
`windows-install.yml`, the release dry run, and the security, secret-scan,
CodeQL, dependency-review and pull-request-title checks.
[Before you open a PR](../CONTRIBUTING.md#before-you-open-a-pr) lists every
command CI runs.
