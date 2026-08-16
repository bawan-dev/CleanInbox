import { normalizeRfcMessageId } from "./mime";
import {
  GmailApiError,
  type GmailApiOperation,
  type GmailCreateDraftInput,
  type GmailDraft,
  type GmailDraftList,
  type GmailListOptions,
  type GmailMessage,
  type GmailMessageList,
  type GmailProfile,
  type GmailRequestOptions,
  type GmailThread,
  type GmailThreadList,
} from "./types";

const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";
const READ_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const GMAIL_ENDPOINT_ALLOWLIST = Object.freeze({
  "profile.get": Object.freeze({ method: "GET", path: "/gmail/v1/users/me/profile", safeRead: true }),
  "threads.listInbox": Object.freeze({ method: "GET", path: "/gmail/v1/users/me/threads", safeRead: true }),
  "threads.getFull": Object.freeze({ method: "GET", path: "/gmail/v1/users/me/threads/{threadId}", safeRead: true }),
  "messages.listInbox": Object.freeze({ method: "GET", path: "/gmail/v1/users/me/messages", safeRead: true }),
  "messages.getFull": Object.freeze({ method: "GET", path: "/gmail/v1/users/me/messages/{messageId}", safeRead: true }),
  "drafts.listByMessageId": Object.freeze({ method: "GET", path: "/gmail/v1/users/me/drafts", safeRead: true }),
  "drafts.create": Object.freeze({ method: "POST", path: "/gmail/v1/users/me/drafts", safeRead: false }),
} satisfies Record<GmailApiOperation, { method: "GET" | "POST"; path: string; safeRead: boolean }>);

type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export type GmailClientOptions = {
  accessToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Retries after the initial attempt. Clamped to 0-3 and used only for GET. */
  maxReadRetries?: number;
  retryBaseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type RequestInput = {
  operation: GmailApiOperation;
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  signal?: AbortSignal;
};

function validationError(operation: GmailApiOperation, message: string): GmailApiError {
  return new GmailApiError({
    code: "GMAIL_VALIDATION_ERROR",
    operation,
    message,
  });
}

function normalizeResourceId(value: string, operation: GmailApiOperation): string {
  if (!RESOURCE_ID_PATTERN.test(value)) {
    throw validationError(operation, "Gmail resource identifier is invalid");
  }
  return value;
}

function normalizeMaxResults(value: number | undefined, operation: GmailApiOperation): string {
  const selected = value ?? 25;
  if (!Number.isInteger(selected) || selected < 1 || selected > 100) {
    throw validationError(operation, "maxResults must be an integer between 1 and 100");
  }
  return String(selected);
}

function normalizePageToken(value: string | undefined, operation: GmailApiOperation): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw validationError(operation, "pageToken is invalid");
  }
  return value;
}

