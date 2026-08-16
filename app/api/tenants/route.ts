import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { memberships, tenantSettings, tenants, users } from "@/db/schema";
import { appendAuditEvent } from "@/lib/audit";
import {
  ConflictError,
  jsonError,
  resolveAuthenticatedEmail,
  resolveTenantContext,
} from "@/lib/tenant-context";

const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

function slugify(name: string) {
  const stem = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 45);

  return `${stem || "organisation"}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function GET(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    return Response.json({
      tenant: {
        id: context.tenantId,
        name: context.tenantName,
        role: context.role,
      },
      user: { id: context.userId, email: context.userEmail },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const email = resolveAuthenticatedEmail(request.headers);
    const parsed = createTenantSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: "A valid organisation name is required." }, { status: 400 });
    }

    const db = getDb();
    const [existingMembership] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userEmail, email), eq(memberships.status, "active")))
      .limit(1);

    if (existingMembership) {
      throw new ConflictError("This account already belongs to an active organisation.");
    }

    const now = new Date();
    const userId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();

    await db.batch([
      db
        .insert(users)
        .values({
          id: userId,
          email,
          status: "active",
          lastSignedInAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { status: "active", lastSignedInAt: now, updatedAt: now },
        }),
      db.insert(tenants).values({
        id: tenantId,
        slug: slugify(parsed.data.name),
        name: parsed.data.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(memberships).values({
        id: membershipId,
        tenantId,
        userEmail: email,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(tenantSettings).values({
        id: crypto.randomUUID(),
        tenantId,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    await appendAuditEvent(
      {
        tenantId,
        actorType: "user",
        actorId: user?.id ?? userId,
        eventType: "tenant.created",
        action: "create_tenant",
        targetType: "tenant",
        targetId: tenantId,
        result: "success",
        metadata: { name: parsed.data.name },
      },
      db,
    );

    return Response.json(
      { tenant: { id: tenantId, name: parsed.data.name, role: "owner" } },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}

