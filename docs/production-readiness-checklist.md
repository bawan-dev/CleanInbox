# Production readiness checklist

This is a blocking launch gate, not a statement of current compliance. Leave `GMAIL_INTEGRATION_ENABLED=false` and `AI_ANALYSIS_ENABLED=false` in every production-like environment until all required items have an owner, evidence, and sign-off.

## Current gate status

- [x] Server-side Gmail adapter is allowlisted to reads, draft reconciliation, and `users.drafts.create`.
- [x] Gmail and AI are strict opt-ins and label modification is rejected.
- [x] OAuth, token encryption, sync, structured analysis, exact-version approval, idempotency, redaction helpers, and retention primitives have automated unit coverage.
- [ ] Public SaaS authentication and secure sessions are implemented.
- [ ] The real UI is wired to the tenant-scoped APIs; demo claims and local-only mutations are removed or clearly separated.
- [ ] Live Google/OpenAI end-to-end tests have passed with dedicated non-production accounts.
- [ ] The legal, Google verification, operational, deletion, and incident-response requirements below are complete.

The historical starting point is [repository-audit.md](repository-audit.md). Re-run a focused security review after the UI/auth integration because those are material trust-boundary changes.

## 1. Identity, sessions, and tenant isolation

- [ ] Replace the Sites-only identity-header dependency with an approved public auth/session design, or explicitly limit the product to a private Sites workspace.
- [ ] Ensure the edge strips client-supplied identity headers and only trusted infrastructure can inject the authenticated identity.
- [ ] Use verified identities, secure `HttpOnly`/`Secure`/`SameSite` cookies, session rotation, logout/revocation, bounded lifetime, and recovery controls.
- [ ] Add explicit CSRF protection appropriate to the final session design for every mutation route; retain origin/fetch-site checks as defense in depth.
- [ ] Protect the page as well as every API. Unauthenticated requests must not receive demo/customer data that could be mistaken for a real workspace.
- [ ] Test owner/reviewer permissions on every route and service operation.
- [ ] Decide and enforce author/approver separation if the business requires four-eyes approval.
- [ ] Add invitation acceptance and prove that an email cannot be silently added to an organisation without the intended identity flow.
- [ ] Prove cross-tenant denial for messages, threads, mailboxes, credentials, settings, members, analyses, drafts, approvals, executions, sync runs, retention, and audits.
- [ ] Review the remaining ID-only foreign keys and add transactional or database-enforced tenant-consistency guarantees where needed.
- [ ] Add rate limits and abuse controls for tenant creation, OAuth start/callback, sync, analysis, approval, and Gmail draft creation.

## 2. User interface and product truthfulness

- [ ] Replace `lib/demo-data.ts` and component-local approval/archive/settings actions in the production interface with authenticated APIs.
- [ ] Remove or relabel simulation-only buttons, counts, identities, scan claims, and audit events.
- [ ] Show the connected Gmail address, last successful sync, safe error/re-auth state, and disconnect action.
- [ ] Show complete imported thread text as plain text; do not introduce raw email HTML without an independently reviewed sanitizer and remote-content policy.
- [ ] Show attachment entries as **metadata only**, never as scanned or safe.
- [ ] Require a visible review of recipients, subject, body, version, approval expiry, and Gmail-draft result.
- [ ] Never display a “sent” result. The terminal provider success is “draft created in Gmail”.
- [ ] Ensure keyboard, screen-reader, responsive, empty, loading, error, stale-approval, and ambiguous-result states are tested.

## 3. Database and migrations

- [ ] Review `db/schema.ts` and every SQL file in `drizzle/` line by line.
- [ ] Restore the legacy fixture into a disposable D1 database and apply all migrations successfully.
- [ ] Test fresh-database creation and upgrade from the currently deployed schema.
- [ ] Confirm foreign keys are enabled and `PRAGMA foreign_key_check` returns no failures.
- [ ] Resolve every nullable backfill/legacy-role assumption before production data exists.
- [ ] Define the production D1 binding and environment ownership; do not reuse the placeholder local database ID.
- [ ] Establish automated backups, restore drills, migration rollback/forward-fix rules, and deployment ordering.
- [ ] Apply migrations in staging, run smoke tests, take a backup, then record a separately approved production migration window.
- [ ] Add a scheduled, idempotent retention job; the current owner endpoint is manual.
- [ ] Implement complete tenant/account deletion and verified purge of credentials, imported content, derived analyses/drafts, memberships, and applicable audit data.

## 4. Google OAuth and Gmail

