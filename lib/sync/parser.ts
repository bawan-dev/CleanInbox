import type { GmailHeader, GmailMessage, GmailMessagePart, GmailThread } from "../gmail";
import { sha256Hex } from "../security/crypto";
import type {
  NormalizedAttachment,
  NormalizedMessage,
  NormalizedThread,
} from "./types";

const MAX_HEADER_LENGTH = 8_192;
const MAX_SNIPPET_LENGTH = 1_000;
const MAX_TEXT_PART_ENCODED_LENGTH = 1_500_000;
const MAX_TEXT_BODY_LENGTH = 1_000_000;
const MAX_ATTACHMENTS = 100;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const RFC_MESSAGE_ID_PATTERN = /<[^<>\r\n]{1,250}>/gu;

export class GmailPayloadError extends Error {
  readonly code = "GMAIL_PAYLOAD_INVALID";

  constructor() {
    super("Gmail returned a message payload that could not be imported safely.");
    this.name = "GmailPayloadError";
  }
}

function cleanHeader(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, MAX_HEADER_LENGTH);
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  const match = headers?.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  return cleanHeader(match?.value);
}

function parseAddresses(value: string): string[] {
  const matches = value.match(EMAIL_PATTERN) ?? [];
  return [...new Set(matches.map((address) => address.toLowerCase()))].slice(0, 200);
}

function parseSender(value: string): { name?: string; email: string } {
  const [email] = parseAddresses(value);
  if (!email) throw new GmailPayloadError();

  const bracketIndex = value.lastIndexOf("<");
  const name = bracketIndex > 0
    ? cleanHeader(value.slice(0, bracketIndex)).replace(/^['"]|['"]$/gu, "").trim()
    : undefined;
  return { email, ...(name ? { name: name.slice(0, 512) } : {}) };
}

function normalizeRfcMessageId(value: string): string | undefined {
  const [match] = value.match(RFC_MESSAGE_ID_PATTERN) ?? [];
  return match;
}

function parseReferences(value: string): string[] {
  return [...new Set(value.match(RFC_MESSAGE_ID_PATTERN) ?? [])].slice(0, 50);
}

function decodeBase64UrlText(value: string | undefined): string {
  if (!value || value.length > MAX_TEXT_PART_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return "";
  }

  try {
    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false })
      .decode(bytes)
      .replace(/\u0000/gu, "")
      .replace(/\r\n?/gu, "\n");
  } catch {
    return "";
  }
}

function isAttachment(part: GmailMessagePart): boolean {
  const disposition = header(part.headers, "Content-Disposition").toLowerCase();
  return Boolean(part.filename?.trim() || part.body?.attachmentId || disposition.startsWith("attachment"));
}

function collectPlainText(part: GmailMessagePart | undefined, output: string[]): void {
  if (!part || output.join("\n").length >= MAX_TEXT_BODY_LENGTH) return;

  if (part.mimeType?.toLowerCase() === "text/plain" && !isAttachment(part)) {
    const decoded = decodeBase64UrlText(part.body?.data);
    if (decoded) output.push(decoded);
  }

  for (const child of part.parts ?? []) collectPlainText(child, output);
}

function collectAttachments(
  part: GmailMessagePart | undefined,
  output: NormalizedAttachment[],
  path = "0",
): void {
  if (!part || output.length >= MAX_ATTACHMENTS) return;

  if (isAttachment(part)) {
    const providerAttachmentId = cleanHeader(part.body?.attachmentId)
      || `part-${cleanHeader(part.partId) || path}`;
    output.push({
      providerAttachmentId: providerAttachmentId.slice(0, 512),
      filename: cleanHeader(part.filename) || "unnamed-attachment",
      mimeType: cleanHeader(part.mimeType) || "application/octet-stream",
      sizeBytes: Number.isSafeInteger(part.body?.size) && (part.body?.size ?? -1) >= 0
        ? Math.min(part.body?.size ?? 0, 2_147_483_647)
        : 0,
    });
  }

  for (const [index, child] of (part.parts ?? []).entries()) {
    collectAttachments(child, output, `${path}.${index}`);
  }
}

