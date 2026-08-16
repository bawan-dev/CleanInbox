import assert from "node:assert/strict";
import test from "node:test";
import type { AuditInput } from "../lib/audit";
import {
  assertTrustedJsonMutation,
  createGoogleConnectionService,
  GoogleConnectionError,
  GoogleProviderAccountConflictError,
  type GoogleConnectionStore,
  type OAuthAttemptRecord,
  type SaveGoogleConnectionInput,
  type StoredGoogleConnection,
} from "../lib/google/connection-service";
import { GOOGLE_GMAIL_DRAFT_SCOPES } from "../lib/google/oauth";
import {
  buildSecretAad,
  decryptSecret,
  encodeBase64Url,
  encryptSecret,
  sha256Hex,
} from "../lib/security/crypto";
import type { TenantContext } from "../lib/tenant-context";

const encryptionKey = encodeBase64Url(
  Uint8Array.from({ length: 32 }, (_unused, index) => index + 11),
);
const fixedNow = new Date("2026-08-06T10:00:00.000Z");
const oauthClient = {
  clientId: "clearinbox.apps.googleusercontent.com",
  clientSecret: "server-side-client-secret",
  redirectUri: "https://clearinbox.example/api/gmail/callback",
};
const owner: TenantContext = {
  tenantId: "tenant-1",
  tenantName: "Example Ltd",
  userId: "user-1",
  userEmail: "owner@example.com",
  role: "owner",
};

class MemoryConnectionStore implements GoogleConnectionStore {
  attempts: OAuthAttemptRecord[] = [];
  connections = new Map<string, StoredGoogleConnection>();
  lastSave?: SaveGoogleConnectionInput;
  forceSaveConflict = false;

  async createOAuthAttempt(attempt: OAuthAttemptRecord) {
    this.attempts.push({ ...attempt });
  }

  async consumeOAuthAttempt(input: {
    tenantId: string;
    actorEmail: string;
    stateHash: string;
    now: Date;
  }) {
    const attempt = this.attempts.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.actorEmail === input.actorEmail &&
        candidate.stateHash === input.stateHash &&
        candidate.consumedAt === null &&
        candidate.expiresAt.getTime() > input.now.getTime(),
    );
    if (!attempt) return null;
    attempt.consumedAt = input.now;
    return { ...attempt };
  }

  async findByProviderAccount(providerAccountId: string) {
    return this.connections.get(providerAccountId) ?? null;
  }

  async saveConnection(input: SaveGoogleConnectionInput) {
    if (this.forceSaveConflict) throw new GoogleProviderAccountConflictError();
    this.lastSave = input;
    this.connections.set(input.mailbox.providerAccountId, {
      mailbox: {
        id: input.mailbox.id,
        tenantId: input.mailbox.tenantId,
        providerAccountId: input.mailbox.providerAccountId,
        address: input.mailbox.address,
        status: "active",
      },
      credential: {
        id: input.credential.id,
        accessTokenEncrypted: input.credential.accessTokenEncrypted,
        refreshTokenEncrypted: input.credential.refreshTokenEncrypted,
      },
    });
  }

  async findDisconnectTarget(input: { tenantId: string; mailboxId: string }) {
    return (
      [...this.connections.values()].find(
        (connection) =>
          connection.mailbox.tenantId === input.tenantId &&
          connection.mailbox.id === input.mailboxId,
      ) ?? null
    );
  }

  async disconnectLocal(input: { tenantId: string; mailboxId: string; now: Date }) {
    const target = await this.findDisconnectTarget(input);
    if (!target) return;
    target.mailbox.status = "disconnected";
    target.credential = null;
  }
}

