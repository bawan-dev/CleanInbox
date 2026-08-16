import { z } from "zod";
import { isValidAes256KeyMaterial } from "./crypto";

const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalTrimmedString = (minimumLength = 1) =>
  z.preprocess(
    emptyStringToUndefined,
    z.string().trim().min(minimumLength).optional(),
  );

const optionalUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().url().optional(),
);

const disabledByDefault = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .default(false)
  .transform((value) => value === true || value === "true");

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .optional()
      .default("development"),
    APP_BASE_URL: optionalUrl,
    AUTH_SECRET: optionalTrimmedString(32),
    APP_ENCRYPTION_KEY: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .trim()
        .refine(isValidAes256KeyMaterial, {
          message: "must be a base64-encoded 256-bit key",
        })
        .optional(),
    ),
    GMAIL_INTEGRATION_ENABLED: disabledByDefault,
    GMAIL_LABEL_MODIFICATION_ENABLED: disabledByDefault,
    GOOGLE_CLIENT_ID: optionalTrimmedString(),
    GOOGLE_CLIENT_SECRET: optionalTrimmedString(),
    GOOGLE_REDIRECT_URI: optionalUrl,
    AI_ANALYSIS_ENABLED: disabledByDefault,
    OPENAI_API_KEY: optionalTrimmedString(),
    OPENAI_MODEL: optionalTrimmedString(),
  })
  .superRefine((environment, context) => {
    const requireValue = (
      key:
        | "APP_ENCRYPTION_KEY"
        | "GOOGLE_CLIENT_ID"
        | "GOOGLE_CLIENT_SECRET"
        | "GOOGLE_REDIRECT_URI"
        | "OPENAI_API_KEY"
        | "OPENAI_MODEL",
      enabledFeature: string,
    ) => {
      if (!environment[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `is required when ${enabledFeature} is enabled`,
        });
      }
    };

    if (environment.GMAIL_INTEGRATION_ENABLED) {
      requireValue("APP_ENCRYPTION_KEY", "GMAIL_INTEGRATION_ENABLED");
      requireValue("GOOGLE_CLIENT_ID", "GMAIL_INTEGRATION_ENABLED");
      requireValue("GOOGLE_CLIENT_SECRET", "GMAIL_INTEGRATION_ENABLED");
      requireValue("GOOGLE_REDIRECT_URI", "GMAIL_INTEGRATION_ENABLED");
    }

    if (environment.GMAIL_LABEL_MODIFICATION_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["GMAIL_LABEL_MODIFICATION_ENABLED"],
        message: "must remain disabled for the draft-only MVP",
      });
    }

    if (environment.AI_ANALYSIS_ENABLED) {
      requireValue("OPENAI_API_KEY", "AI_ANALYSIS_ENABLED");
      requireValue("OPENAI_MODEL", "AI_ANALYSIS_ENABLED");
    }

    const validateHttpUrl = (
      key: "APP_BASE_URL" | "GOOGLE_REDIRECT_URI",
      value: string | undefined,
    ) => {
      if (!value) return;

      const url = new URL(value);
      const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";

      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must use HTTPS (HTTP is allowed only for localhost development)",
        });
      }

      if (environment.NODE_ENV === "production" && url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must use HTTPS in production",
        });
      }

      if (url.username || url.password || url.hash) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must not contain credentials or a URL fragment",
        });
      }
    };

    validateHttpUrl("APP_BASE_URL", environment.APP_BASE_URL);
    validateHttpUrl("GOOGLE_REDIRECT_URI", environment.GOOGLE_REDIRECT_URI);
  });

export type AppEnvironment = Readonly<z.output<typeof environmentSchema>>;

export class EnvironmentValidationError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(issues: z.core.$ZodIssue[]) {
    const safeIssues = issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    super(
      `Invalid environment configuration: ${safeIssues
        .map((issue) => `${issue.path || "environment"} ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "EnvironmentValidationError";
    this.issues = safeIssues;
  }
}

/**
 * Parses only documented settings. Unrelated platform variables are ignored, while
 * known values (especially booleans) are interpreted strictly.
 */
export function parseEnvironment(source: Record<string, unknown>): AppEnvironment {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }

  return Object.freeze(result.data);
}

export function loadEnvironment(): AppEnvironment {
  const source = typeof process === "undefined" ? {} : process.env;
  return parseEnvironment(source);
}
