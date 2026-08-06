import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships } from "@/db/schema";

export type TenantContext = {
  tenantId: string;
  userEmail: string;
  role: "admin" | "approver" | "operator" | "viewer";
};

export class AuthenticationError extends Error {
  readonly status = 401;
}

export class AuthorizationError extends Error {
  readonly status = 403;
}

export async function resolveTenantContext(requestHeaders: Headers): Promise<TenantContext> {
  const authenticatedEmail = requestHeaders
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();

  if (!authenticatedEmail) {
    throw new AuthenticationError("Authenticated workspace identity is required.");
  }

  const db = getDb();
  const rows = await db
    .select({
      tenantId: memberships.tenantId,
      userEmail: memberships.userEmail,
      role: memberships.role,
    })
    .from(memberships)
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

  return rows[0];
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
  if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "The request could not be completed safely." }, { status: 500 });
}
