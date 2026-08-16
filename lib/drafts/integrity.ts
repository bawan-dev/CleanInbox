export type DraftContent = {
  recipients: string[];
  copiedRecipients?: string[];
  subject: string;
  body: string;
};

export type ApprovedDraftIdentity = {
  tenantId: string;
  mailboxId: string;
  messageId: string;
  threadId: string;
  draftId: string;
  draftVersionId: string;
  draftVersion: number;
  contentHash: string;
};

function normalizeAddress(address: string) {
  const normalized = address.trim().toLowerCase();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error("Draft recipient contains an invalid header value.");
  }
  return normalized;
}

function normalizeHeader(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`Draft ${field} contains an invalid header value.`);
  }
  return normalized;
}

function stableContent(content: DraftContent) {
  return JSON.stringify({
    recipients: [...new Set(content.recipients.map(normalizeAddress))].sort(),
    copiedRecipients: [...new Set((content.copiedRecipients ?? []).map(normalizeAddress))].sort(),
    subject: normalizeHeader(content.subject, "subject"),
    body: content.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function calculateDraftContentHash(content: DraftContent) {
  return sha256Hex(stableContent(content));
}

export async function calculateApprovalActionHash(identity: ApprovedDraftIdentity) {
  return sha256Hex(
    JSON.stringify({
      action: "create_gmail_draft",
      tenantId: identity.tenantId,
      mailboxId: identity.mailboxId,
      messageId: identity.messageId,
      threadId: identity.threadId,
      draftId: identity.draftId,
      draftVersionId: identity.draftVersionId,
      draftVersion: identity.draftVersion,
      contentHash: identity.contentHash,
    }),
  );
}

export async function calculateDraftCreationIdempotencyKey(identity: ApprovedDraftIdentity) {
  return sha256Hex(`gmail-draft:${await calculateApprovalActionHash(identity)}`);
}

export async function createDeterministicRfcMessageId(identity: ApprovedDraftIdentity) {
  const key = await calculateDraftCreationIdempotencyKey(identity);
  return `<clearinbox.${key.slice(0, 48)}@drafts.invalid>`;
}

