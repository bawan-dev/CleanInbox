import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSecretAad,
  decryptSecret,
  encodeBase64Url,
  encryptSecret,
  SecretDecryptionError,
  sha256Base64Url,
  sha256Hex,
} from "../lib/security/crypto";
import {
  EnvironmentValidationError,
  parseEnvironment,
} from "../lib/security/env";
import {
  REDACTED,
  REDACTED_EMAIL,
  redactForLogging,
  safeErrorMetadata,
  toSafeLogMetadata,
} from "../lib/security/redaction";

const encryptionKey = encodeBase64Url(
  Uint8Array.from({ length: 32 }, (_unused, index) => index),
);

test("environment features are strictly disabled by default", () => {
  const environment = parseEnvironment({});
  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.GMAIL_INTEGRATION_ENABLED, false);
  assert.equal(environment.AI_ANALYSIS_ENABLED, false);

  assert.throws(
    () => parseEnvironment({ GMAIL_INTEGRATION_ENABLED: "1" }),
    EnvironmentValidationError,
  );
});

test("enabled integrations fail closed when required secrets are absent", () => {
  assert.throws(
    () => parseEnvironment({ GMAIL_INTEGRATION_ENABLED: "true" }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.path).sort(),
        [
          "APP_ENCRYPTION_KEY",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "GOOGLE_REDIRECT_URI",
        ],
      );
      return true;
    },
  );

  assert.throws(
    () => parseEnvironment({ AI_ANALYSIS_ENABLED: true }),
    EnvironmentValidationError,
  );
});

test("production OAuth configuration requires HTTPS and valid AES-256 material", () => {
  assert.throws(
    () =>
      parseEnvironment({
        NODE_ENV: "production",
        GMAIL_INTEGRATION_ENABLED: "true",
        APP_ENCRYPTION_KEY: encryptionKey,
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/callback",
      }),
    EnvironmentValidationError,
  );

  const environment = parseEnvironment({
    NODE_ENV: "production",
    GMAIL_INTEGRATION_ENABLED: "true",
    APP_ENCRYPTION_KEY: encryptionKey,
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REDIRECT_URI: "https://clearinbox.example/api/google/callback",
  });
  assert.equal(environment.GMAIL_INTEGRATION_ENABLED, true);
});

test("mailbox label modification cannot be enabled in the draft-only MVP", () => {
  assert.throws(
    () => parseEnvironment({ GMAIL_LABEL_MODIFICATION_ENABLED: "true" }),
    EnvironmentValidationError,
  );
});

test("AES-256-GCM encryption round trips only with the same tenant-bound AAD", async () => {
  const aad = buildSecretAad({
    tenantId: "tenant-a",
    resourceType: "mailbox",
    resourceId: "mailbox-1",
    field: "refresh-token",
  });
  const otherTenantAad = buildSecretAad({
    tenantId: "tenant-b",
    resourceType: "mailbox",
    resourceId: "mailbox-1",
    field: "refresh-token",
  });

  const encrypted = await encryptSecret("refresh-token-value", encryptionKey, aad);
  assert.match(encrypted, /^ci1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(await decryptSecret(encrypted, encryptionKey, aad), "refresh-token-value");

  await assert.rejects(
    decryptSecret(encrypted, encryptionKey, otherTenantAad),
    SecretDecryptionError,
  );
});

test("AES-GCM uses a fresh IV and rejects tampering", async () => {
  const aad = "tenant-a:mailbox-1:access-token";
  const first = await encryptSecret("same-secret", encryptionKey, aad);
  const second = await encryptSecret("same-secret", encryptionKey, aad);
  assert.notEqual(first, second);

  const lastCharacter = first.endsWith("A") ? "B" : "A";
  await assert.rejects(
    decryptSecret(`${first.slice(0, -1)}${lastCharacter}`, encryptionKey, aad),
    SecretDecryptionError,
  );
});

test("SHA-256 helpers produce stable hex and base64url digests", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(await sha256Base64Url("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});

test("logging redaction removes secrets, email addresses, and message content", () => {
  const redacted = redactForLogging({
    accessToken: "ya29.sensitive-token",
    message: "private email body",
    nested: {
      contact: "person@example.com",
      authorization: "Bearer secret-value",
    },
    statusCode: 401,
  });

  assert.deepEqual(redacted, {
    accessToken: REDACTED,
    message: REDACTED,
    nested: {
      contact: REDACTED_EMAIL,
      authorization: REDACTED,
    },
    statusCode: 401,
  });
});

test("safe log metadata drops arbitrary payload fields and Error details", () => {
  const metadata = toSafeLogMetadata({
    tenantId: "tenant-a",
    requestId: "request-1",
    emailBody: "must not be logged",
    customPayload: { private: "must not be logged" },
    error: new Error("request for person@example.com failed with Bearer token-value"),
  });

  assert.deepEqual(metadata, {
    tenantId: "tenant-a",
    requestId: "request-1",
    error: { name: "Error" },
  });
  assert.deepEqual(safeErrorMetadata(new Error("secret")), { errorName: "Error" });
});
