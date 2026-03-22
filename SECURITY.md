# Security

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/ix-infrastructure/Ix/security/advisories/new).

Do not open public issues for security vulnerabilities.

## Architecture

Ix runs locally. The backend (ArangoDB + Memory Layer) runs as Docker containers on your machine.

### Local-only by default

- The backend listens on `localhost` only (ports 8090 and 8529)
- ArangoDB authentication is disabled for local development (`ARANGO_NO_AUTH=1`)
- No data leaves your machine unless you explicitly use `ix map --github`

### If exposing to a network

If you run the Ix backend on a shared machine or expose ports externally, you **must**:

1. Enable ArangoDB authentication — set `ARANGO_ROOT_PASSWORD` and remove `ARANGO_NO_AUTH`
2. Use a reverse proxy with TLS for the Memory Layer
3. Restrict port access with firewall rules

The default configuration is designed for single-user local development and is not suitable for network-accessible deployments.

## Install Scripts

The recommended install method (`curl ... | bash`) downloads and executes a script from GitHub over HTTPS. This is standard practice for developer tools (Homebrew, rustup, nvm) but carries inherent risk if the source is compromised.

For higher assurance:
- Review the [install script](install.sh) before running it
- Use `brew install ix-infrastructure/ix/ix` instead
- Clone the repo and build from source

## Dependencies

- **CLI**: Node.js with npm dependencies locked via `package-lock.json`
- **Backend**: Scala/JVM with sbt-managed dependencies
- **Docker images**: Based on `eclipse-temurin:17-jre-jammy` and `arangodb:3.12`