function buildListQuery(options: GmailListOptions, operation: GmailApiOperation): URLSearchParams {
  const query = new URLSearchParams({
    labelIds: "INBOX",
    maxResults: normalizeMaxResults(options.maxResults, operation),
  });
  const pageToken = normalizePageToken(options.pageToken, operation);
  if (pageToken) query.set("pageToken", pageToken);

  if (options.afterEpochSeconds !== undefined) {
    if (!Number.isSafeInteger(options.afterEpochSeconds) || options.afterEpochSeconds < 1) {
      throw validationError(operation, "afterEpochSeconds must be a positive Unix timestamp");
    }
    query.set("q", `after:${options.afterEpochSeconds}`);
  }

  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject<T>(value: unknown, operation: GmailApiOperation): T {
  if (!isRecord(value)) {
    throw new GmailApiError({
      code: "GMAIL_PROTOCOL_ERROR",
      operation,
      message: "Gmail returned an unexpected response shape",
    });
  }
  return value as T;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeIntegerOption(input: {
  value: number | undefined;
  fallback: number;
  minimum: number;
  maximum: number;
  field: string;
}): number {
  const selected = input.value ?? input.fallback;
  if (!Number.isInteger(selected) || selected < input.minimum || selected > input.maximum) {
    throw new TypeError(`${input.field} must be an integer between ${input.minimum} and ${input.maximum}`);
  }
  return selected;
}

function pathMatchesTemplate(path: string, template: string): boolean {
  const expression = template
    .split("/")
    .map((segment) => (segment.startsWith("{") && segment.endsWith("}") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
    .join("/");
  return new RegExp(`^${expression}$`, "u").test(path);
}

export class GmailClient {
  readonly #accessToken: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxReadRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: GmailClientOptions) {
    if (!options.accessToken || /[\u0000-\u0020\u007f]/u.test(options.accessToken)) {
      throw new TypeError("A valid Gmail access token is required");
    }

    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = normalizeIntegerOption({
      value: options.timeoutMs,
      fallback: 10_000,
      minimum: 100,
      maximum: 60_000,
      field: "timeoutMs",
    });
    this.#maxReadRetries = normalizeIntegerOption({
      value: options.maxReadRetries,
      fallback: 2,
      minimum: 0,
      maximum: 3,
      field: "maxReadRetries",
    });
    this.#retryBaseDelayMs = normalizeIntegerOption({
      value: options.retryBaseDelayMs,
      fallback: 250,
      minimum: 0,
      maximum: 5_000,
      field: "retryBaseDelayMs",
    });
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async getProfile(options: GmailRequestOptions = {}): Promise<GmailProfile> {
    return this.#request<GmailProfile>({
      operation: "profile.get",
      path: "/gmail/v1/users/me/profile",
      signal: options.signal,
    });
  }

  async listRecentInboxThreads(options: GmailListOptions = {}): Promise<GmailThreadList> {
    return this.#request<GmailThreadList>({
      operation: "threads.listInbox",
      path: "/gmail/v1/users/me/threads",
      query: buildListQuery(options, "threads.listInbox"),
      signal: options.signal,
    });
  }

  async getFullThread(threadId: string, options: GmailRequestOptions = {}): Promise<GmailThread> {
    const id = normalizeResourceId(threadId, "threads.getFull");
    return this.#request<GmailThread>({
      operation: "threads.getFull",
      path: `/gmail/v1/users/me/threads/${encodeURIComponent(id)}`,
      query: new URLSearchParams({ format: "full" }),
      signal: options.signal,
    });
  }

  async listRecentInboxMessages(options: GmailListOptions = {}): Promise<GmailMessageList> {
    return this.#request<GmailMessageList>({
      operation: "messages.listInbox",
      path: "/gmail/v1/users/me/messages",
      query: buildListQuery(options, "messages.listInbox"),
      signal: options.signal,
    });
  }

  async getFullMessage(messageId: string, options: GmailRequestOptions = {}): Promise<GmailMessage> {
    const id = normalizeResourceId(messageId, "messages.getFull");
    return this.#request<GmailMessage>({
      operation: "messages.getFull",
      path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
      query: new URLSearchParams({ format: "full" }),
      signal: options.signal,
    });
  }

  async listDraftsByRfcMessageId(
    rfcMessageId: string,
    options: GmailRequestOptions & { maxResults?: number } = {},
  ): Promise<GmailDraftList> {
    let normalized: string;
    try {
      normalized = normalizeRfcMessageId(rfcMessageId);
    } catch {
      throw validationError("drafts.listByMessageId", "RFC Message-ID is invalid");
    }

    return this.#request<GmailDraftList>({
      operation: "drafts.listByMessageId",
      path: "/gmail/v1/users/me/drafts",
      query: new URLSearchParams({
        maxResults: normalizeMaxResults(options.maxResults, "drafts.listByMessageId"),
        q: `rfc822msgid:${normalized}`,
      }),
      signal: options.signal,
    });
  }

  async createDraft(input: GmailCreateDraftInput): Promise<GmailDraft> {
    const threadId = normalizeResourceId(input.threadId, "drafts.create");
    if (!input.raw || input.raw.length > 25_000_000 || !BASE64URL_PATTERN.test(input.raw)) {
      throw validationError("drafts.create", "Draft MIME must be non-empty URL-safe base64 without padding");
    }

    return this.#request<GmailDraft>({
      operation: "drafts.create",
      path: "/gmail/v1/users/me/drafts",
      body: { message: { threadId, raw: input.raw } },
      signal: input.signal,
    });
  }

  async #request<T>(input: RequestInput): Promise<T> {
    const endpoint = GMAIL_ENDPOINT_ALLOWLIST[input.operation];
    if (!pathMatchesTemplate(input.path, endpoint.path)) {
      throw validationError(input.operation, "Gmail endpoint is outside the operation allowlist");
    }
    const attempts = endpoint.safeRead ? this.#maxReadRetries + 1 : 1;
    let lastError: GmailApiError | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.#requestOnce<T>(input, endpoint.method);
      } catch (error) {
        const normalized = error instanceof GmailApiError
          ? error
          : new GmailApiError({
              code: "GMAIL_NETWORK_ERROR",
              operation: input.operation,
              message: "Gmail request failed before a response was received",
              retryable: endpoint.safeRead,
            });
        lastError = normalized;

        if (!endpoint.safeRead || !normalized.retryable || attempt === attempts - 1) {
          throw normalized;
        }

        await this.#sleep(this.#retryBaseDelayMs * 2 ** attempt);
      }
    }

    throw lastError ?? new GmailApiError({
      code: "GMAIL_NETWORK_ERROR",
      operation: input.operation,
      message: "Gmail request failed",
    });
  }

  async #requestOnce<T>(input: RequestInput, method: "GET" | "POST"): Promise<T> {
    if (input.signal?.aborted) {
      throw new GmailApiError({
        code: "GMAIL_ABORTED",
        operation: input.operation,
        message: "Gmail request was cancelled",
      });
    }

    const url = new URL(input.path, GMAIL_API_ORIGIN);
    if (input.query) url.search = input.query.toString();

    const controller = new AbortController();
    let timedOut = false;
    const handleExternalAbort = () => controller.abort();
    input.signal?.addEventListener("abort", handleExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        method,
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#accessToken}`,
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryable = method === "GET" && READ_RETRY_STATUSES.has(response.status);
        throw new GmailApiError({
          code: "GMAIL_HTTP_ERROR",
          operation: input.operation,
          status: response.status,
          message: `Gmail returned HTTP ${response.status}`,
          retryable,
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new GmailApiError({
          code: "GMAIL_PROTOCOL_ERROR",
          operation: input.operation,
          message: "Gmail returned a non-JSON response",
        });
      }
      return assertObject<T>(payload, input.operation);
    } catch (error) {
      if (error instanceof GmailApiError) throw error;
      if (timedOut) {
        throw new GmailApiError({
          code: "GMAIL_TIMEOUT",
          operation: input.operation,
          message: "Gmail request timed out",
          retryable: method === "GET",
        });
      }
      if (input.signal?.aborted) {
        throw new GmailApiError({
          code: "GMAIL_ABORTED",
          operation: input.operation,
          message: "Gmail request was cancelled",
        });
      }
      throw new GmailApiError({
        code: "GMAIL_NETWORK_ERROR",
        operation: input.operation,
        message: "Gmail request failed before a response was received",
        retryable: method === "GET",
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", handleExternalAbort);
    }
  }
}
