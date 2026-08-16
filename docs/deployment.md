# Deployment

This repository is not a final production deployment. It contains an implemented private workspace and feature-gated Gmail/OpenAI integrations, but it still requires final owner sign-off before public deployment.

## Current state

- Production UI is implemented in [app/secure-workspace.tsx](../app/secure-workspace.tsx).
- Deployment is expected to remain private until the owner confirms the production origin, privacy review, and verification status.
- Gmail and AI feature flags remain opt-in and must not be enabled without a reviewed environment.

## Owner action required

- OWNER ACTION REQUIRED: confirm the final production host and redirect URI.
- OWNER ACTION REQUIRED: confirm the Google verification and security-assessment status.
- OWNER ACTION REQUIRED: approve the public auth/session design, deployment environment, and runbook for operational support.

## Required before release

- Complete [docs/owner-setup-checklist.md](owner-setup-checklist.md)
- Complete [docs/production-readiness-checklist.md](production-readiness-checklist.md)
- Complete [docs/test-account-checklist.md](test-account-checklist.md)
- Complete [docs/security-and-privacy.md](docs/security-and-privacy.md)
- Confirm [docs/branch-protection.md](branch-protection.md)

This document does not claim a production deployment exists or is complete.
