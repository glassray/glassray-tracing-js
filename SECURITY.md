# Security Policy

## Supported versions

Only the latest published version of `@glassray/tracing` receives security fixes.
Please upgrade before reporting — the issue may already be resolved.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via
[GitHub Private Vulnerability Reporting](https://github.com/glassray/glassray-tracing-js/security/advisories/new)
("Report a vulnerability" on the repo's Security tab).

Include what you can: affected version, a proof-of-concept or reproduction steps, and
the impact you believe it has. You'll get an acknowledgement within a few business
days, and we'll keep you updated as we triage and fix. Fixes ship as a new npm release
with a GitHub Security Advisory (and CVE where appropriate) crediting the reporter.

## Design notes for reviewers

- **Zero runtime dependencies** — installing this package pulls in no third-party
  code, and there are no install scripts (`postinstall` etc.).
- The SDK's only network egress is trace export to the configured Glassray endpoint
  (`https://app.glassray.ai` by default).
