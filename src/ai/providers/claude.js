import { postJson, usage, completion } from "../http.js";
import { AiError } from "../errors.js";

export default {
  id: "claude",
  name: "Claude (Anthropic)",
  keyEnv: "ANTHROPIC_API_KEY",
  jsonMode: "native_schema",
  async generate(context, request) {
    const body = {
      model: request.model.id,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.maxOutputTokens,
      ...(request.system ? { system: request.system } : {}),
      ...(request.kind === "json"
        ? {
            output_config: {
              format: { type: "json_schema", schema: request.schema },
            },
          }
        : {}),
    };
    const result = await postJson(
      context,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": context.key, "anthropic-version": "2023-06-01" },
      body,
    );
    if (result?.stop_reason === "refusal") throw new AiError("AI_REFUSED");
    if (
      ["max_tokens", "model_context_window_exceeded", "pause_turn"].includes(
        result?.stop_reason,
      )
    )
      throw new AiError("AI_INCOMPLETE");
    if (
      !["end_turn", "stop_sequence"].includes(result?.stop_reason) ||
      !Array.isArray(result.content)
    )
      throw new AiError("AI_INVALID_RESPONSE");
    if (
      result.content.some(
        (block) =>
          !["text", "thinking", "redacted_thinking"].includes(block?.type) ||
          (block.type === "text" && typeof block.text !== "string"),
      )
    )
      throw new AiError("AI_INVALID_RESPONSE");
    return completion(
      result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      usage(result.usage?.input_tokens, result.usage?.output_tokens),
    );
  },
};
