# Contributing

## Developer Setup (from source)

```bash
git clone https://github.com/ix-infrastructure/Ix.git
cd Ix
./setup.sh
```

### Testing

```bash
# CLI tests
cd ix-cli && npm test

# Backend tests (requires ArangoDB on localhost:8529)
sbt memoryLayer/test
```

### Useful Scripts

| Script | Purpose |
|--------|---------|
| `./setup.sh` | Full local setup (backend + CLI + hooks) |
| `./scripts/backend.sh up/down/logs/clean` | Manage Docker backend |
| `./scripts/build-cli.sh` | Build the TypeScript CLI |
| `./scripts/connect.sh <dir>` | Connect a project + ingest |
| `./scripts/disconnect.sh <dir>` | Remove project config |

## CI/CD Pipeline

### CI (`ci.yml`) — runs on every PR and push to main

| Job | What it does |
|-----|-------------|
| **CLI** | `npm ci` → `npm run build` → `npm test` |
| **Backend** | `sbt compile` → `sbt test` → `sbt memoryLayer/assembly` |

Both jobs run in parallel. PRs must pass both before merging.

### Release (`release.yml`) — runs when a version tag is pushed

| Step | What it does |
|------|-------------|
| 1. Build JAR | `sbt memoryLayer/assembly` |
| 2. Docker image | Builds + pushes to `ghcr.io/ix-infrastructure/ix-memory-layer:<version>` and `:latest` |
| 3. Build CLI | `npm ci` → `npm run build` → stamps version |
| 4. Package tarballs | Creates `ix-<ver>-{linux-amd64,darwin-amd64,darwin-arm64}.tar.gz` + `windows-amd64.zip` |
| 5. GitHub Release | Creates release with all assets + install instructions |
| 6. Homebrew | Updates `homebrew/ix.rb` with new URL + SHA256, commits to main |

### Release Please (`release-please.yml`) — automated versioning

Runs on every push to main. Reads conventional commit messages and:
- Opens/updates a "Release vX.Y.Z" PR with a changelog
- When that PR is merged, creates the tag → triggers `release.yml`

## Releasing a New Version

Versioning is automated via release-please. You don't pick version numbers or create tags manually.

1. Merge PRs to main using conventional commit messages (`feat:`, `fix:`, `chore:`)
2. release-please auto-opens a Release PR with changelog
3. Merge the Release PR when ready to ship
4. Tag is created automatically → full release pipeline runs

### Commit prefixes

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `fix:` | Patch (0.1.0 → 0.1.1) | `fix: parser fails on decorators` |
| `feat:` | Minor (0.1.0 → 0.2.0) | `feat: add ix docker command` |
| `feat!:` or `BREAKING CHANGE:` | Major (0.2.0 → 1.0.0) | `feat!: redesign CLI flags` |
| `chore:`, `docs:`, `refactor:` | No release | `docs: update README` |

### Manual release (if needed)

```bash
git tag v0.2.0
git push origin v0.2.0
```
