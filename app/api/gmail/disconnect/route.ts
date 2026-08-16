import { z } from "zod";
import {
  assertTrustedJsonMutation,
  GoogleConnectionError,
  googleConnectionErrorResponse,
} from "@/lib/google/connection-service";
import { createRequestGoogleConnectionRuntime } from "@/lib/google/connection-store";
import { jsonError, resolveTenantContext } from "@/lib/tenant-context";

const requestSchema = z.object({
  mailboxId: z.uuid(),
});

export async function POST(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    const runtime = createRequestGoogleConnectionRuntime();
    assertTrustedJsonMutation(request, runtime.config.appBaseUrl);
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "A valid Gmail mailbox is required." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }

    const result = await runtime.service.disconnect(context, parsed.data);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GoogleConnectionError) {
      return googleConnectionErrorResponse(error);
    }
    return jsonError(error);
  }
}
