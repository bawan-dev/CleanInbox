# Security

This repository is private and must not be used as a public production deployment without owner approval.

## Security expectations

- Keep all secrets in an approved secret manager or environment store; never commit production credentials, OAuth secrets, Google tokens, OpenAI keys, or encryption keys.
- Keep Gmail and AI integration flags disabled unless a dedicated test or approved deployment environment has been reviewed.
- Do not print tokens, refresh tokens, access tokens, or raw message bodies in logs, screenshots, issues, or pull requests.
- Treat all Gmail and AI responses as untrusted until validated by schema, policy, or server-side approval checks.
- Follow the project docs in [docs/security-and-privacy.md](docs/security-and-privacy.md), [docs/incident-response.md](docs/incident-response.md), and [docs/provider-outage-runbook.md](docs/provider-outage-runbook.md).

## Owner action required

- OWNER ACTION REQUIRED: confirm the approved production security owner and escalation process.
- OWNER ACTION REQUIRED: confirm the approved secret-manager and rotation policy for Google and OpenAI credentials.
- OWNER ACTION REQUIRED: confirm the public-facing deployment and verification status before enabling Gmail or AI in any shared environment.

## Reporting

If a suspected credential or sensitive data exposure is found, stop, preserve evidence, and escalate to the designated owner promptly. Do not disclose the secret value in the repository or support thread.
