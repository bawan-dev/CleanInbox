import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  gmailOAuthAttempts,
  mailboxCredentials,
  mailboxes,
} from "@/db/schema";
import { appendAuditEvent } from "@/lib/audit";
import { loadEnvironment } from "@/lib/security/env";
import {
  createGoogleConnectionService,
  googleConnectionConfigFromEnvironment,
  GoogleProviderAccountConflictError,
  GoogleTenantMailboxLimitError,
  type GoogleConnectionStore,
  type OAuthAttemptRecord,
  type SaveGoogleConnectionInput,
  type StoredGoogleConnection,
} from "./connection-service";

type Database = ReturnType<typeof getDb>;

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:unique|constraint|SQLITE_CONSTRAINT)/iu.test(
    `${error.name} ${error.message}`,
  );
}

function toStoredConnection(row: {
  mailboxId: string;
  tenantId: string;
  providerAccountId: string;
  address: string;
  status: "active" | "disconnected" | "error";
  credentialId: string | null;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
}): StoredGoogleConnection {
  return {
    mailbox: {
      id: row.mailboxId,
      tenantId: row.tenantId,
      providerAccountId: row.providerAccountId,
      address: row.address,
      status: row.status,
    },
    credential:
      row.credentialId && row.accessTokenEncrypted
        ? {
            id: row.credentialId,
            accessTokenEncrypted: row.accessTokenEncrypted,
            refreshTokenEncrypted: row.refreshTokenEncrypted,
          }
        : null,
  };
}

