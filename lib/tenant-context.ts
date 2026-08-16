import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships, tenants, users } from "@/db/schema";

export type TenantRole = "owner" | "reviewer";

export type TenantContext = {
  tenantId: string;
  tenantName: string;
  userId: string;
  userEmail: string;
  role: TenantRole;
};

export class AuthenticationError extends Error {
  readonly status = 401;
}

export class AuthorizationError extends Error {
  readonly status = 403;
}

export class ConflictError extends Error {
  readonly status = 409;
}

export class NotFoundError extends Error {
  readonly status = 404;
}

export function resolveAuthenticatedEmail(requestHeaders: Headers): string {
  const authenticatedEmail = requestHeaders
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();

  if (!authenticatedEmail) {
    throw new AuthenticationError("Authenticated workspace identity is required.");
  }

  return authenticatedEmail;
}

function normalizeRole(role: string): TenantRole {
  if (role === "owner" || role === "admin") {
    return "owner";
  }

  if (role === "reviewer" || role === "approver") {
    return "reviewer";
  }

  throw new AuthorizationError(
    "This legacy membership role cannot access the Gmail draft-only workspace.",
  );
}

export async function resolveTenantContext(requestHeaders: Headers): Promise<TenantContext> {
  const authenticatedEmail = resolveAuthenticatedEmail(requestHeaders);

  const db = getDb();
  const rows = await db
    .select({
      tenantId: memberships.tenantId,
      tenantName: tenants.name,
      userId: users.id,
      userEmail: memberships.userEmail,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(
      tenants,
      and(eq(tenants.id, memberships.tenantId), eq(tenants.status, "active")),
    )
    .innerJoin(
      users,
      and(eq(users.email, memberships.userEmail), eq(users.status, "active")),
    )
    .where(
      and(
        eq(memberships.userEmail, authenticatedEmail),
        eq(memberships.status, "active"),
      ),
    )
    .limit(2);

  if (rows.length === 0) {
    throw new AuthorizationError("No active tenant membership was found.");
  }

  if (rows.length > 1) {
    throw new AuthorizationError(
      "Workspace identity maps to multiple tenants; an explicit server-side tenant session is required.",
    );
  }

  return {
    ...rows[0],
    role: normalizeRole(rows[0].role),
  };
}

export function requireRole(
  context: TenantContext,
  allowedRoles: TenantContext["role"][],
) {
  if (!allowedRoles.includes(context.role)) {
    throw new AuthorizationError("Your role does not permit this operation.");
  }
}

export function jsonError(error: unknown) {
  if (
    error instanceof AuthenticationError ||
    error instanceof AuthorizationError ||
    error instanceof ConflictError ||
    error instanceof NotFoundError
  ) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "The request could not be completed safely." }, { status: 500 });
}
