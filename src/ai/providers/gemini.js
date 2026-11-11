import { postJson, usage, completion } from "../http.js";
import { AiError } from "../errors.js";

export default {
  id: "gemini",
  name: "Gemini",
  keyEnv: "GEMINI_API_KEY",
  jsonMode: "native_schema",
  async generate(context, request) {
    const body = {
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      ...(request.system
        ? { systemInstruction: { parts: [{ text: request.system }] } }
        : {}),
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        ...(request.kind === "json"
          ? {
              responseFormat: {
                text: { mimeType: "APPLICATION_JSON", schema: request.schema },
              },
            }
          : {}),
      },
    };
    const result = await postJson(
      context,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model.id)}:generateContent`,
      { "x-goog-api-key": context.key },
      body,
    );
    if (result?.promptFeedback?.blockReason) throw new AiError("AI_REFUSED");
    const candidate = result?.candidates?.[0];
    if (
      [
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
      ].includes(candidate?.finishReason)
    )
      throw new AiError("AI_REFUSED");
    if (candidate?.finishReason === "MAX_TOKENS")
      throw new AiError("AI_INCOMPLETE");
    if (
      candidate?.finishReason !== "STOP" ||
      !Array.isArray(candidate.content?.parts)
    )
      throw new AiError("AI_INVALID_RESPONSE");
    const parts = candidate.content.parts.filter(
      (part) => part?.thought !== true,
    );
    if (parts.some((part) => typeof part?.text !== "string"))
      throw new AiError("AI_INVALID_RESPONSE");
    return completion(
      parts.map((part) => part.text).join(""),
      usage(
        result.usageMetadata?.promptTokenCount,
        result.usageMetadata?.candidatesTokenCount,
        result.usageMetadata?.totalTokenCount,
      ),
    );
  },
};
