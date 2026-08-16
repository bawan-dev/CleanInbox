export const REDACTED = "[REDACTED]";
export const REDACTED_EMAIL = "[REDACTED_EMAIL]";
export const TRUNCATED = "[TRUNCATED]";

const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 50;
const MAX_STRING_LENGTH = 512;

const SAFE_METADATA_KEYS = new Set([
  "actorId",
  "attempt",
  "correlationId",
  "durationMs",
  "error",
  "errorCode",
  "errorName",
  "eventId",
  "eventType",
  "idempotencyKey",
  "mailboxId",
  "operation",
  "provider",
  "providerDraftId",
  "providerMessageId",
  "providerThreadId",
  "reasonCode",
  "requestId",
  "resourceId",
  "resourceType",
  "result",
  "retryable",
  "status",
  "statusCode",
  "targetId",
  "targetType",
  "tenantId",
  "userId",
]);

const SENSITIVE_KEY_PARTS = [
  "accesstoken",
  "apikey",
  "authorization",
  "bcc",
  "body",
  "ccrecipients",
  "clientsecret",
  "content",
  "cookie",
  "credential",
  "email",
  "fromaddress",
  "html",
  "idtoken",
  "messagebody",
  "mimetype",
  "password",
  "plaintext",
  "prompt",
  "raw",
  "recipient",
  "refreshtoken",
  "reply",
  "secret",
  "sender",
  "setcookie",
  "snippet",
  "subject",
  "textbody",
  "token",
];

export type SafeLogValue =
  | string
  | number
  | boolean
  | null
  | SafeLogValue[]
  | { [key: string]: SafeLogValue };

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (normalized === "message") return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactString(input: string): string {
  let output = input
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `${REDACTED}`)
    .replace(/\bya29\.[A-Za-z0-9._~-]+/gu, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*[^\s,;&]+/giu,
      (_match, label: string) => `${label}=${REDACTED}`,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, REDACTED_EMAIL);

  if (output.length > MAX_STRING_LENGTH) {
    output = `${output.slice(0, MAX_STRING_LENGTH)}…${TRUNCATED}`;
  }

  return output;
}

function errorCode(error: Error): string | number | undefined {
  const candidate = (error as Error & { code?: unknown }).code;
  return typeof candidate === "string" || typeof candidate === "number"
    ? candidate
    : undefined;
}

function redactInternal(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): SafeLogValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  if (typeof value === "function") return "[FUNCTION]";

  if (value instanceof Error) {
    const safeError: { [key: string]: SafeLogValue } = {
      name: redactString(value.name || "Error"),
    };
    const code = errorCode(value);
    if (code !== undefined) safeError.code = redactString(String(code));
    return safeError;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? "Invalid Date" : value.toISOString();
  }

  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactInternal(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) result.push(TRUNCATED);
    return result;
  }

  const result: { [key: string]: SafeLogValue } = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = isSensitiveKey(key)
      ? REDACTED
      : redactInternal(entryValue, depth + 1, seen);
  }
  if (entries.length > MAX_OBJECT_KEYS) result._truncated = true;
  return result;
}

/** Redacts likely secrets and email content while preserving diagnostic structure. */
export function redactForLogging(value: unknown): SafeLogValue {
  return redactInternal(value, 0, new WeakSet());
}

/**
 * Produces a deliberately small metadata object. Unknown top-level fields are
 * omitted so callers cannot accidentally log an email payload by inventing a key.
 */
export function toSafeLogMetadata(
  metadata: Record<string, unknown>,
): Record<string, SafeLogValue> {
  const result: Record<string, SafeLogValue> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    result[key] = redactForLogging(value);
  }

  return result;
}

export function safeErrorMetadata(error: unknown): Record<string, SafeLogValue> {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError" };
  }

  const metadata: Record<string, SafeLogValue> = {
    errorName: redactString(error.name || "Error"),
  };
  const code = errorCode(error);
  if (code !== undefined) metadata.errorCode = redactString(String(code));
  return metadata;
}
