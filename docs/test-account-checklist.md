# Google test account checklist

Use dedicated test accounts only. Do not use real business user accounts or private customer mailboxes during implementation or validation.

## Required owner actions

- OWNER ACTION REQUIRED: confirm the Google Workspace or Gmail test accounts to use for end-to-end OAuth and draft verification.
- OWNER ACTION REQUIRED: confirm that the test accounts are isolated from real customer data and are approved for restricted-scope testing.

## Checklist

- [ ] Create dedicated Gmail test users with disposable mailboxes.
- [ ] Confirm test-account consent for OAuth testing and restricted-scope access.
- [ ] Verify only the approved Google redirect URI is used for the local or staging environment.
- [ ] Confirm both `gmail.readonly` and `gmail.compose` are requested only for approved accounts.
- [ ] Test connect, disconnect, reconnect, and refresh-token flows with a clean mailbox.
- [ ] Verify draft creation uses the approved tenant-bound idempotency pattern.
- [ ] Verify no send/forward/delete/archive or label mutation occurs through the product.
- [ ] Verify the UI shows draft-only behavior and never presents a sent-message result.
- [ ] Record any provider outage or quota limitation and follow the escalation path in [docs/provider-outage-runbook.md](provider-outage-runbook.md).

## Do not proceed

Do not move to production Google verification or public deployment until the owner confirms that all required test accounts, permissions, and privacy checks are complete.
