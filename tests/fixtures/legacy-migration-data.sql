PRAGMA foreign_keys=ON;

INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
VALUES ('tenant-legacy', 'legacy', 'Legacy Tenant', 'active', 1, 1);

INSERT INTO memberships (id, tenant_id, user_email, role, status, created_at, updated_at)
VALUES ('membership-legacy', 'tenant-legacy', 'owner@example.test', 'admin', 'active', 1, 1);

INSERT INTO tenant_settings (id, tenant_id, created_at, updated_at)
VALUES ('settings-legacy', 'tenant-legacy', 1, 1);

INSERT INTO mailboxes (id, tenant_id, provider, provider_mailbox_id, address, status, credential_reference, created_at, updated_at)
VALUES ('mailbox-legacy', 'tenant-legacy', 'demo', 'provider-account-legacy', 'owner@example.test', 'active', 'legacy-reference', 1, 1);

INSERT INTO threads (id, tenant_id, mailbox_id, provider_thread_id, subject, status, last_message_at, created_at, updated_at)
VALUES ('thread-legacy', 'tenant-legacy', 'mailbox-legacy', 'provider-thread-legacy', 'Legacy thread', 'open', 1, 1, 1);

INSERT INTO messages (id, tenant_id, mailbox_id, thread_id, provider_message_id, sender_email, recipients_json, copied_recipients_json, subject, text_body, received_at, content_hash, ingestion_status, created_at, updated_at)
VALUES ('message-legacy', 'tenant-legacy', 'mailbox-legacy', 'thread-legacy', 'provider-message-legacy', 'sender@example.test', '["owner@example.test"]', '[]', 'Legacy thread', 'Legacy body', 1, 'legacy-content-hash', 'analysed', 1, 1);

INSERT INTO message_analyses (id, tenant_id, message_id, version, primary_category, priority, sentiment, sender_intent, summary, confidence_score, review_required, automation_eligibility_json, audit_reason, prompt_version, created_at)
VALUES ('analysis-legacy', 'tenant-legacy', 'message-legacy', 1, 'support', 'normal', 'neutral', 'question', 'Legacy analysis', 90, true, '{}', 'Legacy reason', 'legacy-v1', 1);

INSERT INTO drafts (id, tenant_id, message_id, status, current_version, created_by, created_at, updated_at)
VALUES ('draft-legacy', 'tenant-legacy', 'message-legacy', 'approved', 1, 'owner@example.test', 1, 1);

INSERT INTO draft_versions (id, tenant_id, draft_id, version, recipients_json, subject, body, content_hash, author_type, created_by, created_at)
VALUES ('draft-version-legacy', 'tenant-legacy', 'draft-legacy', 1, '["sender@example.test"]', 'Re: Legacy thread', 'Legacy reply', 'legacy-draft-hash', 'human', 'owner@example.test', 1);

INSERT INTO approval_requests (id, tenant_id, message_id, draft_version_id, action_type, action_hash, status, requested_by, decided_by, decided_at, created_at, updated_at)
VALUES ('approval-legacy', 'tenant-legacy', 'message-legacy', 'draft-version-legacy', 'reply', 'legacy-action-hash', 'approved', 'owner@example.test', 'owner@example.test', 1, 1, 1);

INSERT INTO action_executions (id, tenant_id, message_id, approval_request_id, action_type, idempotency_key, status, provider_result_reference, attempted_at, completed_at, created_at, updated_at)
VALUES ('execution-legacy', 'tenant-legacy', 'message-legacy', 'approval-legacy', 'reply', 'legacy-idempotency', 'succeeded', 'legacy-provider-reference', 1, 1, 1, 1);

INSERT INTO audit_events (id, tenant_id, message_id, thread_id, actor_type, actor_id, event_type, action, status, event_hash, created_at)
VALUES ('audit-legacy', 'tenant-legacy', 'message-legacy', 'thread-legacy', 'user', 'owner@example.test', 'legacy.event', 'legacy_action', 'success', 'legacy-event-hash', 1);

