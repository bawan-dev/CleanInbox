# Backup and restore

This repository does not implement a final production backup plan; the owner must define and test the production process before a live deployment is considered ready.

## Current state

- D1 data is the primary database state.
- Application configuration and credentials must live in an approved external secret store.
- Source code and migrations are version-controlled, but database backup/restore is an owner-operated production task.

## Owner action required

- OWNER ACTION REQUIRED: define the production D1 backup schedule and retention period.
- OWNER ACTION REQUIRED: confirm who owns restoration testing and how it is validated.
- OWNER ACTION REQUIRED: confirm the recovery time objective and required evidence before a production restore is considered successful.

## Required before production use

- Review [docs/deployment.md](deployment.md)
- Review [docs/incident-response.md](incident-response.md)
- Review [docs/operations-runbook.md](operations-runbook.md)
- Verify migration and restore steps in a disposable environment before any production database use.