function receivedAt(message: GmailMessage, headers: GmailHeader[] | undefined, now: Date): Date {
  const internal = Number(message.internalDate);
  if (Number.isSafeInteger(internal) && internal > 0 && internal <= now.getTime() + 86_400_000) {
    return new Date(internal);
  }

  const parsedHeader = Date.parse(header(headers, "Date"));
  if (Number.isFinite(parsedHeader) && parsedHeader > 0 && parsedHeader <= now.getTime() + 86_400_000) {
    return new Date(parsedHeader);
  }
  return new Date(now);
}

function assertProviderId(value: string): void {
  if (!PROVIDER_ID_PATTERN.test(value)) throw new GmailPayloadError();
}

async function normalizeMessage(
  message: GmailMessage,
  options: { now: Date; retentionDays: number },
): Promise<NormalizedMessage> {
  assertProviderId(message.id);
  const headers = message.payload?.headers;
  const from = parseSender(header(headers, "From"));
  const received = receivedAt(message, headers, options.now);
  const textParts: string[] = [];
  collectPlainText(message.payload, textParts);
  const textBody = textParts
    .join("\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .slice(0, MAX_TEXT_BODY_LENGTH);
  const attachments: NormalizedAttachment[] = [];
  collectAttachments(message.payload, attachments);
  const subject = header(headers, "Subject") || "(no subject)";
  const replyTo = parseAddresses(header(headers, "Reply-To"))[0];
  const recipients = parseAddresses(header(headers, "To"));
  const copiedRecipients = parseAddresses(header(headers, "Cc"));
  const internetMessageId = normalizeRfcMessageId(header(headers, "Message-ID"));
  const inReplyTo = normalizeRfcMessageId(header(headers, "In-Reply-To"));
  const references = parseReferences(header(headers, "References"));
  const labels = [...new Set((message.labelIds ?? []).filter((label) =>
    typeof label === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(label),
  ))].sort();
  const snippet = (message.snippet ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, MAX_SNIPPET_LENGTH);
  const contentHash = await sha256Hex(JSON.stringify({
    providerMessageId: message.id,
    senderEmail: from.email,
    replyTo,
    recipients,
    copiedRecipients,
    subject,
    textBody,
    snippet,
    labels,
    internetMessageId,
    inReplyTo,
    references,
    receivedAt: received.getTime(),
    attachments,
  }));

  return {
    providerMessageId: message.id,
    senderName: from.name,
    senderEmail: from.email,
    replyToEmail: replyTo,
    recipients,
    copiedRecipients,
    subject,
    textBody,
    snippet,
    labels,
    internetMessageId,
    inReplyTo,
    references,
    receivedAt: received,
    contentRetainUntil: new Date(received.getTime() + options.retentionDays * 86_400_000),
    contentHash,
    attachments,
  };
}

export function clampInitialSyncLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.trunc(value))) : 25;
}

export function clampRetentionDays(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(365, Math.trunc(value))) : 30;
}

/**
 * Normalizes only a complete Gmail thread response. HTML and attachment bytes are
 * deliberately ignored; only decoded text/plain parts and attachment metadata survive.
 */
export async function normalizeFullGmailThread(
  thread: GmailThread,
  options: { now: Date; retentionDays: number },
): Promise<NormalizedThread> {
  assertProviderId(thread.id);
  if (!Array.isArray(thread.messages) || thread.messages.length === 0) {
    throw new GmailPayloadError();
  }

  for (const message of thread.messages) {
    if (message.threadId !== thread.id) throw new GmailPayloadError();
  }

  const retentionDays = clampRetentionDays(options.retentionDays);
  const normalizedMessages = await Promise.all(
    thread.messages.map((message) => normalizeMessage(message, {
      now: options.now,
      retentionDays,
    })),
  );
  normalizedMessages.sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime());
  const latest = normalizedMessages.at(-1);
  if (!latest) throw new GmailPayloadError();

  return {
    providerThreadId: thread.id,
    subject: latest.subject,
    lastMessageAt: latest.receivedAt,
    providerHistoryId: thread.historyId,
    messages: normalizedMessages,
  };
}
