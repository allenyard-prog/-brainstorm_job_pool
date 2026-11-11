const definitions = {
  AI_INVALID_REQUEST: [400, "Invalid AI generation request."],
  AI_INVALID_SCHEMA: [
    400,
    "The JSON schema is invalid or outside the supported portable subset.",
  ],
  AI_UNKNOWN_PROVIDER: [400, "The requested AI provider is not supported."],
  AI_MODEL_NOT_CONFIGURED: [400, "The requested model is not configured."],
  AI_UNSUPPORTED_CAPABILITY: [
    400,
    "The configured model does not support this output format.",
  ],
  AI_PROVIDER_UNAVAILABLE: [
    503,
    "The AI provider is not configured with an API key.",
  ],
  AI_PROVIDER_AUTH: [503, "The AI provider rejected its server credentials."],
  AI_RATE_LIMIT: [429, "The AI provider rate limit was reached."],
  AI_BUSY: [429, "AI generation capacity is busy. Try again later."],
  AI_TIMEOUT: [504, "AI generation exceeded its time limit."],
  AI_CANCELLED: [499, "AI generation was cancelled."],
  AI_SHUTTING_DOWN: [503, "The AI generation service is shutting down."],
  AI_REFUSED: [422, "The AI provider declined to generate this response."],
  AI_INCOMPLETE: [502, "The AI provider returned an incomplete response."],
  AI_INVALID_OUTPUT: [
    502,
    "The generated response did not match the requested JSON schema.",
  ],
  AI_INVALID_RESPONSE: [
    502,
    "The AI provider returned an unsupported response.",
  ],
  AI_RESPONSE_TOO_LARGE: [
    502,
    "The AI provider response exceeded the size limit.",
  ],
  AI_NETWORK_ERROR: [502, "The AI provider could not be reached."],
  AI_PROVIDER_ERROR: [502, "The AI provider could not complete the request."],
};

export class AiError extends Error {
  constructor(code = "AI_PROVIDER_ERROR") {
    const [status, message] =
      definitions[code] ?? definitions.AI_PROVIDER_ERROR;
    super(message);
    this.name = "AiError";
    this.code = Object.hasOwn(definitions, code) ? code : "AI_PROVIDER_ERROR";
    this.statusCode = status;
  }
}
export const aiError = (error) =>
  error instanceof AiError ? error : new AiError();
