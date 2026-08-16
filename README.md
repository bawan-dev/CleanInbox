    # ClearInbox

ClearInbox is a Gmail-only inbox intelligence service that imports recent inbox threads, produces structured analysis and suggested replies, records an exact human approval, and creates a draft in Gmail. It is deliberately **draft-only**: it does not send, forward, delete, archive, or change Gmail labels.

## Current status

The repository contains implemented and automated-test-covered server foundations for tenant membership, Gmail OAuth, manual sync, structured AI analysis, draft versioning, approval integrity, Gmail draft creation, audit events, and message-body retention. Both Gmail and AI are disabled by default.

This is **not production-ready** yet:

- The visible React interface still uses demo data and simulation-only state; it is not wired to the new APIs.
- Authentication currently trusts the private Sites-provided `oai-authenticated-user-email` header. That is useful inside the authenticated Sites workspace, but it is not a public SaaS sign-in/session system.
- No live Google or OpenAI credentials have been configured or exercised in this repository.
- Production migrations, Google OAuth verification/security assessment, legal materials, scheduled retention, tenant deletion, monitoring, and end-to-end evidence remain owner/operator work.

The pre-implementation evidence is preserved in [docs/repository-audit.md](docs/repository-audit.md). Use the readiness documents below before enabling either integration.

## Product boundary

Allowed Gmail operations are intentionally limited to:

- Read the authenticated mailbox profile.
- List recent `INBOX` threads and retrieve each complete thread.
- List Gmail drafts by deterministic RFC `Message-ID` for reconciliation.
- Create a plain-text, thread-bound Gmail draft with `users.drafts.create`.

There is no Gmail provider method or route for sending, forwarding, deleting, trashing, archiving, modifying messages, or changing labels. `GMAIL_LABEL_MODIFICATION_ENABLED=true` is rejected by environment validation.

