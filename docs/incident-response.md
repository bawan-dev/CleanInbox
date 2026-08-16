# Incident response

This repository contains operational guidance only; it does not claim or replace a complete incident-response program.

## Immediate response principles

- Preserve evidence and keep the user-facing system safe.
- Remove or disable the affected capability only if required for safety or service continuity.
- Record the event, affected scope, and owner decision in the incident log.
- Do not disclose secret values, tokens, or raw Gmail content in issue or chat traffic.

## Current implementation boundaries

- Gmail and AI integration are opt-in and must be disabled in a production-like environment until owner review is complete.
- OAuth and draft creation failures must be handled without exposing tokens or provider payloads.
- Audit events are retained with redaction, but the project does not claim external audit immutability.

## Owner action required

- OWNER ACTION REQUIRED: confirm the named incident commander and escalation path.
- OWNER ACTION REQUIRED: confirm how credential revocation, provider outage handling, and customer notification are managed.
- OWNER ACTION REQUIRED: confirm the final backup/restore and support-contact workflow.

See [docs/provider-outage-runbook.md](provider-outage-runbook.md) for outage-specific handling.
