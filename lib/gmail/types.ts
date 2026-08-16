export type GmailApiOperation =
  | "profile.get"
  | "threads.listInbox"
  | "threads.getFull"
  | "messages.listInbox"
  | "messages.getFull"
  | "drafts.listByMessageId"
  | "drafts.create";

export type GmailHeader = {
  name: string;
  value: string;
};

export type GmailMessagePartBody = {
  attachmentId?: string;
  data?: string;
  size?: number;
};

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
};

export type GmailThread = {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
};

export type GmailDraft = {
  id: string;
  message?: GmailMessage;
};

export type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};

export type GmailThreadList = {
  threads?: Array<Pick<GmailThread, "id" | "historyId">>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailMessageList = {
  messages?: Array<Pick<GmailMessage, "id" | "threadId">>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailDraftList = {
  drafts?: GmailDraft[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailRequestOptions = {
  signal?: AbortSignal;
};

export type GmailListOptions = GmailRequestOptions & {
  maxResults?: number;
  pageToken?: string;
  /** Unix time in seconds. Gmail only returns resources after this instant. */
  afterEpochSeconds?: number;
};

export type GmailCreateDraftInput = GmailRequestOptions & {
  threadId: string;
  /** RFC 2822 content encoded with URL-safe base64 and without padding. */
  raw: string;
};

export type GmailApiErrorCode =
  | "GMAIL_ABORTED"
  | "GMAIL_HTTP_ERROR"
  | "GMAIL_NETWORK_ERROR"
  | "GMAIL_PROTOCOL_ERROR"
  | "GMAIL_TIMEOUT"
  | "GMAIL_VALIDATION_ERROR";

/**
 * A deliberately redacted provider error. It never contains access tokens,
 * response bodies, message bodies, raw MIME, or complete request URLs.
 */
export class GmailApiError extends Error {
  readonly code: GmailApiErrorCode;
  readonly operation: GmailApiOperation;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(input: {
    code: GmailApiErrorCode;
    operation: GmailApiOperation;
    message: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "GmailApiError";
    this.code = input.code;
    this.operation = input.operation;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      status: this.status,
      retryable: this.retryable,
      message: this.message,
    };
  }
}
