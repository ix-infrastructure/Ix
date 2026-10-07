---
title: Security
description: How to report a vulnerability in Ix, and what the security policy covers.
---

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue:

- Open a private report through GitHub Security Advisories: the repository's
  [**Security → Report a vulnerability**](https://github.com/ix-infrastructure/Ix/security/advisories/new) tab, or
- Email [security@ix-infra.com](mailto:security@ix-infra.com).

Include a description, reproduction steps, the affected version and the impact. We aim to acknowledge reports
within three business days and to give a remediation timeline after triage. Please allow a reasonable window for a
fix before any public disclosure.

## Supported versions

Security fixes target the latest release of the `ix` CLI. Run `ix upgrade` before reporting.

## Scope

This policy covers the `ix` CLI and the artifacts published from the
[Ix repository](https://github.com/ix-infrastructure/Ix). The memory-layer backend is released separately and has its
own reporting channel.

## Verifying downloads

Every release archive is published with a `<archive>.sha256` file. `ix upgrade` downloads both and checks the
archive before it extracts or runs anything. It refuses to install if the checksum does not match or is missing,
and leaves your current install as it was. This covers the CLI and the Compass bundle.

When the [GitHub CLI](https://cli.github.com/) is installed, `ix upgrade` also checks the CLI archive's build
provenance with `gh attestation verify`. It reports the result, but the checksum is what decides. To check an archive
yourself:

```sh
sha256sum -c ix-<version>-<platform>.tar.gz.sha256
gh attestation verify ix-<version>-<platform>.tar.gz -R ix-infrastructure/Ix \
  --signer-workflow ix-infrastructure/Ix/.github/workflows/release.yml
```

## Your code stays local

The default backend runs in Docker on your machine and binds to `127.0.0.1` only, so your code and graph stay on
your machine.
