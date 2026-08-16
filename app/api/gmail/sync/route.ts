import { loadEnvironment } from "@/lib/security/env";
import { executeD1ManualGmailSync, ManualGmailSyncError } from "@/lib/sync";
import {
  assertTrustedJsonMutation,
  GoogleConnectionError,
  googleConnectionErrorResponse,
} from "@/lib/google/connection-service";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner", "reviewer"]);
    const environment = loadEnvironment();
    assertTrustedJsonMutation(request, environment.APP_BASE_URL);

    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return noStoreJson(
        { error: "A valid Idempotency-Key header is required." },
        400,
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return noStoreJson({ error: "A JSON request body is required." }, 400);
    }
    const mailboxId = typeof payload === "object" && payload !== null
      && "mailboxId" in payload && typeof payload.mailboxId === "string"
      ? payload.mailboxId.trim()
      : "";
    if (!RESOURCE_ID_PATTERN.test(mailboxId)) {
      return noStoreJson({ error: "A valid mailboxId is required." }, 400);
    }

    const result = await executeD1ManualGmailSync({
      environment,
      tenantId: context.tenantId,
      mailboxId,
      actorId: context.userId,
      idempotencyKey,
      signal: request.signal,
    });
    const status = result.status === "running" || result.status === "pending"
      ? 202
      : result.status === "failed"
        ? 409
        : 200;
    return noStoreJson({ sync: result }, status);
  } catch (error) {
    if (error instanceof GoogleConnectionError) {
      return googleConnectionErrorResponse(error);
    }
    if (error instanceof ManualGmailSyncError) {
      return noStoreJson(
        {
          error: "The Gmail synchronization could not be completed safely.",
          code: error.code,
          retryable: error.retryable,
        },
        error.status,
      );
    }
    return jsonError(error);
  }
}
