# ClearInbox

ClearInbox is a tenant-scoped Gmail and inbox operations workspace for reviewing, analysing, and approving mail before creating a Gmail draft. It is implemented as a secure internal product boundary, not a public SaaS sign-in product.

## Current repository state

This repository contains the implemented product core for:

- real SecureWorkspace UI in [app/secure-workspace.tsx](app/secure-workspace.tsx)
- Gmail OAuth and encrypted credential storage
- tenant-scoped Gmail thread synchronization
- text/plain message ingestion and metadata-only attachments
- OpenAI structured analysis with schema validation
- prompt-injection protections and trusted-vs-untrusted separation
- immutable draft versions and server-side approval
- Gmail draft creation with deterministic idempotency
- audit trails and redaction helpers
- retention primitives and D1-backed tenant scoping

The current implementation remains intentionally limited to the private/workspace product boundary. The app is not a public SaaS system and is not complete as a production deployment.

## Implemented product scope

The current system includes:

- Secure tenant-aware app UI and workspace access flow
- Google OAuth connect flow with encrypted token storage and refresh handling
- Gmail thread sync with tenant isolation
- text/plain-only email processing with HTML and remote content ignored
- attachment metadata retention only; no attachment bytes are persisted
- OpenAI Responses API structured analysis with strict validation
- prompt-injection and content-boundary protections
- immutable draft versioning and approval requirements
- server-authoritative Gmail draft creation and idempotent execution
- deterministic audit chain and redaction on stored metadata
- ownership-bound retention primitives for expired message content

## Not yet complete

The following are not complete and are explicitly not represented as production-ready features:

- public SaaS authentication and session management
- multi-organisation sessions or invitations
- billing, account invitations, or customer plan flows
- complete account/tenant deletion
- scheduled retention automation
- final Google verification and security assessment
- final production deployment

## Historical reference

The historical pre-implementation audit for commit `9f8ce18` is preserved in [docs/repository-audit.md](docs/repository-audit.md). It is a historical baseline document, not a current product description.

## Demo separation

The old interactive simulation was moved under [examples/demo-ui](examples/demo-ui) and is intentionally separated from production code. Production routes and the SecureWorkspace app do not import the synthetic Northstar Goods demo data.

## Stack

- Next.js 16 with React 19
- Cloudflare Worker + D1 + Drizzle ORM
- vinext/Vite build tooling
- deterministic hashing and redaction utilities
- Google OAuth/Gmail REST integration
- OpenAI Responses API with structured output validation

## Local development

Requirements: Node.js 22.13+

```bash
npm ci
npm run dev
```

Keep Gmail and AI integration flags disabled unless the environment has been reviewed and approved by the owner. The repository does not contain public production credentials or a final production deployment configuration.

## Quality gates

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Documentation and readiness

Use the following docs for owner review and deployment gatekeeping:

- [docs/owner-setup-checklist.md](docs/owner-setup-checklist.md)
- [docs/production-readiness-checklist.md](docs/production-readiness-checklist.md)
- [docs/test-account-checklist.md](docs/test-account-checklist.md)
- [docs/security-and-privacy.md](docs/security-and-privacy.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/backup-restore.md](docs/backup-restore.md)
- [docs/incident-response.md](docs/incident-response.md)
- [docs/operations-runbook.md](docs/operations-runbook.md)
- [docs/provider-outage-runbook.md](docs/provider-outage-runbook.md)
- [docs/brand-clearance.md](docs/brand-clearance.md)
- [docs/branch-protection.md](docs/branch-protection.md)

## Security and compliance

The repository contains a current product implementation and a historical audit baseline. It does not claim final Google verification, production legal approval, final security assessment, or public deployment readiness.
