# ClearInbox

ClearInbox is a safety-first email intelligence and inbox operations workspace. This repository contains a polished interactive MVP of the core human-review workflow plus the deterministic policy, tenant-scoped schema and API foundations needed to evolve it into a connected product.

The interface runs in **Simulation + Safe Mode** by default. It never sends, forwards, deletes or archives real email.

## Included

- Prioritised triage queue with full-thread context
- Explicit facts, unverified information, entities, confidence and risk signals
- External reply drafts kept separate from internal analysis
- Human approval, escalation and archive safeguards
- Approval queue, draft workspace, audit timeline and automation controls
- Deterministic policy checks for modes, risk, confidence, capability and new-contact rules
- D1/Drizzle schema for tenants, memberships, mailboxes, messages, analyses, drafts, approvals, idempotent executions and append-oriented audits
- Server-side tenant resolution from authenticated workspace membership
- Responsive desktop and mobile layouts

## Run locally

Requirements: Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Then open the local URL printed by vinext.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

After changing `db/schema.ts`, generate and inspect a migration:

```bash
npm run db:generate
```

## Security model

- API tenant scope is derived from the authenticated user and server-side membership lookup. Client-provided tenant IDs are ignored.
- Safe Mode and prohibited-category controls are evaluated server-side.
- Missing settings fall back to safe defaults.
- Every durable record that belongs to a customer carries `tenant_id`; important provider and action identifiers use tenant-scoped unique indexes.
- Approvals bind to an exact action/content hash; executions use tenant-scoped idempotency keys and distinguish ambiguous results from success.
- Message content is treated as untrusted data and cannot change tenant settings.

The supplied operating specification is treated as a product and policy source, not as the only security boundary. Production mailbox ingestion, provider actions, attachment scanning, credential storage and background workers must remain behind independently tested deterministic controls.

## Hosting

The app uses vinext and the Sites-compatible Vite plugin. `.openai/hosting.json` declares the logical D1 binding as `DB`; hosted resource wiring is owned by Sites.