Google does not offer a draft-create-only OAuth scope. ClearInbox requests `openid`, `email`, `gmail.readonly`, and `gmail.compose`; Google describes `gmail.compose` as permission to manage drafts **and send email**. The code narrows that broader grant with an endpoint allowlist and contains no send operation. Both Gmail scopes are restricted scopes, so a public deployment that stores or transmits this data must complete Google's applicable verification and security-assessment process. See Google's [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes), [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), [draft guide](https://developers.google.com/workspace/gmail/api/guides/drafts), and [`users.drafts.create` reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create).

## Stack

- Next.js 16 and React 19
- vinext/Vite targeting a Cloudflare Worker
- Cloudflare D1 with Drizzle ORM and SQL migrations
- Zod validation and Web Crypto
- Direct Google OAuth/Gmail REST adapters
- OpenAI Responses API with strict structured output
- Sites deployment metadata in `.openai/hosting.json`

## Run locally

Requirements: Node.js `>=22.13.0`.

```bash
npm install
Copy-Item .env.example .env.local
npx wrangler d1 migrations apply DB --local
npm run dev
```

Open the URL printed by vinext. With both feature flags left `false`, the current UI runs as a simulation and no external provider is called.

Authenticated API development also requires an identity header that is normally injected by Sites. A manually supplied header is acceptable only in an isolated local test environment; it is not an authentication design and must never be trusted on a public endpoint.

### Environment contract

`.env.example` is the canonical list. Keep real values in an approved local/deployment secret store, never in Git.

| Name | Purpose |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production`. Production requires HTTPS URLs. |
| `APP_BASE_URL` | Canonical application origin used for same-origin checks and redirects. |
| `AUTH_SECRET` | Reserved for the future public authentication/session implementation; it is not currently consumed. |
| `APP_ENCRYPTION_KEY` | Base64-encoded 32-byte key used for AES-256-GCM credential encryption. |
| `GMAIL_INTEGRATION_ENABLED` | Strict opt-in; defaults to `false`. |
| `GMAIL_LABEL_MODIFICATION_ENABLED` | Must remain `false` for this MVP. |
| `GOOGLE_CLIENT_ID` | Google web OAuth client ID, required only when Gmail is enabled. |
| `GOOGLE_CLIENT_SECRET` | Google web OAuth client secret, required only when Gmail is enabled. |
| `GOOGLE_REDIRECT_URI` | Exact registered OAuth callback. Local value: `http://localhost:3000/api/gmail/callback`. |
| `AI_ANALYSIS_ENABLED` | Strict opt-in; defaults to `false`. |
| `OPENAI_API_KEY` | Server-only OpenAI API key, required only when AI is enabled. |
| `OPENAI_MODEL` | Explicit owner-selected model identifier; there is no implicit default. |

The encryption key must remain stable for existing encrypted tokens. Ciphertexts use AES-256-GCM with a fresh IV and authenticated additional data (AAD) binding the tenant ID, resource type, record ID, and field name. Moving ciphertext to another tenant, record, or token field therefore fails authentication. The current implementation records key version `1` but does not yet provide an online key-rotation workflow.

## D1 migrations

Drizzle migrations live in `drizzle/`; `wrangler.jsonc` binds the local database as `DB` and points Wrangler to that directory.

After changing `db/schema.ts`:

```bash
npm run db:generate
git diff -- db/schema.ts drizzle/
npx wrangler d1 migrations apply DB --local
```

Inspect every generated migration and test it against disposable data before applying it. Do not apply migrations to a hosted database until the production D1 binding, backup/restore procedure, and migration owner have been confirmed.

## Google Cloud and Gmail setup

Use [docs/owner-setup-checklist.md](docs/owner-setup-checklist.md) for the full sequence. In summary:

1. Create or select a dedicated Google Cloud project and enable the Gmail API.
2. Configure the OAuth consent/branding and audience.
3. Add only the four scopes listed above.
4. Create a **Web application** OAuth client.
5. Register the exact local callback `http://localhost:3000/api/gmail/callback` and the final HTTPS production callback `https://<approved-host>/api/gmail/callback`.
6. Store credentials in the local/deployment secret store, add dedicated test users, and keep `GMAIL_INTEGRATION_ENABLED=false` until the readiness gate passes.

The OAuth implementation uses one-time, ten-minute state records bound to the tenant and authenticated owner, PKCE S256, an OpenID Connect nonce, exact redirect matching, server-side code exchange, ID-token issuer/audience/expiry/nonce validation, exact scope validation, encrypted access/refresh tokens, refresh-token preservation on reconnection, and best-effort provider revocation on disconnect.

## Data and AI workflow

Manual sync is tenant-scoped and idempotent. It imports up to the tenant's configured recent `INBOX` thread limit (default 25, maximum 100), fetches every listed thread in full, and writes the thread-complete marker only after all messages are persisted. Only decoded `text/plain` parts and selected headers/metadata are stored. HTML bodies are ignored, remote content is not fetched, and attachment bytes are not downloaded; only filename, MIME type, size, and provider attachment ID are retained.

AI analysis is also opt-in and manual. The implementation:

- Uses the OpenAI Responses API.
- Sends `store: false`.
- Separates trusted application/business configuration from the complete, explicitly delimited untrusted email thread.
- Uses `text.format` with a strict JSON Schema, then parses and validates the raw `output_text` again with Zod.
- Rejects malformed, incomplete, refused, or schema-invalid results and never treats model output as authorization.

OpenAI documents the [Responses API migration and storage controls](https://developers.openai.com/api/docs/guides/migrate-to-responses) and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). `store: false` is an API request setting, not by itself a Zero Data Retention or regulatory-compliance claim; review the selected account's contract and data controls before using business email.

## Approval and Gmail draft creation

Drafts are immutable versions. Approval binds tenant, mailbox, message, thread, draft, exact version, and canonical content hash into a server-calculated action hash. Editing creates a new version and revokes pending/approved decisions for older content. An approval expires after 30 minutes.

Gmail draft creation derives a tenant-scoped idempotency key and deterministic RFC `Message-ID` from the approved version. Duplicate requests return the existing verified result. The non-idempotent Gmail `POST` is never automatically retried. If its outcome is ambiguous, a later request first searches Gmail by RFC `Message-ID`; a new POST requires an explicit reconciliation retry choice. Successful output is a Gmail draft, never a sent message.

The current role model permits both `owner` and `reviewer` to edit, approve, and create the Gmail draft. It does not enforce separation of duties between author and approver.

## Retention and disconnect

Imported message bodies receive a tenant-configured retention deadline (default 30 days, allowed range 1–365 days). The owner-only retention endpoint redacts expired `textBody` and `snippet` values and removes expired OAuth-attempt records. It is currently a manual operation: no scheduled job calls it. Headers, message metadata, hashes, analyses, draft versions, audits, and Gmail-created drafts are not deleted by this job; the `retainDraftAfterGmailCreation` setting is stored but not yet enforced.

Disconnect attempts to revoke the refresh/access token, then removes local encrypted credentials even if provider revocation fails and marks the mailbox disconnected. It does not delete imported tenant data or drafts already present in Gmail.

See [docs/security-and-privacy.md](docs/security-and-privacy.md) for the complete data inventory and limitations.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The unit suite covers feature gates, AES-GCM/AAD behavior, redacted logging, OAuth state/PKCE/nonce/token handling, cross-tenant connection/sync checks, metadata-only attachments, structured AI output and prompt injection, approval staleness, and Gmail draft idempotency/reconciliation. These tests use fakes; they are not a substitute for the dedicated Google test-account checklist.

## Deployment

The application uses vinext and the Sites-compatible Vite plugin. `.openai/hosting.json` declares the logical D1 binding `DB`; hosted resource wiring is owned by Sites.

Do not enable Gmail or AI merely because a build deploys successfully. First complete:

- [Owner setup checklist](docs/owner-setup-checklist.md)
- [Production readiness checklist](docs/production-readiness-checklist.md)
- [Dedicated test-account checklist](docs/test-account-checklist.md)
- [Security and privacy review](docs/security-and-privacy.md)

The production URL and public authentication architecture are still owner decisions. Until they are implemented and verified, keep the deployment private and the integrations disabled.
