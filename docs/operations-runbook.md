# Operations runbook

This runbook describes the current implementation baseline and the operational work still required before launch.

## Normal operations

- Keep Gmail and AI feature flags disabled unless the environment has been reviewed and approved by the owner.
- Validate D1-backed tenant data and audit changes before using a staging or production environment.
- Review the latest build/test output before deployment and keep evidence for sign-off.

## Monitoring and signals

- Monitor OAuth failures, refresh failures, sync failures, approval failures, and ambiguous provider results.
- Monitor D1 errors, retention job execution, and audit-chain validation failures.
- Monitor feature-flag states and secret-manager access changes.

## Owner action required

- OWNER ACTION REQUIRED: assign operational ownership for deployments, D1 maintenance, and incident escalation.
- OWNER ACTION REQUIRED: define the production approval and maintenance windows.

See [docs/incident-response.md](incident-response.md), [docs/provider-outage-runbook.md](provider-outage-runbook.md), and [docs/backup-restore.md](backup-restore.md).
