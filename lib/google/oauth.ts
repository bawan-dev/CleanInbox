import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import {
  encodeBase64Url,
  sha256Base64Url,
  sha256Bytes,
} from "../security/crypto";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";

export const GOOGLE_GMAIL_DRAFT_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const);

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const googleRemoteJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_ENDPOINT));
const SAFE_OAUTH_ERROR_CODES = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "invalid_token",
  "invalid_token_response",
  "network_error",
  "oauth_error",
  "revocation_failed",
  "server_error",
  "temporarily_unavailable",
  "token_endpoint_error",
  "unauthorized_client",
  "unsupported_grant_type",
]);

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GoogleOAuthClient = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GooglePkcePair = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType: string;
  expiresInSeconds: number;
  expiresAt: number;
  scopes: string[];
};

export type GoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: true;
  hostedDomain?: string;
  issuedAt: number;
  expiresAt: number;
};

export class GoogleOAuthRequestError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(code: string, options?: { status?: number; retryable?: boolean }) {
    super("Google OAuth could not complete the requested operation.");
    this.name = "GoogleOAuthRequestError";
    this.code = SAFE_OAUTH_ERROR_CODES.has(code) ? code : "oauth_error";
    this.status = options?.status;
    this.retryable = options?.retryable ?? false;
  }
}

export class GoogleIdTokenValidationError extends Error {
  constructor() {
    super("The Google identity token is invalid.");
    this.name = "GoogleIdTokenValidationError";
  }
}

function randomBytes(byteLength: number): Uint8Array {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 96) {
    throw new RangeError("Secure random token length must be between 16 and 96 bytes.");
  }
  return crypto.getRandomValues(new Uint8Array(byteLength));
}

export function generateOAuthState(): string {
  return encodeBase64Url(randomBytes(32));
}

export function generateOAuthNonce(): string {
  return encodeBase64Url(randomBytes(32));
}

export async function generatePkcePair(): Promise<GooglePkcePair> {
  const codeVerifier = encodeBase64Url(randomBytes(32));
  return {
    codeVerifier,
    codeChallenge: await sha256Base64Url(codeVerifier),
    codeChallengeMethod: "S256",
  };
}

async function constantTimeStringMatch(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    sha256Bytes(left),
    sha256Bytes(right),
  ]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0;
}

/** This checks equality only; expiry and one-time use must be enforced by persisted OAuth state. */
export async function oauthStateMatches(
  receivedState: string | null | undefined,
  expectedState: string | null | undefined,
): Promise<boolean> {
  if (!receivedState || !expectedState) return false;
  if (
    receivedState.length > 256 ||
    expectedState.length > 256 ||
    !OPAQUE_TOKEN_PATTERN.test(receivedState) ||
    !OPAQUE_TOKEN_PATTERN.test(expectedState)
  ) {
    return false;
  }
  return constantTimeStringMatch(receivedState, expectedState);
}

function assertOpaqueParameter(name: string, value: string): void {
  if (value.length < 32 || value.length > 256 || !OPAQUE_TOKEN_PATTERN.test(value)) {
    throw new TypeError(`${name} is not a valid opaque OAuth value.`);
  }
}

function validateOAuthClient(client: GoogleOAuthClient): void {
  if (!client.clientId.trim() || !client.clientSecret.trim()) {
    throw new TypeError("Google OAuth client credentials are required.");
  }

  let redirect: URL;
  try {
    redirect = new URL(client.redirectUri);
  } catch {
    throw new TypeError("Google OAuth redirect URI is invalid.");
  }

  if (
    !["https:", "http:"].includes(redirect.protocol) ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  ) {
    throw new TypeError("Google OAuth redirect URI is invalid.");
  }
}

export function buildGoogleAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  loginHint?: string;
  prompt?: "consent" | "select_account";
}): string {
  assertOpaqueParameter("state", options.state);
  assertOpaqueParameter("nonce", options.nonce);
  if (!OPAQUE_TOKEN_PATTERN.test(options.codeChallenge) || options.codeChallenge.length !== 43) {
    throw new TypeError("codeChallenge must be an S256 PKCE challenge.");
  }

  validateOAuthClient({
    clientId: options.clientId,
    clientSecret: "not-used-for-authorization-url",
    redirectUri: options.redirectUri,
  });

  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_GMAIL_DRAFT_SCOPES.join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  // Consent ensures an initial connection can receive a refresh token.
  url.searchParams.set("prompt", options.prompt ?? "consent");
  if (options.loginHint?.trim()) url.searchParams.set("login_hint", options.loginHint.trim());
  return url.toString();
}

/**
 * Returns a canonical same-origin path or the caller-supplied safe fallback.
 * It rejects encoded slash/backslash variants to remain safe if another layer decodes again.
 */
export function safeRelativeReturnPath(
  candidate: string | null | undefined,
  fallback = "/",
): string {
  const isSafe = (value: string): boolean => {
    if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(value)) {
      return false;
    }

    let decoded = value;
    try {
      for (let pass = 0; pass < 2; pass += 1) decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }

    if (
      decoded.startsWith("//") ||
      decoded.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(decoded)
    ) {
      return false;
    }

    try {
      const resolved = new URL(value, "https://clearinbox.invalid");
      return resolved.origin === "https://clearinbox.invalid";
    } catch {
      return false;
    }
  };

  if (candidate && isSafe(candidate)) {
    const resolved = new URL(candidate, "https://clearinbox.invalid");
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  }

  if (!isSafe(fallback)) return "/";
  const resolvedFallback = new URL(fallback, "https://clearinbox.invalid");
  return `${resolvedFallback.pathname}${resolvedFallback.search}${resolvedFallback.hash}`;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z
    .string()
    .refine((value) => value.toLowerCase() === "bearer")
    .transform(() => "Bearer"),
  id_token: z.string().min(1).optional(),
});

