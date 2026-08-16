# Security test coverage

This manifest maps the 30 security requirements in the owner brief to deterministic tests. Normal unit tests do not need Google credentials. Source-invariant tests are used for Cloudflare route and D1 boundaries that cannot be instantiated by Node's test runner; an optional deployed-D1 integration suite remains a production-readiness item.

| # | Requirement | Automated evidence | Coverage note |
|---:|---|---|---|
| 1 | Unauthenticated route rejection | `authentication boundary rejects a missing workspace identity before database access`; `every tenant API route derives identity and tenant context on the server` | Source invariant; deployed session integration still required. |
| 2 | Tenant A cannot access tenant B messages | `tenant-scoped mailbox lookup blocks cross-tenant sync before any provider call`; `direct tenant data routes and delegated workflows preserve tenant scoping` | Core behaviour plus route/query invariant. |
| 3 | Tenant A cannot access tenant B mailbox connection | `callback rejects incomplete permissions and cross-tenant provider-account reuse`; `direct tenant data routes and delegated workflows preserve tenant scoping` | Behaviour plus credential-store invariant. |
| 4 | Tenant A cannot access tenant B drafts | `tenant mismatch is hidden as not found before an execution is claimed`; `direct tenant data routes and delegated workflows preserve tenant scoping` | Core behaviour plus route/query invariant. |
| 5 | Tenant A cannot access tenant B audit events | `direct tenant data routes and delegated workflows preserve tenant scoping`; `every tenant API route derives identity and tenant context on the server` | Route/query invariant; deployed D1 integration still required. |
| 6 | OAuth state validation | `OAuth state, nonce, and PKCE values use secure URL-safe entropy`; `OAuth attempts are tenant-bound, actor-bound, expiring, and single-use` | Behaviour plus persistence invariant. |
| 7 | Expired OAuth state rejection | `OAuth attempts are tenant-bound, actor-bound, expiring, and single-use` | D1 expiry predicate invariant. |
| 8 | Reused OAuth state rejection | `callback consumes state once, validates identity/scopes, and stores only AAD-bound ciphertext`; `OAuth attempts are tenant-bound, actor-bound, expiring, and single-use` | Behaviour and single-use predicate. |
| 9 | OAuth callback tenant association | `callback state is bound to the exact tenant and authenticated owner` | Behaviour. |
| 10 | Token encryption and decryption | `AES-256-GCM encryption round trips only with the same tenant-bound AAD`; `AES-GCM uses a fresh IV and rejects tampering` | Behaviour. |
| 11 | Token values never returned to the client | `Gmail OAuth routes never serialize token or credential fields`; `disconnect revokes best-effort, always erases local credentials, and never returns a token` | Route invariant plus behaviour. |
| 12 | Duplicate Gmail message import prevention | `manual sync fetches complete threads, caps the limit, and deduplicates repeat imports` | Behaviour with mocked Gmail. |
| 13 | Duplicate thread import prevention | `manual sync fetches complete threads, caps the limit, and deduplicates repeat imports` | Behaviour with mocked Gmail. |
| 14 | Full-thread retrieval before draft generation | `manual sync fetches complete threads, caps the limit, and deduplicates repeat imports`; `normalization rejects list stubs and cross-thread messages as incomplete` | Behaviour with mocked Gmail. |
| 15 | Prompt injection remains untrusted | `prompt injection remains data inside the untrusted thread delimiters` | Behaviour. |
| 16 | Invalid structured AI output rejected | `invalid model structured output is rejected by the application schema`; `malformed JSON, incomplete responses, and refusals fail closed` | Behaviour. |
| 17 | Approval required before Gmail draft creation | `Gmail draft creation rejects a missing exact-version approval` | Behaviour. |
| 18 | Frontend approval flag cannot bypass the server | `protected draft routes cannot accept a browser approval boolean`; `Gmail draft creation requires a server-verified exact-version approval` | Route invariant plus policy behaviour. |
| 19 | Edited draft invalidates approval | `editing approved content changes its hash`; `Gmail draft creation rejects stale edited content and an approval hash mismatch` | Behaviour. |
| 20 | Draft content hash validation | `draft content hashes are stable across address order and line endings`; `an edit racing after the execution claim is caught by the immediate pre-call reload` | Behaviour. |
| 21 | Duplicate Gmail draft prevention | `double-click and later replay return the original verified Gmail draft`; `ambiguous provider result is reconciled by deterministic RFC Message-ID without another POST` | Behaviour with mocked Gmail. |
| 22 | Gmail API failure handling | `safe reads retry but draft creation never retries`; `definitive provider failure is recorded safely and is not retried in the same call` | Behaviour with mocked Gmail. |
| 23 | Gmail token revocation handling | `refresh and revoke use POST form requests without putting tokens in URLs`; `disconnect revokes best-effort, always erases local credentials, and never returns a token` | Behaviour. |
| 24 | Safe logging and secret redaction | `logging redaction removes secrets, email addresses, and message content`; `safe log metadata drops arbitrary payload fields and Error details` | Behaviour. |
| 25 | Secure mailbox disconnection | `disconnect revokes best-effort, always erases local credentials, and never returns a token`; `mutation request guard requires JSON and an exact same-origin browser request` | Behaviour. |
| 26 | Environment validation | `environment features are strictly disabled by default`; `enabled integrations fail closed when required secrets are absent`; `production OAuth configuration requires HTTPS and valid AES-256 material` | Behaviour. |
| 27 | HTML sanitisation | `normalization keeps text/plain and attachment metadata but never HTML or attachment bytes`; `message detail is text-only, blocks remote content, and keeps attachments metadata-only` | HTML is discarded rather than rendered. |
| 28 | Remote content protection | `message detail is text-only, blocks remote content, and keeps attachments metadata-only` | Route/UI invariant. |
| 29 | Reviewer role permissions | `owner and reviewer capabilities are guarded by the server-side role matrix` | Route role-matrix invariant. |
| 30 | Owner role permissions | `connection start is owner-only, fail-closed, and persists only hashed/encrypted OAuth material`; `owner and reviewer capabilities are guarded by the server-side role matrix` | Behaviour plus route role-matrix invariant. |

Additional draft-only boundary: `Gmail provider code exposes read operations and draft creation only` scans every Gmail/OAuth/sync/draft provider source and fails if send, modify, trash, delete, label-mutation, broader Gmail scopes, or HTTP `DELETE` capability appears.
