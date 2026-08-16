import { emailAnalysisSchema, EMAIL_ANALYSIS_JSON_SCHEMA, type EmailAnalysis } from "./schema";
import {
  buildEmailAnalysisUserPrompt,
  EMAIL_ANALYSIS_DEVELOPER_PROMPT,
  type EmailAnalysisInput,
} from "./prompt";

const RESPONSES_API_URL = "https://api.openai.com/v1/responses";

export type OpenAIAnalysisConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      apiKey: string;
      model: string;
    }>;

export type Environment = Readonly<Record<string, string | undefined>>;

export type OpenAIAnalysisRequest = Readonly<{
  model: string;
  store: false;
  input: readonly [
    Readonly<{
      role: "developer";
      content: readonly [Readonly<{ type: "input_text"; text: string }>];
    }>,
    Readonly<{
      role: "user";
      content: readonly [Readonly<{ type: "input_text"; text: string }>];
    }>,
  ];
  text: Readonly<{
    format: Readonly<{
      type: "json_schema";
      name: "clearinbox_email_analysis";
      strict: true;
      schema: Record<string, unknown>;
    }>;
  }>;
}>;

export type OpenAIAnalysisErrorCode =
  | "AI_ANALYSIS_DISABLED"
  | "AI_ANALYSIS_CONFIGURATION_INVALID"
  | "AI_ANALYSIS_PROVIDER_ERROR"
  | "AI_ANALYSIS_RESPONSE_INVALID"
  | "AI_ANALYSIS_REFUSED"
  | "AI_ANALYSIS_INCOMPLETE";

export class OpenAIAnalysisError extends Error {
  readonly code: OpenAIAnalysisErrorCode;

  constructor(code: OpenAIAnalysisErrorCode, message: string) {
    super(message);
    this.name = "OpenAIAnalysisError";
    this.code = code;
  }
}

export function loadOpenAIAnalysisConfig(env: Environment = process.env): OpenAIAnalysisConfig {
  if (env.AI_ANALYSIS_ENABLED?.trim().toLowerCase() !== "true") {
    return { enabled: false };
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();

  if (!apiKey || !model) {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_CONFIGURATION_INVALID",
      "AI analysis is enabled but its required server configuration is incomplete.",
    );
  }

  return { enabled: true, apiKey, model };
}

export function buildOpenAIAnalysisRequest(
  model: string,
  input: EmailAnalysisInput,
): OpenAIAnalysisRequest {
  if (!model.trim()) {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_CONFIGURATION_INVALID",
      "AI analysis requires a configured model.",
    );
  }

  return {
    model,
    store: false,
    input: [
      {
        role: "developer",
        content: [{ type: "input_text", text: EMAIL_ANALYSIS_DEVELOPER_PROMPT }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: buildEmailAnalysisUserPrompt(input) }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "clearinbox_email_analysis",
        strict: true,
        schema: EMAIL_ANALYSIS_JSON_SCHEMA,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the canonical raw Responses API output items instead of trusting an SDK
 * convenience field or an arbitrary top-level `output_text` property.
 */
export function extractResponseOutputText(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_RESPONSE_INVALID",
      "The AI provider returned an invalid response envelope.",
    );
  }

  if (payload.status === "incomplete") {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_INCOMPLETE",
      "The AI provider did not complete the analysis.",
    );
  }

  if (!Array.isArray(payload.output)) {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_RESPONSE_INVALID",
      "The AI provider response did not contain output items.",
    );
  }

  const textParts: string[] = [];
  let refused = false;

  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (!isRecord(content)) {
        continue;
      }

      if (content.type === "refusal") {
        refused = true;
      } else if (content.type === "output_text" && typeof content.text === "string") {
        textParts.push(content.text);
      }
    }
  }

  if (refused) {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_REFUSED",
      "The AI provider declined to produce this analysis.",
    );
  }

  if (textParts.length === 0) {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_RESPONSE_INVALID",
      "The AI provider response did not contain analysis text.",
    );
  }

  return textParts.join("");
}

export function parseEmailAnalysisResponse(payload: unknown): EmailAnalysis {
  const outputText = extractResponseOutputText(payload);
  let parsed: unknown;

  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_RESPONSE_INVALID",
      "The AI provider returned malformed structured output.",
    );
  }

  const result = emailAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    // Deliberately omit raw model output and validation values from errors/logs.
    throw new OpenAIAnalysisError(
      "AI_ANALYSIS_RESPONSE_INVALID",
      "The AI provider output failed application schema validation.",
    );
  }

  return result.data;
}

export type OpenAIAnalysisClient = Readonly<{
  enabled: boolean;
  analyzeEmailThread(input: EmailAnalysisInput): Promise<EmailAnalysis>;
}>;

export function createOpenAIAnalysisClient(
  config: OpenAIAnalysisConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): OpenAIAnalysisClient {
  return {
    enabled: config.enabled,
    async analyzeEmailThread(input: EmailAnalysisInput): Promise<EmailAnalysis> {
      if (!config.enabled) {
        throw new OpenAIAnalysisError(
          "AI_ANALYSIS_DISABLED",
          "AI analysis is disabled by server configuration.",
        );
      }

      const request = buildOpenAIAnalysisRequest(config.model, input);
      let response: Response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        response = await fetchImpl(RESPONSES_API_URL, {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch {
        throw new OpenAIAnalysisError(
          "AI_ANALYSIS_PROVIDER_ERROR",
          "The AI provider request failed.",
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        // Do not copy provider bodies into application errors: they can contain
        // excerpts of the email or other customer data.
        throw new OpenAIAnalysisError(
          "AI_ANALYSIS_PROVIDER_ERROR",
          `The AI provider request failed with HTTP status ${response.status}.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new OpenAIAnalysisError(
          "AI_ANALYSIS_RESPONSE_INVALID",
          "The AI provider returned an unreadable response.",
        );
      }

      return parseEmailAnalysisResponse(payload);
    },
  };
}
