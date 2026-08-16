import { EnvironmentValidationError, loadEnvironment } from "@/lib/security/env";

export async function GET() {
  try {
    const environment = loadEnvironment();
    return Response.json({
      service: "clearinbox",
      status: "ok",
      mode: "gmail-draft-only",
      integrations: {
        gmailConfigured: environment.GMAIL_INTEGRATION_ENABLED,
        aiAnalysisConfigured: environment.AI_ANALYSIS_ENABLED,
      },
      prohibitedCapabilities: {
        send: false,
        forward: false,
        delete: false,
        archive: false,
        labelModification: false,
      },
    });
  } catch (error) {
    if (error instanceof EnvironmentValidationError) {
      return Response.json(
        { service: "clearinbox", status: "misconfigured" },
        { status: 503 },
      );
    }
    return Response.json({ service: "clearinbox", status: "unavailable" }, { status: 503 });
  }
}