- [ ] Complete [owner-setup-checklist.md](owner-setup-checklist.md) using a dedicated Google Cloud project.
- [ ] Register exact local/staging/production HTTPS redirect URIs ending in `/api/gmail/callback`.
- [ ] Request only `openid`, `email`, `gmail.readonly`, and `gmail.compose`.
- [ ] Document that `gmail.compose` can authorize sends even though ClearInbox exposes no send operation; retain an automated endpoint/code scan as release evidence.
- [ ] Complete Google's applicable brand and restricted-scope OAuth verification.
- [ ] Complete the required security assessment for server-side storage/transmission of restricted Gmail data and track recurring/reverification dates.
- [ ] Review the [Gmail scope rules](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), and [security-assessment requirements](https://support.google.com/cloud/answer/13465431?hl=en) at launch time.
- [ ] Confirm the consent screen, support contacts, privacy/terms URLs, test users, scope justifications, and verification video match deployed behavior.
- [ ] Verify one-time/expiring state, owner/tenant binding, PKCE, nonce, ID-token claims, exact scopes, duplicate provider-account denial, refresh, reconnection, and disconnect against real test accounts.
- [ ] Define how operators handle refresh-token revocation, account disabled, scope withdrawal, quota exhaustion, 429s, and Gmail outages.
- [ ] Confirm disconnect deletes local credentials even if provider revocation fails, surfaces that distinction safely, and provides the user separate local-data deletion instructions.

## 5. Gmail sync and content safety

- [ ] Run the complete [test-account-checklist.md](test-account-checklist.md) with synthetic data only.
- [ ] Verify the initial sync limit and `INBOX` filter with real Gmail responses.
- [ ] Verify every listed thread is retrieved in `full` format and the complete marker is written last.
- [ ] Verify repeat sync requests and repeated provider messages do not duplicate tenant records.
- [ ] Add an incremental/background sync design or clearly document that refresh is manual; storing a history ID does not make synchronization continuous.
- [ ] Confirm HTML parts, remote images, tracking pixels, and attachment bytes are never fetched or stored.
- [ ] Confirm only `text/plain` data and attachment metadata are shown or passed to AI.
- [ ] Evaluate maximum thread/message sizes, timeouts, pagination, quota behavior, and resource exhaustion using safe synthetic fixtures.
- [ ] Add malware/content scanning before ever enabling attachment bytes or extracts; until then keep `attachmentsEnabled=false` and avoid “scanned” claims.

## 6. AI data processing and evaluation

- [ ] Approve the OpenAI account/project, explicit model, API data controls, retention terms, DPA, subprocessors, transfer mechanism, and permitted business-email use.
- [ ] Confirm the deployed request uses the Responses API, `store: false`, and strict `text.format` JSON Schema as documented by OpenAI's [Responses guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
- [ ] Do not claim Zero Data Retention or regulatory compliance unless the account contract and configuration independently establish it.
- [ ] Run an evaluation set covering priority, facts versus inference, missing information, financial/legal risk, reply necessity, and safe suggested replies.
- [ ] Run prompt-injection, delimiter imitation, data-exfiltration, cross-tenant, malicious link, and payment-detail-change tests.
- [ ] Verify provider refusals, malformed output, incomplete responses, timeouts, and rate limits fail closed without exposing raw email/provider bodies in errors.
- [ ] Add budget caps, per-tenant usage limits, monitoring, and a kill switch.
- [ ] Establish a model-change review: schema compatibility, evaluation threshold, owner approval, rollback, and release evidence.

## 7. Approval and Gmail-draft integrity

- [ ] Verify recipients are derived from the imported message and cannot be replaced through an untrusted client request.
- [ ] Verify edits always create a new immutable version and revoke prior approval.
- [ ] Verify approval binds tenant, mailbox, message, thread, draft, version ID/number, canonical content hash, action, approver, and expiry.
- [ ] Verify the exact version/hash is reloaded immediately before the provider call and racing edits fail closed.
- [ ] Verify the provider thread ID and `In-Reply-To`/`References`/subject satisfy Gmail threading requirements.
- [ ] Verify deterministic idempotency and RFC `Message-ID` return one provider draft on double-click and replay.
- [ ] Verify draft-creation POSTs are never automatically retried.
- [ ] Verify ambiguous outcomes reconcile by RFC `Message-ID` before any optional explicit retry.
- [ ] Define operator handling for a persistent ambiguous outcome; do not tell users to click repeatedly.
- [ ] Verify Gmail returns the expected draft/message/thread identifiers before marking success.
- [ ] Decide and implement local draft-body disposal after provider success; the current `retainDraftAfterGmailCreation` setting is not enforced.

## 8. Secrets and cryptography

- [ ] Store Google/OpenAI credentials and `APP_ENCRYPTION_KEY` in an environment-scoped managed secret store, never source or ordinary D1 fields.
- [ ] Restrict secret access, enable access logs, and separate local/staging/production values.
- [ ] Verify `APP_ENCRYPTION_KEY` decodes to exactly 32 bytes and is backed up through approved recovery controls.
- [ ] Implement and exercise token-key rotation/re-encryption before rotating the current version-1 key.
- [ ] Verify AES-GCM AAD binds tenant, resource type, record ID, and field; test copied/swapped ciphertext failures in staging.
- [ ] Revoke and replace any credential suspected of appearing in a log, screenshot, support ticket, build artifact, or Git history.
- [ ] Run secret scanning over Git history, artifacts, source maps, Worker bindings, and deployment configuration.

## 9. Privacy, legal, and customer controls

- [ ] Publish reviewed privacy notice and terms matching actual data flow and product limitations.
- [ ] Complete controller/processor analysis, lawful-basis review, data-processing agreement, and any required DPIA.
- [ ] Publish a current subprocessor list covering at least the hosting/database, Google, and OpenAI services actually used.
- [ ] Document international-transfer and data-residency positions for every provider.
- [ ] Define retention by category: OAuth attempts/tokens, message text, metadata, attachments metadata, analyses, drafts, executions, and audit events.
- [ ] Implement user/tenant export, correction, access, disconnect, and deletion procedures with identity verification and completion evidence.
- [ ] Establish backup-deletion timing and downstream/provider deletion responsibilities.
- [ ] Publish security and privacy contact addresses and support escalation paths.
- [ ] Review Google's Workspace API user-data policy and prohibited-use restrictions; do not use Gmail data for ads, unrelated model training, or undisclosed purposes.
- [ ] Add clear consent/notice before Gmail connection and before email content is sent to OpenAI.

See [security-and-privacy.md](security-and-privacy.md) for the current implementation inventory and unresolved legal placeholders.

## 10. Security and operations

- [ ] Perform threat modelling and independent application/security review after public auth and UI integration.
- [ ] Run dependency, static, secret, and infrastructure scans; triage all production-dependency findings.
- [ ] Validate CSP and security headers in the final deployed Worker. Minimise/remove `unsafe-inline` where practical.
- [ ] Confirm API responses are `no-store` and error/log/audit paths omit tokens, message bodies, addresses, and raw provider output.
- [ ] Harden audit append concurrency and database permissions; the application hash chain is not a substitute for an immutable external log.
- [ ] Add structured metrics and alerts that use tenant-safe identifiers and error codes, not customer content.
- [ ] Define SLOs and alerts for OAuth failures, refresh failures, sync failures, AI failures, ambiguous draft creation, retention lag, quota, and D1 errors.
- [ ] Prepare incident response, breach assessment/notification, key/token revocation, provider contact, customer communication, and forensic preservation runbooks.
- [ ] Exercise backup restore, Gmail/OpenAI outage, leaked key, revoked consent, D1 migration failure, and tenant-deletion drills.
- [ ] Define on-call ownership and a reversible integration kill switch.

## 11. Release evidence and sign-off

- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] Production dependency audit and secret scan pass or have approved, documented exceptions.
- [ ] Fresh and upgrade migrations pass on disposable/staging D1 databases.
- [ ] Dedicated Google test-account evidence passes without real customer data.
- [ ] Browser/UI verification passes against the deployed staging environment.
- [ ] Google verification/security-assessment evidence is recorded.
- [ ] Legal/privacy, security, operations, product, and owner approvals are recorded with dates.
- [ ] Production secrets and bindings are injected and independently checked without exposing their values.
- [ ] Gmail and AI are enabled only in a controlled release after all prior checks are complete.

Launch approval:

| Area | Approver | Date | Evidence reference |
| --- | --- | --- | --- |
| Product boundary | `<pending>` | `<pending>` | `<pending>` |
| Security | `<pending>` | `<pending>` | `<pending>` |
| Privacy/legal | `<pending>` | `<pending>` | `<pending>` |
| Google verification | `<pending>` | `<pending>` | `<pending>` |
| Operations | `<pending>` | `<pending>` | `<pending>` |
| Business owner | `<pending>` | `<pending>` | `<pending>` |
