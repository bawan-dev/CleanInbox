import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { memberships, users } from "@/db/schema";
import { appendAuditEvent } from "@/lib/audit";
import {
  ConflictError,
  jsonError,
  requireRole,
  resolveTenantContext,
} from "@/lib/tenant-context";

const addMemberSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  role: z.enum(["owner", "reviewer"]).default("reviewer"),
});

const removeMemberSchema = z.object({ membershipId: z.string().uuid() }).strict();

export async function GET(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner"]);

    const rows = await getDb()
      .select({
        id: memberships.id,
        email: memberships.userEmail,
        role: memberships.role,
        status: memberships.status,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .where(eq(memberships.tenantId, context.tenantId))
      .orderBy(asc(memberships.userEmail));

    return Response.json({ members: rows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner"]);
    const parsed = addMemberSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: "A valid member email and role are required." }, { status: 400 });
    }

    const db = getDb();
    const [existingMembership] = await db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userEmail, parsed.data.email),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1);
    if (existingMembership && existingMembership.tenantId !== context.tenantId) {
      throw new ConflictError(
        "This account already belongs to another organisation in the single-organisation MVP.",
      );
    }

    const now = new Date();
    const invitedUserId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();

    await db.batch([
      db
        .insert(users)
        .values({
          id: invitedUserId,
          email: parsed.data.email,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: users.email }),
      db
        .insert(memberships)
        .values({
          id: membershipId,
          tenantId: context.tenantId,
          userEmail: parsed.data.email,
          role: parsed.data.role,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [memberships.tenantId, memberships.userEmail],
          set: { role: parsed.data.role, status: "active", updatedAt: now },
        }),
    ]);

    const [member] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, context.tenantId),
          eq(memberships.userEmail, parsed.data.email),
        ),
      )
      .limit(1);

    await appendAuditEvent(
      {
        tenantId: context.tenantId,
        actorType: "user",
        actorId: context.userId,
        eventType: "member.added",
        action: "add_member",
        targetType: "membership",
        targetId: member?.id ?? membershipId,
        result: "success",
        metadata: { role: parsed.data.role },
      },
      db,
    );

    return Response.json(
      { member: { id: member?.id ?? membershipId, email: parsed.data.email, role: parsed.data.role } },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner"]);
    const parsed = removeMemberSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return Response.json({ error: "A valid membership is required." }, { status: 400 });
    }

    const db = getDb();
    const [target] = await db
      .select({
        id: memberships.id,
        email: memberships.userEmail,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, parsed.data.membershipId),
          eq(memberships.tenantId, context.tenantId),
        ),
      )
      .limit(1);
    if (!target) {
      return Response.json({ error: "Membership was not found." }, { status: 404 });
    }
    if (target.email === context.userEmail) {
      throw new ConflictError("Transfer ownership before removing your own membership.");
    }

    if (target.role === "owner" || target.role === "admin") {
      const otherOwners = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, context.tenantId),
            eq(memberships.status, "active"),
            inArray(memberships.role, ["owner", "admin"]),
          ),
        )
        .limit(2);
      if (otherOwners.length < 2) {
        throw new ConflictError("An organisation must retain at least one active owner.");
      }
    }

    const now = new Date();
    await db
      .update(memberships)
      .set({ status: "disabled", updatedAt: now })
      .where(
        and(
          eq(memberships.id, target.id),
          eq(memberships.tenantId, context.tenantId),
          eq(memberships.status, "active"),
        ),
      );
    await appendAuditEvent(
      {
        tenantId: context.tenantId,
        actorType: "user",
        actorId: context.userId,
        eventType: "member.removed",
        action: "disable_membership",
        targetType: "membership",
        targetId: target.id,
        result: "success",
        metadata: { priorRole: target.role },
      },
      db,
    );

    return Response.json({ membershipId: target.id, status: "disabled" });
  } catch (error) {
    return jsonError(error);
  }
}
