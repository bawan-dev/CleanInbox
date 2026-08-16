# Owner setup checklist

Use this checklist for decisions and credentials that cannot be created safely from the repository. Keep Gmail and AI disabled until the production-readiness and test-account checklists are complete.

Do not paste secrets into issues, pull requests, chat, screenshots, logs, or this repository. Record only the secret-store reference and the responsible owner.

## 1. Decide the application boundary

- [ ] Approve Gmail-only, draft-only scope: read recent inbox threads, analyse them, and create Gmail drafts after an exact human approval.
- [ ] Confirm that sending, forwarding, deleting, trashing, archiving, and label changes are intentionally excluded.
- [ ] Select a canonical production origin: `https://<approved-host>`.
- [ ] Select a public authentication/session design. The current Sites-injected email header is private-workspace access control, not public SaaS authentication.
- [ ] Define verified-email, session lifetime, logout, account recovery, invite acceptance, and account-suspension rules.
- [ ] Decide whether users may belong to one organisation only. The current MVP database enforces a single active membership per email.
- [ ] Decide whether the same person may author and approve a draft. The current code allows this; it does not provide four-eyes separation.
- [ ] Name the owner for Google Cloud, secrets, D1 migrations, security incidents, and privacy requests.

Record decisions without credentials:

| Decision | Approved value/owner |
| --- | --- |
| Production origin | `<pending>` |
| Public auth/session provider | `<pending>` |
| Google Cloud project ID | `<pending>` |
| Secret manager | `<pending>` |
| D1 migration owner | `<pending>` |
| Security contact | `<pending>` |
| Privacy contact | `<pending>` |

## 2. Create a dedicated Google Cloud project

- [ ] Sign in with an organisation-controlled Google administrator account.
- [ ] Create or select a Google Cloud project dedicated to ClearInbox; do not reuse an unrelated production project.
- [ ] Add at least two organisation-controlled project owners and remove personal or stale accounts.
- [ ] Configure project contacts and billing/alerts if Google requires them.
- [ ] In **APIs & Services > Library**, enable **Gmail API**.
- [ ] Keep the project separate from any account containing real customer email during testing.

Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) covers the project, API, and web-client prerequisites.

## 3. Configure OAuth consent and audience

- [ ] Configure the application name, support email, approved logo/domain, and developer contact.
- [ ] Add only domains controlled by the business.
- [ ] Choose the audience deliberately:
  - **Internal** only if every permitted user belongs to the same eligible Google Workspace organisation.
  - **External / Testing** for dedicated test users while the app is unverified.
  - **External / Production** only after the applicable Google verification is complete.
- [ ] Add links to the reviewed production home page, privacy notice, and terms when Google requires them.
- [ ] Add the dedicated non-production Gmail/Workspace accounts from [test-account-checklist.md](test-account-checklist.md) as OAuth test users.
- [ ] Document which business feature needs each requested scope.

Request exactly:

```text
openid
email
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
```

Do not add `gmail.modify`, `gmail.send`, or `https://mail.google.com/`.

Google classifies `gmail.readonly` and `gmail.compose` as restricted scopes. `gmail.compose` is the narrowest scope accepted by `users.drafts.create`, but Google describes it as managing drafts **and sending email**; there is no create-only Gmail scope. ClearInbox constrains the grant in code by exposing only draft creation and read/reconciliation endpoints. Review Google's [scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes), [`users.drafts.create` scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create), and [restricted-scope security assessment](https://support.google.com/cloud/answer/13465431?hl=en).

## 4. Create the Google web OAuth client

- [ ] In **Google Auth Platform > Clients** (or **APIs & Services > Credentials**), create an OAuth client of type **Web application**.
- [ ] Give the client an environment-specific name such as `ClearInbox local test` or `ClearInbox production`.
- [ ] Register the exact local redirect URI:

```text
http://localhost:3000/api/gmail/callback
```

- [ ] After the production origin is approved, register the exact HTTPS redirect URI:

```text
https://<approved-host>/api/gmail/callback
```

