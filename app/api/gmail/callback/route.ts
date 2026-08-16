import {
  appendGoogleOutcome,
  GoogleConnectionError,
  googleConnectionErrorResponse,
} from "@/lib/google/connection-service";
import { createRequestGoogleConnectionRuntime } from "@/lib/google/connection-store";
import { jsonError, resolveTenantContext } from "@/lib/tenant-context";

function redirectToOutcome(
  request: Request,
  appBaseUrl: string | undefined,
  returnPath: string,
  outcome: "connected" | "error",
  reason?: string,
) {
  const location = new URL(
    appendGoogleOutcome(returnPath, outcome, reason),
    appBaseUrl ?? request.url,
  );
  return new Response(null, {
    status: 303,
    headers: {
      location: location.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function GET(request: Request) {
  let runtime: ReturnType<typeof createRequestGoogleConnectionRuntime> | undefined;
  try {
    const context = await resolveTenantContext(request.headers);
    runtime = createRequestGoogleConnectionRuntime();
    const search = new URL(request.url).searchParams;
    const result = await runtime.service.complete(context, {
      state: search.get("state"),
      code: search.get("code"),
      providerError: search.get("error"),
    });

    if (result.outcome === "provider_error") {
      return redirectToOutcome(
        request,
        runtime.config.appBaseUrl,
        result.returnPath,
        "error",
        result.reason,
      );
    }
    return redirectToOutcome(
      request,
      runtime.config.appBaseUrl,
      result.returnPath,
      "connected",
    );
  } catch (error) {
    if (error instanceof GoogleConnectionError) {
      if (error.returnPath) {
        return redirectToOutcome(
          request,
          runtime?.config.appBaseUrl,
          error.returnPath,
          "error",
          error.code,
        );
      }
      return googleConnectionErrorResponse(error);
    }
    return jsonError(error);
  }
}
