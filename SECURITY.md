# Security Policy

## Reporting a vulnerability

Please report security issues privately, **not** as a public issue.

- Preferred: open a private report via GitHub Security Advisories
  (the repository's **Security → Report a vulnerability** tab), or
- Email the maintainers at security@ix-infra.com.

Please include a description, reproduction steps, affected version, and impact.
We aim to acknowledge reports within 3 business days and to provide a remediation
timeline after triage. Please give us a reasonable window to ship a fix before
any public disclosure.

## Supported versions

Security fixes target the latest released version of the `ix` CLI. Older
versions are not maintained; please upgrade (`ix upgrade`) before reporting.

## Scope

This policy covers the `ix` CLI and the artifacts published from this
repository. The memory-layer backend is released from a separate, private
repository; report issues in it, including the published `ix-memory-layer`
image, the same way: email security@ix-infra.com. Its source is not public, so
a GitHub Security Advisory on this repository is the other option.
