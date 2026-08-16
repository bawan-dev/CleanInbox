import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateApprovalActionHash,
  calculateDraftContentHash,
  calculateDraftCreationIdempotencyKey,
  createDeterministicRfcMessageId,
} from "../lib/drafts/integrity";

test("draft content hashes are stable across address order and line endings", async () => {
  const first = await calculateDraftContentHash({
    recipients: ["A@example.com", "b@example.com"],
    subject: "Re: Invoice",
    body: "Hello\r\nWorld",
  });
  const second = await calculateDraftContentHash({
    recipients: ["b@example.com", "a@example.com"],
    subject: "Re: Invoice",
    body: "Hello\nWorld",
  });

  assert.equal(first, second);
});

test("editing approved content changes its hash", async () => {
  const original = await calculateDraftContentHash({
    recipients: ["customer@example.com"],
    subject: "Re: Request",
    body: "Approved copy",
  });
  const edited = await calculateDraftContentHash({
    recipients: ["customer@example.com"],
    subject: "Re: Request",
    body: "Edited copy",
  });

  assert.notEqual(original, edited);
});

test("approval, idempotency, and RFC message IDs bind to the exact draft version", async () => {
  const identity = {
    tenantId: "tenant-a",
    mailboxId: "mailbox-a",
    messageId: "message-a",
    threadId: "thread-a",
    draftId: "draft-a",
    draftVersionId: "version-a",
    draftVersion: 2,
    contentHash: "abc123",
  };

  assert.equal(
    await calculateApprovalActionHash(identity),
    await calculateApprovalActionHash(identity),
  );
  assert.equal(
    await calculateDraftCreationIdempotencyKey(identity),
    await calculateDraftCreationIdempotencyKey(identity),
  );
  assert.match(await createDeterministicRfcMessageId(identity), /^<clearinbox\.[a-f0-9]+@drafts\.invalid>$/);

  assert.notEqual(
    await calculateDraftCreationIdempotencyKey(identity),
    await calculateDraftCreationIdempotencyKey({ ...identity, draftVersion: 3 }),
  );
});

test("header injection is rejected before hashing", async () => {
  await assert.rejects(
    calculateDraftContentHash({
      recipients: ["customer@example.com\r\nBcc: attacker@example.com"],
      subject: "Re: Request",
      body: "Body",
    }),
    /invalid header/i,
  );
});

