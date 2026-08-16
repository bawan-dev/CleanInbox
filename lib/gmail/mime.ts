export type GmailMailbox = {
  address: string;
  name?: string;
};

export type BuildReplyMimeInput = {
  from?: GmailMailbox;
  to: GmailMailbox[];
  cc?: GmailMailbox[];
  /** The exact current thread subject, preserved to satisfy Gmail threading. */
  threadSubject: string;
  bodyText: string;
  inReplyTo: string;
  references?: string[];
  /** A deterministic RFC Message-ID chosen by the idempotency layer. */
  messageId: string;
  date?: Date;
};

export type BuiltReplyMime = {
  mime: string;
  raw: string;
  messageId: string;
  subject: string;
};

const ADDRESS_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const MESSAGE_ID_PATTERN = /^<[^<>\s@]+@[^<>\s@]+>$/;
const HEADER_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_RECIPIENTS = 100;
const MAX_REFERENCES = 30;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

export function base64UrlEncodeUtf8(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function encodeUtf8Base64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function assertSafeHeaderValue(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();

  if (!normalized || normalized.length > maxLength || HEADER_CONTROL_PATTERN.test(normalized)) {
    throw new TypeError(`${field} is not a safe RFC 2822 header value`);
  }

  return normalized;
}

function normalizeAddress(value: string): string {
  const address = assertSafeHeaderValue(value, "Email address", 254);
  if (!ADDRESS_PATTERN.test(address)) {
    throw new TypeError("Email address is not a supported mailbox address");
  }

  const atIndex = address.lastIndexOf("@");
  return `${address.slice(0, atIndex)}@${address.slice(atIndex + 1).toLowerCase()}`;
}

function encodeHeaderPhrase(value: string): string {
  const phrase = assertSafeHeaderValue(value, "Display name", 200);
  if (/^[\x20-\x7e]+$/u.test(phrase)) {
    return `"${phrase.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }

  return `=?UTF-8?B?${encodeUtf8Base64(phrase)}?=`;
}

function formatMailbox(mailbox: GmailMailbox): string {
  const address = normalizeAddress(mailbox.address);
  return mailbox.name ? `${encodeHeaderPhrase(mailbox.name)} <${address}>` : address;
}

function formatMailboxList(mailboxes: GmailMailbox[], field: string): string {
  if (mailboxes.length === 0 || mailboxes.length > MAX_RECIPIENTS) {
    throw new TypeError(`${field} must contain between 1 and ${MAX_RECIPIENTS} recipients`);
  }

  return mailboxes.map(formatMailbox).join(", ");
}

export function normalizeRfcMessageId(value: string, field = "Message-ID"): string {
  const messageId = assertSafeHeaderValue(value, field, 254);
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw new TypeError(`${field} must be an RFC Message-ID enclosed in angle brackets`);
  }

  return messageId;
}

function encodeUnstructuredHeader(value: string): string {
  return /^[\x20-\x7e]+$/u.test(value)
    ? value
    : `=?UTF-8?B?${encodeUtf8Base64(value)}?=`;
}

function normalizeBody(value: string): string {
  if (value.includes("\u0000")) {
    throw new TypeError("Reply body contains an unsupported null character");
  }

  return value.replace(/\r\n|\r|\n/gu, "\n").replaceAll("\n", "\r\n");
}

function foldBase64(value: string): string {
  return value.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

/**
 * Builds a plain-text reply MIME document. Header values are constructed from
 * validated structured fields; body text is separately base64 encoded.
 */
export function buildReplyMime(input: BuildReplyMimeInput): BuiltReplyMime {
  const to = formatMailboxList(input.to, "To");
  const cc = input.cc?.length ? formatMailboxList(input.cc, "Cc") : undefined;
  const from = input.from ? formatMailbox(input.from) : undefined;
  const subject = assertSafeHeaderValue(input.threadSubject, "Thread subject", 500);
  const messageId = normalizeRfcMessageId(input.messageId);
  const inReplyTo = normalizeRfcMessageId(input.inReplyTo, "In-Reply-To");
  const references = Array.from(
    new Set([...(input.references ?? []).map((item) => normalizeRfcMessageId(item, "References")), inReplyTo]),
  ).slice(-MAX_REFERENCES);
  const date = input.date ?? new Date();

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Date must be valid");
  }

  const headers = [
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references.join(" ")}`,
    from ? `From: ${from}` : undefined,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : undefined,
    `Subject: ${encodeUnstructuredHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter((header): header is string => Boolean(header));

  const encodedBody = foldBase64(encodeUtf8Base64(normalizeBody(input.bodyText)));
  const mime = `${headers.join("\r\n")}\r\n\r\n${encodedBody}\r\n`;

  return {
    mime,
    raw: base64UrlEncodeUtf8(mime),
    messageId,
    subject,
  };
}
