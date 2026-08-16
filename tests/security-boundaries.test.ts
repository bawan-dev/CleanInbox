import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function source(relativePath: string): string {
  return readFileSync(join(projectRoot, ...relativePath.split("/")), "utf8");
}

function typescriptSources(relativeDirectory: string): Array<{ path: string; contents: string }> {
  const root = join(projectRoot, ...relativeDirectory.split("/"));
  const files: Array<{ path: string; contents: string }> = [];

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
        files.push({
          path: absolutePath.slice(projectRoot.length + 1).replaceAll("\\", "/"),
          contents: readFileSync(absolutePath, "utf8"),
        });
      }
    }
  };

  visit(root);
  return files;
}

test("authentication boundary rejects a missing workspace identity before database access", () => {
  const contents = source("lib/tenant-context.ts");
  const resolverStart = contents.indexOf("export function resolveAuthenticatedEmail");
  const headerRead = contents.indexOf('.get("oai-authenticated-user-email")', resolverStart);
  const missingIdentityCheck = contents.indexOf("if (!authenticatedEmail)", headerRead);
  const rejection = contents.indexOf("throw new AuthenticationError", missingIdentityCheck);
  const databaseAccess = contents.indexOf("const db = getDb()", resolverStart);

  assert.ok(resolverStart >= 0, "authenticated identity resolver must remain exported");
  assert.ok(headerRead > resolverStart, "identity must come from the trusted server header");
  assert.ok(missingIdentityCheck > headerRead, "an absent or blank identity must be checked");
  assert.ok(rejection > missingIdentityCheck, "missing identity must raise AuthenticationError");
  assert.ok(databaseAccess > rejection, "authentication must happen before tenant D1 access");
  assert.match(contents, /class AuthenticationError extends Error[\s\S]*?status\s*=\s*401/u);
});

test("owner and reviewer capabilities are guarded by the server-side role matrix", () => {
  const tenantContext = source("lib/tenant-context.ts");
  assert.match(tenantContext, /allowedRoles\.includes\(context\.role\)/u);

  const ownerOnlyRoutes = [
    "app/api/audit/route.ts",
    "app/api/members/route.ts",
    "app/api/retention/route.ts",
    "app/api/settings/route.ts",
  ];
  for (const route of ownerOnlyRoutes) {
    assert.match(
      source(route),
      /requireRole\(context, \["owner"\]\)/u,
      `${route} must remain owner-only`,
    );
  }

  const reviewerWorkflowRoutes = [
    "app/api/drafts/[draftId]/approve/route.ts",
    "app/api/drafts/[draftId]/gmail/route.ts",
    "app/api/drafts/[draftId]/route.ts",
    "app/api/gmail/sync/route.ts",
    "app/api/messages/[messageId]/analyse/route.ts",
    "app/api/messages/[messageId]/draft/route.ts",
  ];
  for (const route of reviewerWorkflowRoutes) {
    assert.match(
      source(route),
      /requireRole\(context, \["owner", "reviewer"\]\)/u,
      `${route} must explicitly allow the owner/reviewer workflow roles`,
    );
  }

  assert.match(source("lib/google/connection-service.ts"), /context\.role !== "owner"/u);
});