function createHarness(options?: {
  store?: MemoryConnectionStore;
  enabled?: boolean;
  exchangeCode?: Parameters<typeof createGoogleConnectionService>[0]["exchangeCode"];
  validateIdToken?: Parameters<typeof createGoogleConnectionService>[0]["validateIdToken"];
  revokeToken?: Parameters<typeof createGoogleConnectionService>[0]["revokeToken"];
}) {
  const store = options?.store ?? new MemoryConnectionStore();
  const audits: AuditInput[] = [];
  let uuidIndex = 0;
  const uuids = ["attempt-id", "mailbox-id", "credential-id"];
  const service = createGoogleConnectionService({
    config: options?.enabled === false
      ? { enabled: false }
      : {
          enabled: true,
          appBaseUrl: "https://clearinbox.example",
          encryptionKey,
          oauthClient,
        },
    store,
    audit: async (event) => {
      audits.push(event);
    },
    now: () => new Date(fixedNow),
    randomUuid: () => uuids[uuidIndex++] ?? `generated-${uuidIndex}`,
    generateState: () => "s".repeat(43),
    generateNonce: () => "n".repeat(43),
    generatePkce: async () => ({
      codeVerifier: "v".repeat(43),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
    }),
    exchangeCode:
      options?.exchangeCode ??
      (async () => ({
        accessToken: "access-token-secret",
        refreshToken: "refresh-token-secret",
        idToken: "signed-id-token",
        tokenType: "Bearer",
        expiresInSeconds: 3_600,
        expiresAt: fixedNow.getTime() + 3_600_000,
        scopes: [...GOOGLE_GMAIL_DRAFT_SCOPES],
      })),
    validateIdToken:
      options?.validateIdToken ??
      (async () => ({
        subject: "google-subject-1",
        email: "mailbox@example.com",
        emailVerified: true as const,
        issuedAt: Math.floor(fixedNow.getTime() / 1_000),
        expiresAt: Math.floor(fixedNow.getTime() / 1_000) + 300,
      })),
    revokeToken: options?.revokeToken ?? (async () => undefined),
  });
  return { service, store, audits };
}

test("connection start is owner-only, fail-closed, and persists only hashed/encrypted OAuth material", async () => {
  const disabled = createHarness({ enabled: false });
  await assert.rejects(
    disabled.service.start(owner, {}),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "integration_disabled",
  );

  const enabled = createHarness();
  await assert.rejects(
    enabled.service.start({ ...owner, role: "reviewer" }, {}),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "owner_required",
  );

  const result = await enabled.service.start(owner, {
    returnPath: "//attacker.example/steal",
  });
  const attempt = enabled.store.attempts[0];
  assert.equal(attempt.stateHash, await sha256Hex("s".repeat(43)));
  assert.equal(attempt.nonceHash, await sha256Hex("n".repeat(43)));
  assert.equal(attempt.returnPath, "/");
  assert.equal(attempt.expiresAt.getTime() - attempt.createdAt.getTime(), 600_000);
  assert.equal(attempt.codeVerifierEncrypted.includes("v".repeat(43)), false);
  assert.equal(JSON.stringify(attempt).includes("s".repeat(43)), false);

  const decrypted = JSON.parse(
    await decryptSecret(
      attempt.codeVerifierEncrypted,
      encryptionKey,
      buildSecretAad({
        tenantId: owner.tenantId,
        resourceType: "gmail_oauth_attempt",
        resourceId: "attempt-id",
        field: "pkce_verifier_and_nonce",
      }),
    ),
  );
  assert.deepEqual(decrypted, {
    codeVerifier: "v".repeat(43),
    nonce: "n".repeat(43),
  });

  const authorizationUrl = new URL(result.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("state"), "s".repeat(43));
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
  assert.deepEqual(
    authorizationUrl.searchParams.get("scope")?.split(" "),
    [...GOOGLE_GMAIL_DRAFT_SCOPES],
  );
});

