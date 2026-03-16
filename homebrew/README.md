# Homebrew Tap for Ix

## Install

```bash
brew tap ix-infrastructure/ix https://github.com/ix-infrastructure/Ix
brew install ix
```

## Upgrade

```bash
brew upgrade ix
```

## Uninstall

```bash
brew uninstall ix
brew untap ix-infrastructure/ix
```

## How it works

The formula:
1. Downloads the Ix source tarball from GitHub releases
2. Runs `npm install --production` and `npm run build` in `ix-cli/`
3. Installs compiled JS + node_modules to `$(brew --prefix)/lib/ix/`
4. Creates a wrapper script at `$(brew --prefix)/bin/ix`

The `ix` CLI connects to an Ix backend server (not managed by Homebrew). Start the backend separately via Docker Compose or other means.

## Publishing a new release

```bash
./scripts/release.sh 0.2.0
```

This creates a GitHub release, computes the tarball SHA256, and updates the formula automatically.

## Tap structure

Homebrew looks for formulas in `homebrew/ix.rb` when the tap URL points to the Ix repo directly. For a dedicated tap repo, copy `ix.rb` to `Formula/ix.rb` in a `homebrew-ix` repo.