test("every tenant API route derives identity and tenant context on the server", () => {
  const routes = typescriptSources("app/api").filter(
    ({ path }) => path.endsWith("/route.ts") && path !== "app/api/health/route.ts",
  );

  assert.ok(routes.length >= 15, "the protected route inventory unexpectedly shrank");
  for (const route of routes) {
    assert.match(
      route.contents,
      /resolveTenantContext\(request\.headers\)|resolveAuthenticatedEmail\(request\.headers\)/u,
      `${route.path} must derive the user from the trusted request context`,
    );
    assert.doesNotMatch(
      route.contents,
      /tenantId\s*:\s*z\.|searchParams\.get\(["']tenantId["']\)|["']tenantId["']\s+in\s+payload/u,
      `${route.path} must not accept a browser-selected tenant`,
    );
  }
});

test("direct tenant data routes and delegated workflows preserve tenant scoping", () => {
  const directDataRoutes = typescriptSources("app/api").filter(
    ({ path, contents }) =>
      path.endsWith("/route.ts") && path !== "app/api/health/route.ts" && contents.includes("getDb()"),
  );
  for (const route of directDataRoutes) {
    assert.match(
      route.contents,
      /context\.tenantId/u,
      `${route.path} queries D1 and therefore must bind the server-derived tenant`,
    );
  }

  const delegatedScopes: Array<[string, RegExp]> = [
    ["app/api/drafts/[draftId]/approve/route.ts", /approveCurrentDraft\(context,/u],
    ["app/api/drafts/[draftId]/gmail/route.ts", /tenantId:\s*context\.tenantId/u],
    ["app/api/gmail/callback/route.ts", /runtime\.service\.complete\(context,/u],
    ["app/api/gmail/connect/route.ts", /runtime\.service\.start\(context,/u],
    ["app/api/gmail/disconnect/route.ts", /runtime\.service\.disconnect\(context,/u],
    ["app/api/gmail/sync/route.ts", /tenantId:\s*context\.tenantId/u],
    ["app/api/messages/[messageId]/analyse/route.ts", /analyzeImportedMessage\(context,/u],
    ["app/api/messages/[messageId]/draft/route.ts", /\bcontext,/u],
  ];
  for (const [route, tenantBinding] of delegatedScopes) {
    assert.match(source(route), tenantBinding, `${route} must pass its server-derived tenant context`);
  }

  const credentialStore = source("lib/google/connection-store.ts");
  assert.match(credentialStore, /eq\(mailboxes\.tenantId, input\.tenantId\)/u);
  assert.match(credentialStore, /eq\(mailboxCredentials\.tenantId, input\.tenantId\)/u);
  assert.match(source("lib/sync/d1.ts"), /eq\(mailboxes\.tenantId, tenantId\)/u);
});

test("OAuth attempts are tenant-bound, actor-bound, expiring, and single-use", () => {
  const store = source("lib/google/connection-store.ts");
  const service = source("lib/google/connection-service.ts");

  assert.match(store, /eq\(gmailOAuthAttempts\.tenantId, input\.tenantId\)/u);
  assert.match(store, /eq\(gmailOAuthAttempts\.actorEmail, input\.actorEmail\)/u);
  assert.match(store, /eq\(gmailOAuthAttempts\.stateHash, input\.stateHash\)/u);
  assert.match(store, /isNull\(gmailOAuthAttempts\.consumedAt\)/u);
  assert.match(store, /gt\(gmailOAuthAttempts\.expiresAt, input\.now\)/u);
  assert.match(service, /stateHash:\s*await sha256Hex\(receivedState\)/u);
  assert.match(service, /state_invalid_or_replayed/u);
});

test("Gmail OAuth routes never serialize token or credential fields", () => {
  const oauthRoutes = [
    "app/api/gmail/callback/route.ts",
    "app/api/gmail/connect/route.ts",
    "app/api/gmail/disconnect/route.ts",
    "app/api/gmail/status/route.ts",
  ];
  const forbiddenResponseMaterial =
    /accessToken|refreshToken|idToken|clientSecret|credentialReference|TokenEncrypted/u;

  for (const route of oauthRoutes) {
    assert.doesNotMatch(
      source(route),
      forbiddenResponseMaterial,
      `${route} must not select or name secret-bearing fields`,
    );
  }
});

test("protected draft routes cannot accept a browser approval boolean", () => {
  const approvalRoute = source("app/api/drafts/[draftId]/approve/route.ts");
  const executionRoute = source("app/api/drafts/[draftId]/gmail/route.ts");
  const protectedDraftRoutes = [
    approvalRoute,
    executionRoute,
    source("app/api/drafts/[draftId]/route.ts"),
    source("app/api/messages/[messageId]/draft/route.ts"),
  ].join("\n");

  assert.match(approvalRoute, /approvalInputSchema\s*=\s*z\.object\(\{\}\)\.strict\(\)/u);
  assert.match(executionRoute, /executeApprovedGmailDraft\(\{/u);
  assert.doesNotMatch(
    protectedDraftRoutes,
    /approvalRecorded|approvalVerified|approvedByClient|isApproved|approved\s*:\s*z\.boolean/u,
  );
});

test("Gmail provider code exposes read operations and draft creation only", () => {
  const providerCode = [
    ...typescriptSources("lib/gmail"),
    ...typescriptSources("lib/google"),
    ...typescriptSources("lib/sync"),
    ...typescriptSources("lib/drafts"),
    ...typescriptSources("app/api/gmail"),
    ...typescriptSources("app/api/drafts"),
  ];
  const forbiddenCapabilities = [
    /\b(?:messages|threads|drafts)\.(?:send|modify|trash|delete)\b/iu,
    /\/gmail\/v1\/users\/me\/(?:messages|threads|drafts)\/[^\s"'`]*(?:\/send|\/modify|\/trash)(?:\b|\/)/iu,
    /\b(?:addLabelIds|removeLabelIds)\b/u,
    /https:\/\/www\.googleapis\.com\/auth\/gmail\.(?:send|modify)\b/iu,
    /https:\/\/mail\.google\.com\//iu,
    /method\s*:\s*["'`]DELETE["'`]/u,
  ];

  for (const file of providerCode) {
    for (const forbidden of forbiddenCapabilities) {
      assert.doesNotMatch(file.contents, forbidden, `${file.path} exposes a forbidden Gmail mutation`);
    }
  }
});

test("message detail is text-only, blocks remote content, and keeps attachments metadata-only", () => {
  const detailRoute = source("app/api/messages/[messageId]/route.ts");
  const inboxUi = source("examples/demo-ui/clear-inbox-app.tsx");
  const parser = source("lib/sync/parser.ts");
  const gmailClient = source("lib/gmail/client.ts");

  assert.match(detailRoute, /textBody:\s*messages\.textBody/u);
  assert.match(
    detailRoute,
    /safety:\s*\{\s*htmlRendered:\s*false,\s*remoteContentLoaded:\s*false,\s*attachmentsProcessed:\s*false\s*\}/u,
  );
  assert.doesNotMatch(detailRoute, /dangerouslySetInnerHTML|htmlBody:\s*messages\./u);
  assert.doesNotMatch(inboxUi, /dangerouslySetInnerHTML/u);

  assert.match(parser, /mimeType\?\.toLowerCase\(\) === "text\/plain" && !isAttachment\(part\)/u);
  assert.match(parser, /providerAttachmentId[\s\S]*?filename[\s\S]*?mimeType[\s\S]*?sizeBytes/u);
  assert.doesNotMatch(gmailClient, /attachments\.get|\/attachments\//iu);
});