test("callback consumes state once, validates identity/scopes, and stores only AAD-bound ciphertext", async () => {
  let exchangedVerifier = "";
  let validatedNonce = "";
  const harness = createHarness({
    exchangeCode: async (input) => {
      exchangedVerifier = input.codeVerifier;
      return {
        accessToken: "access-token-secret",
        refreshToken: "refresh-token-secret",
        idToken: "signed-id-token",
        tokenType: "Bearer",
        expiresInSeconds: 3_600,
        expiresAt: fixedNow.getTime() + 3_600_000,
        scopes: [...GOOGLE_GMAIL_DRAFT_SCOPES],
      };
    },
    validateIdToken: async (_token, input) => {
      validatedNonce = input.nonce;
      return {
        subject: "google-subject-1",
        email: "mailbox@example.com",
        emailVerified: true,
        issuedAt: 1,
        expiresAt: 2,
      };
    },
  });
  await harness.service.start(owner, { returnPath: "/settings?tab=gmail" });
  const result = await harness.service.complete(owner, {
    state: "s".repeat(43),
    code: "one-time-authorization-code",
  });

  assert.deepEqual(result, {
    outcome: "connected",
    returnPath: "/settings?tab=gmail",
    mailboxId: "mailbox-id",
    address: "mailbox@example.com",
  });
  assert.equal(exchangedVerifier, "v".repeat(43));
  assert.equal(validatedNonce, "n".repeat(43));
  assert.ok(harness.store.attempts[0].consumedAt);

  const saved = harness.store.lastSave!;
  assert.equal(saved.mailbox.providerAccountId, "google-subject-1");
  assert.deepEqual(JSON.parse(saved.mailbox.grantedScopesJson), [...GOOGLE_GMAIL_DRAFT_SCOPES]);
  assert.equal(saved.credential.accessTokenEncrypted.includes("access-token-secret"), false);
  assert.equal(saved.credential.refreshTokenEncrypted?.includes("refresh-token-secret"), false);
  assert.equal(
    await decryptSecret(
      saved.credential.accessTokenEncrypted,
      encryptionKey,
      buildSecretAad({
        tenantId: owner.tenantId,
        resourceType: "mailbox_credential",
        resourceId: "credential-id",
        field: "access_token",
      }),
    ),
    "access-token-secret",
  );
  assert.equal(
    await decryptSecret(
      saved.credential.refreshTokenEncrypted!,
      encryptionKey,
      buildSecretAad({
        tenantId: owner.tenantId,
        resourceType: "mailbox_credential",
        resourceId: "credential-id",
        field: "refresh_token",
      }),
    ),
    "refresh-token-secret",
  );
  assert.equal(JSON.stringify(result).includes("token-secret"), false);
  assert.equal(JSON.stringify(harness.audits).includes("token-secret"), false);

  await assert.rejects(
    harness.service.complete(owner, {
      state: "s".repeat(43),
      code: "replayed-code",
    }),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "state_invalid",
  );
});

test("callback state is bound to the exact tenant and authenticated owner", async () => {
  const harness = createHarness();
  await harness.service.start(owner, {});

  await assert.rejects(
    harness.service.complete(
      { ...owner, tenantId: "tenant-2" },
      { state: "s".repeat(43), code: "code" },
    ),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "state_invalid",
  );
  assert.equal(harness.store.attempts[0].consumedAt, null);

  await assert.rejects(
    harness.service.complete(
      { ...owner, userEmail: "different@example.com" },
      { state: "s".repeat(43), code: "code" },
    ),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "state_invalid",
  );
  assert.equal(harness.store.attempts[0].consumedAt, null);
});

test("provider errors are sanitized and still consume the one-time state", async () => {
  let exchangeCalls = 0;
  const harness = createHarness({
    exchangeCode: async () => {
      exchangeCalls += 1;
      throw new Error("must not run");
    },
  });
  await harness.service.start(owner, { returnPath: "/settings" });
  const result = await harness.service.complete(owner, {
    state: "s".repeat(43),
    providerError: "secret_provider_description_that_is_not_allowed",
  });

  assert.deepEqual(result, {
    outcome: "provider_error",
    returnPath: "/settings",
    reason: "oauth_error",
  });
  assert.equal(exchangeCalls, 0);
  assert.ok(harness.store.attempts[0].consumedAt);
  assert.equal(JSON.stringify(harness.audits).includes("secret_provider_description"), false);
});

test("callback rejects incomplete permissions and cross-tenant provider-account reuse", async () => {
  const missingScope = createHarness({
    exchangeCode: async () => ({
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      idToken: "signed-id-token",
      tokenType: "Bearer",
      expiresInSeconds: 3_600,
      expiresAt: fixedNow.getTime() + 3_600_000,
      scopes: GOOGLE_GMAIL_DRAFT_SCOPES.filter((scope) => !scope.endsWith("gmail.compose")),
    }),
  });
  await missingScope.service.start(owner, {});
  await assert.rejects(
    missingScope.service.complete(owner, { state: "s".repeat(43), code: "code" }),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "scope_mismatch",
  );
  assert.equal(missingScope.store.lastSave, undefined);

  const duplicateStore = new MemoryConnectionStore();
  duplicateStore.connections.set("google-subject-1", {
    mailbox: {
      id: "other-mailbox",
      tenantId: "tenant-2",
      providerAccountId: "google-subject-1",
      address: "mailbox@example.com",
      status: "active",
    },
    credential: null,
  });
  const duplicate = createHarness({ store: duplicateStore });
  await duplicate.service.start(owner, {});
  await assert.rejects(
    duplicate.service.complete(owner, { state: "s".repeat(43), code: "code" }),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "account_conflict",
  );
});

