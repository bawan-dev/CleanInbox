export {
  buildOpenAIAnalysisRequest,
  createOpenAIAnalysisClient,
  extractResponseOutputText,
  loadOpenAIAnalysisConfig,
  OpenAIAnalysisError,
  parseEmailAnalysisResponse,
  type Environment,
  type OpenAIAnalysisClient,
  type OpenAIAnalysisConfig,
  type OpenAIAnalysisErrorCode,
  type OpenAIAnalysisRequest,
} from "./client";
export {
  buildEmailAnalysisUserPrompt,
  EMAIL_ANALYSIS_DEVELOPER_PROMPT,
  EMAIL_ANALYSIS_PROMPT_VERSION,
  emailAnalysisInputSchema,
  type EmailAnalysisInput,
} from "./prompt";
export {
  EMAIL_ANALYSIS_JSON_SCHEMA,
  emailAnalysisSchema,
  type EmailAnalysis,
} from "./schema";