export function createDrizzleGoogleConnectionStore(
  db: Database = getDb(),
): GoogleConnectionStore {
  const selectConnection = () =>
    db
      .select({
        mailboxId: mailboxes.id,
        tenantId: mailboxes.tenantId,
        providerAccountId: mailboxes.providerAccountId,
        address: mailboxes.address,
        status: mailboxes.status,
        credentialId: mailboxCredentials.id,
        accessTokenEncrypted: mailboxCredentials.accessTokenEncrypted,
        refreshTokenEncrypted: mailboxCredentials.refreshTokenEncrypted,
      })
      .from(mailboxes)
      .leftJoin(
        mailboxCredentials,
        and(
          eq(mailboxCredentials.mailboxId, mailboxes.id),
          eq(mailboxCredentials.tenantId, mailboxes.tenantId),
        ),
      );

  return {
    async createOAuthAttempt(attempt: OAuthAttemptRecord) {
      await db.insert(gmailOAuthAttempts).values(attempt);
    },

    async consumeOAuthAttempt(input) {
      const [consumed] = await db
        .update(gmailOAuthAttempts)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(gmailOAuthAttempts.tenantId, input.tenantId),
            eq(gmailOAuthAttempts.actorEmail, input.actorEmail),
            eq(gmailOAuthAttempts.stateHash, input.stateHash),
            isNull(gmailOAuthAttempts.consumedAt),
            gt(gmailOAuthAttempts.expiresAt, input.now),
          ),
        )
        .returning();

      return consumed ?? null;
    },

    async findByProviderAccount(providerAccountId) {
      const [row] = await selectConnection()
        .where(
          and(
            eq(mailboxes.provider, "gmail"),
            eq(mailboxes.providerAccountId, providerAccountId),
          ),
        )
        .limit(1);
      return row ? toStoredConnection(row) : null;
    },

    async saveConnection(input: SaveGoogleConnectionInput) {
      const [current] = await selectConnection()
        .where(
          and(
            eq(mailboxes.provider, "gmail"),
            eq(mailboxes.providerAccountId, input.mailbox.providerAccountId),
          ),
        )
        .limit(1);

      if (
        current &&
        (current.tenantId !== input.mailbox.tenantId ||
          current.mailboxId !== input.mailbox.id ||
          (current.credentialId !== null && current.credentialId !== input.credential.id))
      ) {
        throw new GoogleProviderAccountConflictError();
      }

      const [activeTenantMailbox] = await selectConnection()
        .where(
          and(
            eq(mailboxes.tenantId, input.mailbox.tenantId),
            eq(mailboxes.provider, "gmail"),
            eq(mailboxes.status, "active"),
          ),
        )
        .limit(1);
      if (activeTenantMailbox && activeTenantMailbox.mailboxId !== input.mailbox.id) {
        throw new GoogleTenantMailboxLimitError();
      }

      const mailboxWrite = current
        ? db
            .update(mailboxes)
            .set({
              providerMailboxId: input.mailbox.providerAccountId,
              address: input.mailbox.address,
              status: "active" as const,
              credentialReference: input.credential.id,
              grantedScopesJson: input.mailbox.grantedScopesJson,
              tokenExpiresAt: input.mailbox.tokenExpiresAt,
              connectionErrorCode: null,
              disconnectedAt: null,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(mailboxes.id, input.mailbox.id),
                eq(mailboxes.tenantId, input.mailbox.tenantId),
                eq(mailboxes.providerAccountId, input.mailbox.providerAccountId),
              ),
            )
        : db.insert(mailboxes).values({
            id: input.mailbox.id,
            tenantId: input.mailbox.tenantId,
            provider: "gmail",
            providerMailboxId: input.mailbox.providerAccountId,
            providerAccountId: input.mailbox.providerAccountId,
            address: input.mailbox.address,
            status: "active",
            credentialReference: input.credential.id,
            grantedScopesJson: input.mailbox.grantedScopesJson,
            tokenExpiresAt: input.mailbox.tokenExpiresAt,
            createdAt: input.now,
            updatedAt: input.now,
          });

      const credentialWrite = current?.credentialId
        ? db
            .update(mailboxCredentials)
            .set({
              accessTokenEncrypted: input.credential.accessTokenEncrypted,
              refreshTokenEncrypted: input.credential.refreshTokenEncrypted,
              tokenExpiresAt: input.credential.tokenExpiresAt,
              encryptionKeyVersion: input.credential.encryptionKeyVersion,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(mailboxCredentials.id, input.credential.id),
                eq(mailboxCredentials.tenantId, input.mailbox.tenantId),
                eq(mailboxCredentials.mailboxId, input.mailbox.id),
              ),
            )
        : db.insert(mailboxCredentials).values({
            id: input.credential.id,
            tenantId: input.mailbox.tenantId,
            mailboxId: input.mailbox.id,
            accessTokenEncrypted: input.credential.accessTokenEncrypted,
            refreshTokenEncrypted: input.credential.refreshTokenEncrypted,
            tokenExpiresAt: input.credential.tokenExpiresAt,
            encryptionKeyVersion: input.credential.encryptionKeyVersion,
            createdAt: input.now,
            updatedAt: input.now,
          });

      try {
        await db.batch([mailboxWrite, credentialWrite]);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const [competingTenantMailbox] = await selectConnection()
            .where(
              and(
                eq(mailboxes.tenantId, input.mailbox.tenantId),
                eq(mailboxes.provider, "gmail"),
                eq(mailboxes.status, "active"),
              ),
            )
            .limit(1);
          if (
            competingTenantMailbox &&
            competingTenantMailbox.mailboxId !== input.mailbox.id
          ) {
            throw new GoogleTenantMailboxLimitError();
          }
          throw new GoogleProviderAccountConflictError();
        }
        throw error;
      }
    },

    async findDisconnectTarget(input) {
      const [row] = await selectConnection()
        .where(
          and(
            eq(mailboxes.id, input.mailboxId),
            eq(mailboxes.tenantId, input.tenantId),
            eq(mailboxes.provider, "gmail"),
          ),
        )
        .limit(1);
      return row ? toStoredConnection(row) : null;
    },

    async disconnectLocal(input) {
      await db.batch([
        db
          .delete(mailboxCredentials)
          .where(
            and(
              eq(mailboxCredentials.tenantId, input.tenantId),
              eq(mailboxCredentials.mailboxId, input.mailboxId),
            ),
          ),
        db
          .update(mailboxes)
          .set({
            status: "disconnected",
            tokenExpiresAt: null,
            connectionErrorCode: null,
            disconnectedAt: input.now,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(mailboxes.id, input.mailboxId),
              eq(mailboxes.tenantId, input.tenantId),
              eq(mailboxes.provider, "gmail"),
            ),
          ),
      ]);
    },
  };
}

export function createRequestGoogleConnectionRuntime() {
  const db = getDb();
  const config = googleConnectionConfigFromEnvironment(loadEnvironment());
  const store = createDrizzleGoogleConnectionStore(db);
  return {
    config,
    service: createGoogleConnectionService({
      config,
      store,
      audit: (input) => appendAuditEvent(input, db),
    }),
  };
}
