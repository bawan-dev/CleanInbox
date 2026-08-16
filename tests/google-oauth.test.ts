import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_GMAIL_DRAFT_SCOPES,
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleIdTokenValidationError,
  GoogleOAuthRequestError,
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  generateOAuthNonce,
  generateOAuthState,
  generatePkcePair,
  oauthStateMatches,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  safeRelativeReturnPath,
  validateGoogleIdToken,
  type FetchImplementation,
} from "../lib/google/oauth";
import { sha256Base64Url } from "../lib/security/crypto";

const oauthClient = {
  clientId: "client.apps.googleusercontent.com",
  clientSecret: "google-client-secret",
  redirectUri: "https://clearinbox.example/api/google/callback",
};

test("OAuth state, nonce, and PKCE values use secure URL-safe entropy", async () => {
  const state = generateOAuthState();
  const nonce = generateOAuthNonce();
  const pkce = await generatePkcePair();

  assert.match(state, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(pkce.codeChallengeMethod, "S256");
  assert.equal(pkce.codeChallenge, await sha256Base64Url(pkce.codeVerifier));
  assert.equal(await oauthStateMatches(state, state), true);
  assert.equal(await oauthStateMatches(state, generateOAuthState()), false);
  assert.equal(await oauthStateMatches(undefined, state), false);
});

test("authorization URL is locked to the Gmail draft-only scope set and PKCE", async () => {
  const state = generateOAuthState();
  const nonce = generateOAuthNonce();
  const pkce = await generatePkcePair();
  const authorizationUrl = new URL(
    buildGoogleAuthorizationUrl({
      clientId: oauthClient.clientId,
      redirectUri: oauthClient.redirectUri,
      state,
      nonce,
      codeChallenge: pkce.codeChallenge,
    }),
  );

  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
  assert.deepEqual(
    authorizationUrl.searchParams.get("scope")?.split(" "),
    [...GOOGLE_GMAIL_DRAFT_SCOPES],
  );
  assert.equal(authorizationUrl.searchParams.get("state"), state);
  assert.equal(authorizationUrl.searchParams.get("nonce"), nonce);
  assert.equal(authorizationUrl.searchParams.get("code_challenge"), pkce.codeChallenge);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
  assert.equal(
    authorizationUrl.searchParams.get("scope")?.includes("gmail.send"),
    false,
  );
});

test("relative return paths reject open redirect and decoding variants", () => {
  assert.equal(safeRelativeReturnPath("/mailboxes?connected=1"), "/mailboxes?connected=1");
  assert.equal(safeRelativeReturnPath("https://evil.example/path", "/safe"), "/safe");
  assert.equal(safeRelativeReturnPath("//evil.example/path", "/safe"), "/safe");
  assert.equal(safeRelativeReturnPath("/\\evil.example/path", "/safe"), "/safe");
  assert.equal(safeRelativeReturnPath("/%2f%2fevil.example/path", "/safe"), "/safe");
  assert.equal(safeRelativeReturnPath("/%255c%255cevil.example", "/safe"), "/safe");
  assert.equal(safeRelativeReturnPath("javascript:alert(1)", "also-unsafe"), "/");
});

test("authorization-code exchange sends credentials server-side with exact redirect and PKCE", async () => {
  const pkce = await generatePkcePair();
  let observedUrl = "";
  let observedBody: URLSearchParams | undefined;

  const mockFetch: FetchImplementation = async (input, init) => {
    observedUrl = String(input);
    observedBody = new URLSearchParams(String(init?.body));
    return Response.json({
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
      id_token: "id-token-value",
      expires_in: 3_600,
      scope: GOOGLE_GMAIL_DRAFT_SCOPES.join(" "),
      token_type: "Bearer",
    });
  };

  const tokens = await exchangeGoogleAuthorizationCode({
    client: oauthClient,
    code: "one-time-code",
    codeVerifier: pkce.codeVerifier,
    fetch: mockFetch,
    now: 1_000,
  });

  assert.equal(observedUrl, GOOGLE_TOKEN_ENDPOINT);
  assert.equal(observedBody?.get("grant_type"), "authorization_code");
  assert.equal(observedBody?.get("client_secret"), oauthClient.clientSecret);
  assert.equal(observedBody?.get("redirect_uri"), oauthClient.redirectUri);
  assert.equal(observedBody?.get("code_verifier"), pkce.codeVerifier);
  assert.deepEqual(tokens, {
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    idToken: "id-token-value",
    tokenType: "Bearer",
    expiresInSeconds: 3_600,
    expiresAt: 3_601_000,
    scopes: [...GOOGLE_GMAIL_DRAFT_SCOPES],
  });
});

test("refresh and revoke use POST form requests without putting tokens in URLs", async () => {
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  const mockFetch: FetchImplementation = async (input, init) => {
    const request = {
      url: String(input),
      body: new URLSearchParams(String(init?.body)),
    };
    requests.push(request);

    if (request.url === GOOGLE_TOKEN_ENDPOINT) {
      return Response.json({
        access_token: "new-access-token",
        expires_in: 1_800,
        token_type: "Bearer",
      });
    }
    return new Response(null, { status: 200 });
  };

  const tokens = await refreshGoogleAccessToken({
    client: oauthClient,
    refreshToken: "stored-refresh-token",
    fetch: mockFetch,
    now: 2_000,
  });
  await revokeGoogleToken({ token: "stored-refresh-token", fetch: mockFetch });

  assert.equal(tokens.accessToken, "new-access-token");
  assert.equal(requests[0].body.get("grant_type"), "refresh_token");
  assert.equal(requests[0].body.get("refresh_token"), "stored-refresh-token");
  assert.equal(requests[0].url.includes("stored-refresh-token"), false);
  assert.equal(requests[1].url, GOOGLE_REVOCATION_ENDPOINT);
  assert.equal(requests[1].body.get("token"), "stored-refresh-token");
  assert.equal(requests[1].url.includes("stored-refresh-token"), false);
});

test("OAuth endpoint errors are sanitized and never include provider descriptions", async () => {
  const pkce = await generatePkcePair();
  const leakedValue = "ya29.value-that-must-never-escape";
  const mockFetch: FetchImplementation = async () =>
    Response.json(
      {
        error: "invalid_grant",
        error_description: `provider response accidentally contained ${leakedValue}`,
      },
      { status: 400 },
    );

  await assert.rejects(
    exchangeGoogleAuthorizationCode({
      client: oauthClient,
      code: "one-time-code",
      codeVerifier: pkce.codeVerifier,
      fetch: mockFetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleOAuthRequestError);
      assert.equal(error.code, "invalid_grant");
      assert.equal(error.status, 400);
      assert.equal(JSON.stringify(error).includes(leakedValue), false);
      assert.equal(error.message.includes(leakedValue), false);
      return true;
    },
  );
});

test("jose verification validates Google issuer, audience, expiry, nonce, and email", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1_000);
  const nonce = generateOAuthNonce();
  const idToken = await new SignJWT({
    nonce,
    email: "Owner@Example.com",
    email_verified: true,
    azp: oauthClient.clientId,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(oauthClient.clientId)
    .setSubject("google-account-123")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);

  const identity = await validateGoogleIdToken(idToken, {
    clientId: oauthClient.clientId,
    nonce,
    verificationKey: publicKey,
    currentDate: new Date(now * 1_000),
  });
  assert.deepEqual(identity, {
    subject: "google-account-123",
    email: "owner@example.com",
    emailVerified: true,
    hostedDomain: undefined,
    issuedAt: now,
    expiresAt: now + 300,
  });

  await assert.rejects(
    validateGoogleIdToken(idToken, {
      clientId: oauthClient.clientId,
      nonce: generateOAuthNonce(),
      verificationKey: publicKey,
      currentDate: new Date(now * 1_000),
    }),
    GoogleIdTokenValidationError,
  );

  await assert.rejects(
    validateGoogleIdToken(idToken, {
      clientId: oauthClient.clientId,
      nonce,
      verificationKey: publicKey,
      currentDate: new Date((now + 1_000) * 1_000),
    }),
    GoogleIdTokenValidationError,
  );
});

test("jose verification rejects unverified Google email identities", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1_000);
  const nonce = generateOAuthNonce();
  const idToken = await new SignJWT({
    nonce,
    email: "unverified@example.com",
    email_verified: false,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(oauthClient.clientId)
    .setSubject("google-account-456")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);

  await assert.rejects(
    validateGoogleIdToken(idToken, {
      clientId: oauthClient.clientId,
      nonce,
      verificationKey: publicKey,
      currentDate: new Date(now * 1_000),
    }),
    GoogleIdTokenValidationError,
  );
});
