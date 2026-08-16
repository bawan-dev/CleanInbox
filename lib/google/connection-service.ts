import type { AuditInput } from "../audit";
import {
  buildSecretAad,
  decryptSecret,
  encryptSecret,
  sha256Hex,
} from "../security/crypto";
import type { AppEnvironment } from "../security/env";
import type { TenantContext } from "../tenant-context";
import {
  GOOGLE_GMAIL_DRAFT_SCOPES,
  GoogleIdTokenValidationError,
  GoogleOAuthRequestError,
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  generateOAuthNonce,
  generateOAuthState,
  generatePkcePair,
  revokeGoogleToken,
  safeRelativeReturnPath,
  validateGoogleIdToken,
  type GoogleIdentity,
  type GoogleOAuthClient,
  type GoogleTokenSet,
} from "./oauth";

const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const SAFE_PROVIDER_ERRORS = new Set([
  "access_denied",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

export type GoogleConnectionConfig = {
  enabled: boolean;
  appBaseUrl?: string;
  encryptionKey?: string;
  oauthClient?: GoogleOAuthClient;
};

export type OAuthAttemptRecord = {
  id: string;
  tenantId: string;
  actorEmail: string;
  stateHash: string;
  nonceHash: string;
  codeVerifierEncrypted: string;
  redirectUri: string;
  returnPath: string;
  scopesJson: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type StoredGoogleConnection = {
  mailbox: {
    id: string;
    tenantId: string;
    providerAccountId: string;
    address: string;
    status: "active" | "disconnected" | "error";
  };
  credential: {
    id: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
  } | null;
};

export type SaveGoogleConnectionInput = {
  mailbox: {
    id: string;
    tenantId: string;
    providerAccountId: string;
    address: string;
    grantedScopesJson: string;
    tokenExpiresAt: Date;
  };
  credential: {
    id: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    tokenExpiresAt: Date;
    encryptionKeyVersion: number;
  };
  now: Date;
};

export interface GoogleConnectionStore {
  createOAuthAttempt(attempt: OAuthAttemptRecord): Promise<void>;
  consumeOAuthAttempt(input: {
    tenantId: string;
    actorEmail: string;
    stateHash: string;
    now: Date;
  }): Promise<OAuthAttemptRecord | null>;
  findByProviderAccount(providerAccountId: string): Promise<StoredGoogleConnection | null>;
  saveConnection(input: SaveGoogleConnectionInput): Promise<void>;
  findDisconnectTarget(input: {
    tenantId: string;
    mailboxId: string;
  }): Promise<StoredGoogleConnection | null>;
  disconnectLocal(input: {
    tenantId: string;
    mailboxId: string;
    now: Date;
  }): Promise<void>;
}

export type GoogleConnectionAuditWriter = (input: AuditInput) => Promise<unknown>;

type OAuthSecretBundle = {
  codeVerifier: string;
  nonce: string;
};

type GoogleConnectionDependencies = {
  config: GoogleConnectionConfig;
  store: GoogleConnectionStore;
  audit: GoogleConnectionAuditWriter;
  now?: () => Date;
  randomUuid?: () => string;
  generateState?: () => string;
  generateNonce?: () => string;
  generatePkce?: typeof generatePkcePair;
  exchangeCode?: typeof exchangeGoogleAuthorizationCode;
  validateIdToken?: typeof validateGoogleIdToken;
  revokeToken?: typeof revokeGoogleToken;
};

export class GoogleConnectionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly returnPath?: string;

  constructor(
    code: string,
    status: number,
    message: string,
    options?: { returnPath?: string },
  ) {
    super(message);
    this.name = "GoogleConnectionError";
    this.code = code;
    this.status = status;
    this.returnPath = options?.returnPath;
  }
}

/** Raised by a store when a global provider-account uniqueness check loses a race. */
export class GoogleProviderAccountConflictError extends Error {
  constructor() {
    super("The Google account is already connected.");
    this.name = "GoogleProviderAccountConflictError";
  }
}

/** Raised when a tenant already has the single active Gmail mailbox allowed in this MVP. */
export class GoogleTenantMailboxLimitError extends Error {
  constructor() {
    super("The organisation already has an active Gmail mailbox.");
    this.name = "GoogleTenantMailboxLimitError";
  }
}

export function googleConnectionConfigFromEnvironment(
  environment: AppEnvironment,
): GoogleConnectionConfig {
  if (!environment.GMAIL_INTEGRATION_ENABLED) {
    return { enabled: false, appBaseUrl: environment.APP_BASE_URL };
  }

  return {
    enabled: true,
    appBaseUrl: environment.APP_BASE_URL,
    encryptionKey: environment.APP_ENCRYPTION_KEY,
    oauthClient: {
      clientId: environment.GOOGLE_CLIENT_ID!,
      clientSecret: environment.GOOGLE_CLIENT_SECRET!,
      redirectUri: environment.GOOGLE_REDIRECT_URI!,
    },
  };
}

function requireEnabledConfig(config: GoogleConnectionConfig): {
  appBaseUrl?: string;
  encryptionKey: string;
  oauthClient: GoogleOAuthClient;
} {
  if (!config.enabled) {
    throw new GoogleConnectionError(
      "integration_disabled",
      503,
      "Gmail connection is not enabled for this deployment.",
    );
  }

  if (!config.encryptionKey || !config.oauthClient) {
    throw new GoogleConnectionError(
      "configuration_invalid",
      503,
      "Gmail connection is not configured safely.",
    );
  }

  return {
    appBaseUrl: config.appBaseUrl,
    encryptionKey: config.encryptionKey,
    oauthClient: config.oauthClient,
  };
}

function requireOwner(context: TenantContext): void {
  if (context.role !== "owner") {
    throw new GoogleConnectionError(
      "owner_required",
      403,
      "Only an organisation owner can manage the Gmail connection.",
    );
  }
}

function oauthAttemptAad(tenantId: string, attemptId: string): string {
  return buildSecretAad({
    tenantId,
    resourceType: "gmail_oauth_attempt",
    resourceId: attemptId,
    field: "pkce_verifier_and_nonce",
  });
}

function credentialAad(
  tenantId: string,
  credentialId: string,
  field: "access_token" | "refresh_token",
): string {
  return buildSecretAad({
    tenantId,
    resourceType: "mailbox_credential",
    resourceId: credentialId,
    field,
  });
}

function requireExactScopes(scopes: readonly string[]): void {
  const received = new Set(scopes);
  const required = new Set<string>(GOOGLE_GMAIL_DRAFT_SCOPES);
  if (
    received.size !== required.size ||
    ![...required].every((scope) => received.has(scope))
  ) {
    throw new GoogleConnectionError(
      "scope_mismatch",
      400,
      "Google did not grant the exact permissions required for the draft-only connection.",
    );
  }
}

function parseAttemptScopes(scopesJson: string): string[] {
  try {
    const value: unknown = JSON.parse(scopesJson);
    if (!Array.isArray(value) || !value.every((scope) => typeof scope === "string")) {
      throw new TypeError();
    }
    requireExactScopes(value);
    return value;
  } catch (error) {
    if (error instanceof GoogleConnectionError) throw error;
    throw new GoogleConnectionError(
      "state_invalid",
      400,
      "The Gmail connection attempt is invalid or has expired.",
    );
  }
}

function parseSecretBundle(plaintext: string): OAuthSecretBundle {
  try {
    const value: unknown = JSON.parse(plaintext);
    if (
      !value ||
      typeof value !== "object" ||
      !("codeVerifier" in value) ||
      !("nonce" in value) ||
      typeof value.codeVerifier !== "string" ||
      typeof value.nonce !== "string" ||
      !OPAQUE_VALUE_PATTERN.test(value.codeVerifier) ||
      !OPAQUE_VALUE_PATTERN.test(value.nonce)
    ) {
      throw new TypeError();
    }
    return { codeVerifier: value.codeVerifier, nonce: value.nonce };
  } catch {
    throw new GoogleConnectionError(
      "state_invalid",
      400,
      "The Gmail connection attempt is invalid or has expired.",
    );
  }
}

function safeProviderError(value: string | null | undefined): string {
  return value && SAFE_PROVIDER_ERRORS.has(value) ? value : "oauth_error";
}

function oauthFailureCode(error: unknown): string {
  if (error instanceof GoogleOAuthRequestError) return error.code;
  if (error instanceof GoogleIdTokenValidationError) return "identity_invalid";
  if (error instanceof GoogleConnectionError) return error.code;
  if (error instanceof GoogleProviderAccountConflictError) return "account_conflict";
  if (error instanceof GoogleTenantMailboxLimitError) return "mailbox_limit";
  return "connection_failed";
}

export function assertTrustedJsonMutation(
  request: Request,
  appBaseUrl?: string,
): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new GoogleConnectionError(
      "invalid_content_type",
      415,
      "This operation requires a JSON request.",
    );
  }

  const requestOrigin = new URL(request.url).origin;
  const expectedOrigin = appBaseUrl ? new URL(appBaseUrl).origin : requestOrigin;
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin || suppliedOrigin !== expectedOrigin) {
    throw new GoogleConnectionError(
      "origin_forbidden",
      403,
      "A trusted same-origin request is required.",
    );
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new GoogleConnectionError(
      "origin_forbidden",
      403,
      "A trusted same-origin request is required.",
    );
  }
}

