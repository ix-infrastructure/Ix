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

## Your code stays local

The default backend runs in Docker on your machine and binds to `127.0.0.1` only, so your code and graph stay on
your machine.
