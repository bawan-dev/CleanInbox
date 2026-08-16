import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  buildReplyMime,
  GMAIL_ENDPOINT_ALLOWLIST,
  GmailApiError,
  GmailClient,
} from "../lib/gmail";

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

test("reply MIME is threaded, URL-safe, and keeps body text out of headers", () => {
  const result = buildReplyMime({
    from: { address: "agent@example.com", name: "ClearInbox Agent" },
    to: [{ address: "customer@example.net", name: "A Customer" }],
    threadSubject: "Quarterly renewal",
    bodyText: "Thanks.\r\nBcc: injected@example.org\n\nRegards,\nAlex",
    inReplyTo: "<source-123@example.net>",
    references: ["<older-122@example.net>"],
    messageId: "<clearinbox-deterministic-456@example.com>",
    date: new Date("2026-08-06T12:00:00.000Z"),
  });

  assert.match(result.raw, /^[A-Za-z0-9_-]+$/);
  assert.equal(result.raw.includes("="), false);
  assert.equal(result.subject, "Quarterly renewal");

  const decoded = decodeBase64Url(result.raw);
  const [headers, encodedBody] = decoded.split("\r\n\r\n");
  assert.match(headers, /Message-ID: <clearinbox-deterministic-456@example\.com>/);
  assert.match(headers, /In-Reply-To: <source-123@example\.net>/);
  assert.match(headers, /References: <older-122@example\.net> <source-123@example\.net>/);
  assert.match(headers, /Subject: Quarterly renewal/);
  assert.equal(headers.includes("injected@example.org"), false);
  assert.match(Buffer.from(encodedBody.replaceAll("\r\n", ""), "base64").toString("utf8"), /Bcc: injected@example\.org/);
});

test("reply MIME rejects header and identifier injection", () => {
  const valid = {
    to: [{ address: "customer@example.net" }],
    threadSubject: "Existing subject",
    bodyText: "Hello",
    inReplyTo: "<source@example.net>",
    messageId: "<reply@example.com>",
  };

  assert.throws(
    () => buildReplyMime({ ...valid, threadSubject: "Hello\r\nBcc: attacker@example.org" }),
    /safe RFC 2822 header/,
  );
  assert.throws(
    () => buildReplyMime({ ...valid, to: [{ address: "victim@example.net\nBcc: attacker@example.org" }] }),
    /safe RFC 2822 header/,
  );
  assert.throws(
    () => buildReplyMime({ ...valid, messageId: "reply@example.com\r\nX-Evil: yes" }),
    /safe RFC 2822 header/,
  );
});

test("endpoint allowlist contains reads and draft creation only", () => {
  const entries = Object.entries(GMAIL_ENDPOINT_ALLOWLIST);
  assert.deepEqual(
    entries.filter(([, endpoint]) => endpoint.method === "POST").map(([operation]) => operation),
    ["drafts.create"],
  );
  assert.equal(
    entries.some(([operation, endpoint]) => /send|modify|trash|delete|archive|label/i.test(`${operation} ${endpoint.path}`)),
    false,
  );
});

test("read methods stay on allowlisted users/me endpoints and filter to INBOX", async () => {
  const calls: URL[] = [];
  const client = new GmailClient({
    accessToken: "test-access-token",
    maxReadRetries: 0,
    fetch: async (input) => {
      calls.push(new URL(input.toString()));
      return Response.json({});
    },
  });

  await client.getProfile();
  await client.listRecentInboxThreads({ maxResults: 25, afterEpochSeconds: 1_786_003_200 });
  await client.getFullThread("thread_1");
  await client.listRecentInboxMessages({ maxResults: 10 });
  await client.getFullMessage("message-1");

  assert.deepEqual(calls.map((url) => url.pathname), [
    "/gmail/v1/users/me/profile",
    "/gmail/v1/users/me/threads",
    "/gmail/v1/users/me/threads/thread_1",
    "/gmail/v1/users/me/messages",
    "/gmail/v1/users/me/messages/message-1",
  ]);
  assert.equal(calls[1].searchParams.get("labelIds"), "INBOX");
  assert.equal(calls[1].searchParams.get("q"), "after:1786003200");
  assert.equal(calls[2].searchParams.get("format"), "full");
  assert.equal(calls[3].searchParams.get("labelIds"), "INBOX");
  assert.equal(calls[4].searchParams.get("format"), "full");
});

test("client uses users/me, creates a thread-bound draft, and reconciles by RFC Message-ID", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new GmailClient({
    accessToken: "test-access-token",
    maxReadRetries: 0,
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Response.json({ id: "draft-1", message: { id: "message-1", threadId: "thread-1" } });
      }
      return Response.json({ drafts: [{ id: "draft-1" }] });
    },
  });

  const created = await client.createDraft({ threadId: "thread-1", raw: "YWJj" });
  const reconciled = await client.listDraftsByRfcMessageId("<reply-1@example.com>", { maxResults: 5 });

  assert.equal(created.id, "draft-1");
  assert.equal(reconciled.drafts?.[0]?.id, "draft-1");
  assert.equal(calls[0].url.href, "https://gmail.googleapis.com/gmail/v1/users/me/drafts");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    message: { threadId: "thread-1", raw: "YWJj" },
  });
  assert.equal(calls[1].init?.method, "GET");
  assert.equal(calls[1].url.pathname, "/gmail/v1/users/me/drafts");
  assert.equal(calls[1].url.searchParams.get("q"), "rfc822msgid:<reply-1@example.com>");
});

test("safe reads retry but draft creation never retries", async () => {
  let readCalls = 0;
  const readClient = new GmailClient({
    accessToken: "test-access-token",
    maxReadRetries: 2,
    retryBaseDelayMs: 0,
    sleep: async () => undefined,
    fetch: async () => {
      readCalls += 1;
      return readCalls === 1
        ? Response.json({ error: { message: "do not expose me" } }, { status: 503 })
        : Response.json({ emailAddress: "me@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" });
    },
  });
  const profile = await readClient.getProfile();
  assert.equal(profile.emailAddress, "me@example.com");
  assert.equal(readCalls, 2);

  let writeCalls = 0;
  const writeClient = new GmailClient({
    accessToken: "super-secret-token",
    maxReadRetries: 3,
    retryBaseDelayMs: 0,
    sleep: async () => undefined,
    fetch: async () => {
      writeCalls += 1;
      return Response.json(
        { error: { message: "raw-body-and-super-secret-token" } },
        { status: 503 },
      );
    },
  });

  await assert.rejects(
    () => writeClient.createDraft({ threadId: "thread-1", raw: "c2Vuc2l0aXZlLW1lc3NhZ2UtYm9keQ" }),
    (error: unknown) => {
      assert.ok(error instanceof GmailApiError);
      assert.equal(error.operation, "drafts.create");
      assert.equal(error.retryable, false);
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes("super-secret-token"), false);
      assert.equal(serialized.includes("raw-body"), false);
      return true;
    },
  );
  assert.equal(writeCalls, 1);
});