export function googleConnectionErrorResponse(error: unknown): Response {
  if (error instanceof GoogleConnectionError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }
  throw error;
}

export function appendGoogleOutcome(
  returnPath: string,
  outcome: "connected" | "disconnected" | "error",
  reason?: string,
): string {
  const safePath = safeRelativeReturnPath(returnPath, "/");
  const url = new URL(safePath, "https://clearinbox.invalid");
  url.searchParams.set("gmail", outcome);
  if (reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function createGoogleConnectionService(dependencies: GoogleConnectionDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const randomUuid = dependencies.randomUuid ?? (() => crypto.randomUUID());
  const generateState = dependencies.generateState ?? generateOAuthState;
  const generateNonce = dependencies.generateNonce ?? generateOAuthNonce;
  const generatePkce = dependencies.generatePkce ?? generatePkcePair;
  const exchangeCode = dependencies.exchangeCode ?? exchangeGoogleAuthorizationCode;
  const validateIdToken = dependencies.validateIdToken ?? validateGoogleIdToken;
  const revokeToken = dependencies.revokeToken ?? revokeGoogleToken;

  return {
    async start(
      context: TenantContext,
      input: { returnPath?: string },
    ): Promise<{ authorizationUrl: string; expiresAt: string }> {
      requireOwner(context);
      const config = requireEnabledConfig(dependencies.config);
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + OAUTH_ATTEMPT_TTL_MS);
      const attemptId = randomUuid();
      const [state, nonce, pkce] = await Promise.all([
        Promise.resolve(generateState()),
        Promise.resolve(generateNonce()),
        generatePkce(),
      ]);
      const secretBundle = JSON.stringify({ codeVerifier: pkce.codeVerifier, nonce });
      const [stateHash, nonceHash, codeVerifierEncrypted] = await Promise.all([
        sha256Hex(state),
        sha256Hex(nonce),
        encryptSecret(
          secretBundle,
          config.encryptionKey,
          oauthAttemptAad(context.tenantId, attemptId),
        ),
      ]);
      const returnPath = safeRelativeReturnPath(input.returnPath, "/");

      await dependencies.store.createOAuthAttempt({
        id: attemptId,
        tenantId: context.tenantId,
        actorEmail: context.userEmail,
        stateHash,
        nonceHash,
        codeVerifierEncrypted,
        redirectUri: config.oauthClient.redirectUri,
        returnPath,
        scopesJson: JSON.stringify(GOOGLE_GMAIL_DRAFT_SCOPES),
        expiresAt,
        consumedAt: null,
        createdAt,
      });

      await dependencies.audit({
        tenantId: context.tenantId,
        actorType: "user",
        actorId: context.userId,
        eventType: "gmail.connection_started",
        action: "start_gmail_oauth",
        targetType: "gmail_oauth_attempt",
        targetId: attemptId,
        result: "pending",
        metadata: { expiresAt: expiresAt.toISOString(), scopeCount: GOOGLE_GMAIL_DRAFT_SCOPES.length },
      });

      return {
        authorizationUrl: buildGoogleAuthorizationUrl({
          clientId: config.oauthClient.clientId,
          redirectUri: config.oauthClient.redirectUri,
          state,
          nonce,
          codeChallenge: pkce.codeChallenge,
          loginHint: context.userEmail,
        }),
        expiresAt: expiresAt.toISOString(),
      };
    },

    async complete(
      context: TenantContext,
      input: { state?: string | null; code?: string | null; providerError?: string | null },
    ): Promise<
      | { outcome: "connected"; returnPath: string; mailboxId: string; address: string }
      | { outcome: "provider_error"; returnPath: string; reason: string }
    > {
      requireOwner(context);
      const config = requireEnabledConfig(dependencies.config);
      const receivedState = input.state;
      if (!receivedState || !OPAQUE_VALUE_PATTERN.test(receivedState)) {
        await dependencies.audit({
          tenantId: context.tenantId,
          actorType: "user",
          actorId: context.userId,
          eventType: "gmail.connection_denied",
          action: "complete_gmail_oauth",
          targetType: "gmail_oauth_attempt",
          result: "denied",
          metadata: { reason: "state_invalid" },
        });
        throw new GoogleConnectionError(
          "state_invalid",
          400,
          "The Gmail connection attempt is invalid or has expired.",
        );
      }

      const attempt = await dependencies.store.consumeOAuthAttempt({
        tenantId: context.tenantId,
        actorEmail: context.userEmail,
        stateHash: await sha256Hex(receivedState),
        now: now(),
      });

      if (!attempt) {
        await dependencies.audit({
          tenantId: context.tenantId,
          actorType: "user",
          actorId: context.userId,
          eventType: "gmail.connection_denied",
          action: "complete_gmail_oauth",
          targetType: "gmail_oauth_attempt",
          result: "denied",
          metadata: { reason: "state_invalid_or_replayed" },
        });
        throw new GoogleConnectionError(
          "state_invalid",
          400,
          "The Gmail connection attempt is invalid or has expired.",
        );
      }

      const returnPath = safeRelativeReturnPath(attempt.returnPath, "/");
      const auditAttemptFailure = async (reason: string) => {
        await dependencies.audit({
          tenantId: context.tenantId,
          actorType: "integration",
          actorId: "google",
          eventType: "gmail.connection_failed",
          action: "complete_gmail_oauth",
          targetType: "gmail_oauth_attempt",
          targetId: attempt.id,
          result: "failure",
          integrationResult: reason,
          metadata: { reason },
        });
      };
      if (attempt.redirectUri !== config.oauthClient.redirectUri) {
        await auditAttemptFailure("configuration_changed");
        throw new GoogleConnectionError(
          "configuration_changed",
          409,
          "The Gmail connection configuration changed; please start again.",
          { returnPath },
        );
      }
      try {
        parseAttemptScopes(attempt.scopesJson);
      } catch (error) {
        await auditAttemptFailure("state_invalid");
        if (error instanceof GoogleConnectionError) {
          throw new GoogleConnectionError(error.code, error.status, error.message, { returnPath });
        }
        throw error;
      }

      const providerError = input.providerError
        ? safeProviderError(input.providerError)
        : undefined;
      if (providerError) {
        await auditAttemptFailure(providerError);
        return { outcome: "provider_error", returnPath, reason: providerError };
      }

      if (!input.code?.trim() || input.code.length > 4_096) {
        await auditAttemptFailure("code_missing");
        throw new GoogleConnectionError(
          "code_missing",
          400,
          "Google did not return a usable authorization code.",
          { returnPath },
        );
      }

      try {
        const secretBundle = parseSecretBundle(
          await decryptSecret(
            attempt.codeVerifierEncrypted,
            config.encryptionKey,
            oauthAttemptAad(context.tenantId, attempt.id),
          ),
        );
        if ((await sha256Hex(secretBundle.nonce)) !== attempt.nonceHash) {
          throw new GoogleConnectionError(
            "state_invalid",
            400,
            "The Gmail connection attempt is invalid or has expired.",
            { returnPath },
          );
        }

        const tokens: GoogleTokenSet = await exchangeCode({
          client: config.oauthClient,
          code: input.code,
          codeVerifier: secretBundle.codeVerifier,
          now: now().getTime(),
        });
        if (!tokens.idToken) {
          throw new GoogleConnectionError(
            "identity_invalid",
            400,
            "Google did not return a verifiable account identity.",
            { returnPath },
          );
        }
        requireExactScopes(tokens.scopes);

        const identity: GoogleIdentity = await validateIdToken(tokens.idToken, {
          clientId: config.oauthClient.clientId,
          nonce: secretBundle.nonce,
        });
        const existing = await dependencies.store.findByProviderAccount(identity.subject);
        if (existing && existing.mailbox.tenantId !== context.tenantId) {
          throw new GoogleProviderAccountConflictError();
        }

        const mailboxId = existing?.mailbox.id ?? randomUuid();
        const credentialId = existing?.credential?.id ?? randomUuid();
        if (!tokens.refreshToken && !existing?.credential?.refreshTokenEncrypted) {
          throw new GoogleConnectionError(
            "refresh_token_missing",
            400,
            "Google did not grant durable offline access; please reconnect and consent again.",
            { returnPath },
          );
        }

        const accessTokenEncrypted = await encryptSecret(
          tokens.accessToken,
          config.encryptionKey,
          credentialAad(context.tenantId, credentialId, "access_token"),
        );
        const refreshTokenEncrypted = tokens.refreshToken
          ? await encryptSecret(
              tokens.refreshToken,
              config.encryptionKey,
              credentialAad(context.tenantId, credentialId, "refresh_token"),
            )
          : existing?.credential?.refreshTokenEncrypted ?? null;
        const tokenExpiresAt = new Date(tokens.expiresAt);

        await dependencies.store.saveConnection({
          mailbox: {
            id: mailboxId,
            tenantId: context.tenantId,
            providerAccountId: identity.subject,
            address: identity.email,
            grantedScopesJson: JSON.stringify([...GOOGLE_GMAIL_DRAFT_SCOPES]),
            tokenExpiresAt,
          },
          credential: {
            id: credentialId,
            accessTokenEncrypted,
            refreshTokenEncrypted,
            tokenExpiresAt,
            encryptionKeyVersion: 1,
          },
          now: now(),
        });

        await dependencies.audit({
          tenantId: context.tenantId,
          actorType: "user",
          actorId: context.userId,
          eventType: "gmail.connected",
          action: "connect_gmail_mailbox",
          targetType: "mailbox",
          targetId: mailboxId,
          result: "success",
          integrationResult: "connected",
          metadata: { provider: "google", scopeCount: GOOGLE_GMAIL_DRAFT_SCOPES.length },
        });

        return {
          outcome: "connected",
          returnPath,
          mailboxId,
          address: identity.email,
        };
      } catch (error) {
        const reason = oauthFailureCode(error);
        await auditAttemptFailure(reason);

        if (error instanceof GoogleConnectionError) {
          throw error.returnPath
            ? error
            : new GoogleConnectionError(error.code, error.status, error.message, { returnPath });
        }
        if (error instanceof GoogleProviderAccountConflictError) {
          throw new GoogleConnectionError(
            "account_conflict",
            409,
            "This Google account is already connected to another organisation.",
            { returnPath },
          );
        }
        if (error instanceof GoogleTenantMailboxLimitError) {
          throw new GoogleConnectionError(
            "mailbox_limit",
            409,
            "Disconnect the current Gmail mailbox before connecting a different account.",
            { returnPath },
          );
        }
        if (error instanceof GoogleOAuthRequestError) {
          throw new GoogleConnectionError(
            error.code,
            error.retryable ? 503 : 400,
            "Google could not complete the connection safely.",
            { returnPath },
          );
        }
        if (error instanceof GoogleIdTokenValidationError) {
          throw new GoogleConnectionError(
            "identity_invalid",
            400,
            "Google returned an identity that could not be verified.",
            { returnPath },
          );
        }
        throw new GoogleConnectionError(
          "connection_failed",
          500,
          "The Gmail connection could not be completed safely.",
          { returnPath },
        );
      }
    },

    async disconnect(
      context: TenantContext,
      input: { mailboxId: string },
    ): Promise<{ mailboxId: string; status: "disconnected"; revocation: string }> {
      requireOwner(context);
      const config = requireEnabledConfig(dependencies.config);
      const target = await dependencies.store.findDisconnectTarget({
        tenantId: context.tenantId,
        mailboxId: input.mailboxId,
      });
      if (!target) {
        throw new GoogleConnectionError(
          "mailbox_not_found",
          404,
          "The Gmail mailbox was not found.",
        );
      }

      let revocation = "no_local_credential";
      if (target.credential) {
        revocation = "failed";
        try {
          const encryptedToken =
            target.credential.refreshTokenEncrypted ?? target.credential.accessTokenEncrypted;
          const field = target.credential.refreshTokenEncrypted
            ? "refresh_token"
            : "access_token";
          const token = await decryptSecret(
            encryptedToken,
            config.encryptionKey,
            credentialAad(context.tenantId, target.credential.id, field),
          );
          await revokeToken({ token });
          revocation = "revoked";
        } catch {
          // Revocation is deliberately best-effort. Local credentials are removed below.
        }
      }

      const disconnectedAt = now();
      await dependencies.store.disconnectLocal({
        tenantId: context.tenantId,
        mailboxId: target.mailbox.id,
        now: disconnectedAt,
      });
      await dependencies.audit({
        tenantId: context.tenantId,
        actorType: "user",
        actorId: context.userId,
        eventType: "gmail.disconnected",
        action: "disconnect_gmail_mailbox",
        targetType: "mailbox",
        targetId: target.mailbox.id,
        result: "success",
        integrationResult: revocation,
        metadata: { provider: "google", revocation },
      });

      return { mailboxId: target.mailbox.id, status: "disconnected", revocation };
    },
  };
}