- [ ] Do not use wildcards, a path without `/api/gmail/callback`, a different port, or a trailing slash unless the deployed URI also has it.
- [ ] Limit authorised JavaScript origins/redirects to the approved environments.
- [ ] Download/copy the client ID and client secret once, place them directly into the approved secret manager, and remove any downloaded credential file from local storage.
- [ ] Record the client ID as configuration metadata if desired; treat the client secret as a secret.

Google requires the redirect URI to match exactly, including scheme, case, port, path, and trailing slash. See the [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

## 5. Create and store application secrets

- [ ] Generate a cryptographically random 32-byte value and store its base64 encoding as `APP_ENCRYPTION_KEY`.
- [ ] Generate the future authentication/session secret required by the selected auth design; do not assume the existing unused `AUTH_SECRET` creates authentication.
- [ ] Store `GOOGLE_CLIENT_SECRET` and `OPENAI_API_KEY` only in environment-scoped secret storage.
- [ ] Restrict read/write access to the production service and named operators.
- [ ] Enable secret-access audit logging and document rotation/revocation owners.
- [ ] Use different values for local/test/production environments.
- [ ] Back up the encryption key through the approved recovery process. Losing it makes stored Gmail credentials undecryptable.
- [ ] Do not rotate `APP_ENCRYPTION_KEY` until a tested token re-encryption procedure exists; the repository currently has no online key-rotation workflow.

Expected configuration names are listed in `.env.example`. Keep these flags disabled while setting up:

```text
GMAIL_INTEGRATION_ENABLED=false
GMAIL_LABEL_MODIFICATION_ENABLED=false
AI_ANALYSIS_ENABLED=false
```

## 6. Configure the local test environment

- [ ] Copy `.env.example` to an untracked `.env.local`.
- [ ] Set `APP_BASE_URL=http://localhost:3000`.
- [ ] Set `GOOGLE_REDIRECT_URI=http://localhost:3000/api/gmail/callback`.
- [ ] Add only the dedicated test OAuth client credentials and test encryption key.
- [ ] Select and record an explicit test value for `OPENAI_MODEL`; the application has no model default.
- [ ] Apply the migrations to a disposable local D1 database:

```bash
npx wrangler d1 migrations apply DB --local
```

- [ ] Start with both integration flags `false` and run the full quality suite.
- [ ] Enable Gmail only in the isolated test environment when the test-account checklist is ready.
- [ ] Enable AI only after the OpenAI data-processing review below is complete.

## 7. Approve OpenAI use

- [ ] Select the OpenAI API organisation/project and a server-side API key with the narrowest practical ownership and budget controls.
- [ ] Select the explicit model to store in `OPENAI_MODEL` and record the reason/evaluation owner.
- [ ] Review the organisation's API data controls, retention terms, DPA, region/residency requirements, and subprocessors.
- [ ] Decide whether business email may be transmitted to the selected OpenAI account. Do not infer Zero Data Retention from `store: false`.
- [ ] Define a spend limit, usage alert, and key-rotation/revocation process.
- [ ] Use synthetic test messages only until legal/privacy review approves real business content.

The implementation uses the [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses) with `store: false` and [strict Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## 8. Prepare Google verification and security assessment

- [ ] Write a scope justification for full-thread reading (`gmail.readonly`) and Gmail draft creation (`gmail.compose`).
- [ ] Prepare a video showing consent, import, human approval, Gmail draft creation, disconnect, and data deletion/retention behavior.
- [ ] Ensure the privacy notice describes every stored/transmitted Gmail data category and each subprocessor.
- [ ] Implement and demonstrate the user data-deletion process before claiming it exists.
- [ ] Complete Google brand and restricted-scope verification as applicable.
- [ ] Because the service stores/transmits restricted Gmail data, budget and plan for Google's required security assessment and recurring obligations.
- [ ] Keep the app in test/internal access and below applicable user limits until Google confirms the production status.

## 9. Handoff evidence

- [ ] Record the non-secret Google project/client identifiers and secret-manager references.
- [ ] Record who approved the production origin, auth design, scopes, retention period, and OpenAI use.
- [ ] Attach successful test/build output and the sanitized evidence required by [production-readiness-checklist.md](production-readiness-checklist.md).
- [ ] Do not set either integration flag to `true` in production until every blocking item is signed off.