test("reconnection preserves an existing refresh token when Google omits a replacement", async () => {
  const store = new MemoryConnectionStore();
  const credentialId = "existing-credential";
  const existingRefresh = await encryptSecret(
    "existing-refresh-token",
    encryptionKey,
    buildSecretAad({
      tenantId: owner.tenantId,
      resourceType: "mailbox_credential",
      resourceId: credentialId,
      field: "refresh_token",
    }),
  );
  store.connections.set("google-subject-1", {
    mailbox: {
      id: "existing-mailbox",
      tenantId: owner.tenantId,
      providerAccountId: "google-subject-1",
      address: "old@example.com",
      status: "active",
    },
    credential: {
      id: credentialId,
      accessTokenEncrypted: "old-access-ciphertext",
      refreshTokenEncrypted: existingRefresh,
    },
  });
  const harness = createHarness({
    store,
    exchangeCode: async () => ({
      accessToken: "new-access-token",
      idToken: "signed-id-token",
      tokenType: "Bearer",
      expiresInSeconds: 3_600,
      expiresAt: fixedNow.getTime() + 3_600_000,
      scopes: [...GOOGLE_GMAIL_DRAFT_SCOPES],
    }),
  });
  await harness.service.start(owner, {});
  await harness.service.complete(owner, { state: "s".repeat(43), code: "code" });

  assert.equal(store.lastSave?.mailbox.id, "existing-mailbox");
  assert.equal(store.lastSave?.credential.id, credentialId);
  assert.equal(store.lastSave?.credential.refreshTokenEncrypted, existingRefresh);
});

test("disconnect revokes best-effort, always erases local credentials, and never returns a token", async () => {
  const store = new MemoryConnectionStore();
  const credentialId = "credential-to-delete";
  const refreshTokenEncrypted = await encryptSecret(
    "refresh-token-to-revoke",
    encryptionKey,
    buildSecretAad({
      tenantId: owner.tenantId,
      resourceType: "mailbox_credential",
      resourceId: credentialId,
      field: "refresh_token",
    }),
  );
  store.connections.set("google-subject-1", {
    mailbox: {
      id: "11111111-1111-4111-8111-111111111111",
      tenantId: owner.tenantId,
      providerAccountId: "google-subject-1",
      address: "mailbox@example.com",
      status: "active",
    },
    credential: {
      id: credentialId,
      accessTokenEncrypted: "unused-access-ciphertext",
      refreshTokenEncrypted,
    },
  });
  let revokedToken = "";
  const harness = createHarness({
    store,
    revokeToken: async ({ token }) => {
      revokedToken = token;
      throw new Error("simulated provider outage containing no secrets");
    },
  });

  const result = await harness.service.disconnect(owner, {
    mailboxId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(revokedToken, "refresh-token-to-revoke");
  assert.deepEqual(result, {
    mailboxId: "11111111-1111-4111-8111-111111111111",
    status: "disconnected",
    revocation: "failed",
  });
  assert.equal(store.connections.get("google-subject-1")?.credential, null);
  assert.equal(JSON.stringify(result).includes("refresh-token"), false);
  assert.equal(JSON.stringify(harness.audits).includes("refresh-token"), false);
});

test("mutation request guard requires JSON and an exact same-origin browser request", () => {
  assert.doesNotThrow(() =>
    assertTrustedJsonMutation(
      new Request("https://clearinbox.example/api/gmail/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          origin: "https://clearinbox.example",
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      }),
      "https://clearinbox.example",
    ),
  );

  assert.throws(
    () =>
      assertTrustedJsonMutation(
        new Request("https://clearinbox.example/api/gmail/connect", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
          },
          body: "{}",
        }),
        "https://clearinbox.example",
      ),
    (error: unknown) => error instanceof GoogleConnectionError && error.code === "origin_forbidden",
  );
});
