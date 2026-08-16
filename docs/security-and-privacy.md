# Security and privacy

This document records the implemented product boundary and the current unresolved owner actions.

## Implemented behavior

- The production UI is the SecureWorkspace in [app/secure-workspace.tsx](../app/secure-workspace.tsx).
- Tenant-scoped API access and D1-bound data access are the current server-side safety boundary.
- Gmail and OpenAI integrations are feature-gated and disabled unless explicitly enabled in a reviewed environment.
- Encrypted Gmail credentials are stored as encrypted values; the repository does not provide a public token-exchange or SaaS session design.
- Message import keeps text/plain bodies and metadata only, with attachment metadata but no attachment byte storage.
- AI analysis is structured and schema-validated before use.
- Audit events use redaction and a tenant-scoped append chain with sequence/hash checks.

## Not complete

- Public SaaS authentication or signed session management.
- Multi-organisation session handling or invitation flows.
- A final legal privacy notice for public distribution.
- Complete account and tenant deletion with proof of downstream cleanup.
- Scheduled retention automation or final production D1 backup/restore and security assessment.

## Owner action required

- OWNER ACTION REQUIRED: confirm the final privacy notice and applicable data-processing terms for any Google or OpenAI use.
- OWNER ACTION REQUIRED: confirm whether the deployment remains private-only or is approved for public access.
- OWNER ACTION REQUIRED: confirm the final retention schedule and data-deletion workflow for Gmail messages, analyses, drafts, and audit history.

## Data inventory summary

- Email message text: stored only when explicitly imported in a reviewed tenant environment.
- Message metadata: retained for operational and audit purposes.
- Attachment metadata: retained only as file attributes and provider identifiers.
- Gmail OAuth credentials: encrypted at rest, not intended for source control or public logs.
- OpenAI request payloads: restricted to structured analysis inputs; no public claim is made that provider data retention is zero.
- Audit events: tenant-scoped and redacted before persistence.

See [docs/repository-audit.md](repository-audit.md) for the historical pre-implementation baseline and [docs/production-readiness-checklist.md](production-readiness-checklist.md) for the remaining launch gates.