const oauthErrorSchema = z.object({
  error: z.string().min(1).max(128),
});

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function requestToken(
  body: URLSearchParams,
  options?: { fetch?: FetchImplementation; now?: number },
): Promise<GoogleTokenSet> {
  const fetchImplementation = options?.fetch ?? fetch;
  let response: Response;

  try {
    response = await fetchImplementation(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
    });
  } catch {
    throw new GoogleOAuthRequestError("network_error", { retryable: true });
  }

  const responseBody = await parseResponseBody(response);
  if (!response.ok) {
    const parsedError = oauthErrorSchema.safeParse(responseBody);
    throw new GoogleOAuthRequestError(
      parsedError.success ? parsedError.data.error : "token_endpoint_error",
      {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }

  const parsed = tokenResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new GoogleOAuthRequestError("invalid_token_response", {
      status: response.status,
    });
  }

  const now = options?.now ?? Date.now();
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    idToken: parsed.data.id_token,
    tokenType: parsed.data.token_type,
    expiresInSeconds: parsed.data.expires_in,
    expiresAt: now + parsed.data.expires_in * 1_000,
    scopes: parsed.data.scope?.split(/\s+/u).filter(Boolean) ?? [],
  };
}

export async function exchangeGoogleAuthorizationCode(options: {
  client: GoogleOAuthClient;
  code: string;
  codeVerifier: string;
  fetch?: FetchImplementation;
  now?: number;
}): Promise<GoogleTokenSet> {
  validateOAuthClient(options.client);
  if (!options.code.trim()) throw new TypeError("An authorization code is required.");
  if (!PKCE_VERIFIER_PATTERN.test(options.codeVerifier)) {
    throw new TypeError("A valid PKCE code verifier is required.");
  }

  return requestToken(
    new URLSearchParams({
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      code: options.code,
      code_verifier: options.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: options.client.redirectUri,
    }),
    options,
  );
}

export async function refreshGoogleAccessToken(options: {
  client: GoogleOAuthClient;
  refreshToken: string;
  fetch?: FetchImplementation;
  now?: number;
}): Promise<GoogleTokenSet> {
  validateOAuthClient(options.client);
  if (!options.refreshToken.trim()) throw new TypeError("A refresh token is required.");

  return requestToken(
    new URLSearchParams({
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
    }),
    options,
  );
}

export async function revokeGoogleToken(options: {
  token: string;
  fetch?: FetchImplementation;
}): Promise<void> {
  if (!options.token.trim()) throw new TypeError("A token is required for revocation.");
  const fetchImplementation = options.fetch ?? fetch;
  let response: Response;

  try {
    response = await fetchImplementation(GOOGLE_REVOCATION_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: options.token }),
      cache: "no-store",
    });
  } catch {
    throw new GoogleOAuthRequestError("network_error", { retryable: true });
  }

  if (!response.ok) {
    const responseBody = await parseResponseBody(response);
    const parsedError = oauthErrorSchema.safeParse(responseBody);
    throw new GoogleOAuthRequestError(
      parsedError.success ? parsedError.data.error : "revocation_failed",
      {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }
}

export async function validateGoogleIdToken(
  idToken: string,
  options: {
    clientId: string;
    nonce: string;
    expectedHostedDomain?: string;
    verificationKey?: CryptoKey | Uint8Array | JWTVerifyGetKey;
    currentDate?: Date;
  },
): Promise<GoogleIdentity> {
  if (!idToken || idToken.length > 16_384 || !options.clientId || !options.nonce) {
    throw new GoogleIdTokenValidationError();
  }
  if (
    options.nonce.length < 32 ||
    options.nonce.length > 256 ||
    !OPAQUE_TOKEN_PATTERN.test(options.nonce)
  ) {
    throw new GoogleIdTokenValidationError();
  }

  try {
    const { payload } = await jwtVerify(
      idToken,
      options.verificationKey ?? googleRemoteJwks,
      {
        algorithms: ["RS256"],
        audience: options.clientId,
        issuer: GOOGLE_ISSUERS,
        currentDate: options.currentDate,
        clockTolerance: 5,
        requiredClaims: [
          "sub",
          "iat",
          "exp",
          "nonce",
          "email",
          "email_verified",
        ],
      },
    );

    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 255 ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      typeof payload.nonce !== "string" ||
      !(await constantTimeStringMatch(payload.nonce, options.nonce)) ||
      typeof payload.email !== "string" ||
      !payload.email.includes("@") ||
      payload.email_verified !== true ||
      (payload.azp !== undefined && payload.azp !== options.clientId) ||
      (options.expectedHostedDomain !== undefined &&
        payload.hd !== options.expectedHostedDomain)
    ) {
      throw new GoogleIdTokenValidationError();
    }

    return {
      subject: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified: true,
      hostedDomain: typeof payload.hd === "string" ? payload.hd : undefined,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    // Do not expose JWTs or jose's detailed verification errors to callers or logs.
    throw new GoogleIdTokenValidationError();
  }
}
