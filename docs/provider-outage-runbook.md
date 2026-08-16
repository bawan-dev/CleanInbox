# Provider outage runbook

This is a placeholder for provider outage procedures and does not represent a final production runbook.

## Trigger conditions

- Google OAuth or Gmail API failures.
- OpenAI API failures or rate limits.
- D1 or environment interruption affecting tenant data access.

## Immediate actions

- Disable the affected capability in the reviewed environment if operationally required.
- Preserve evidence, including timestamps and error codes.
- Notify the designated operations owner and support escalation path.
- Avoid retry loops that can create duplicate provider-side side effects.

## Owner action required

- OWNER ACTION REQUIRED: confirm the final outage escalation contacts and on-call ownership.
- OWNER ACTION REQUIRED: confirm the provider-specific verification and retry rules for Google and OpenAI.

See [docs/incident-response.md](incident-response.md) and [docs/operations-runbook.md](operations-runbook.md).
