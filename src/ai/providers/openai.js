import { postJson, usage, completion } from "../http.js";
import { AiError } from "../errors.js";

export default {
  id: "openai",
  name: "OpenAI",
  keyEnv: "OPENAI_API_KEY",
  jsonMode: "native_schema",
  async generate(context, request) {
    const body = {
      model: request.model.id,
      input: request.prompt,
      max_output_tokens: request.maxOutputTokens,
      store: false,
      ...(request.system ? { instructions: request.system } : {}),
      ...(request.kind === "json"
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "generation_result",
                strict: true,
                schema: request.schema,
              },
            },
          }
        : {}),
    };
    const result = await postJson(
      context,
      "https://api.openai.com/v1/responses",
      { authorization: `Bearer ${context.key}` },
      body,
    );
    if (!Array.isArray(result?.output))
      throw new AiError("AI_INVALID_RESPONSE");
    const content = result.output
      .filter((item) => item?.type === "message")
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
    if (content.some((item) => item?.type === "refusal"))
      throw new AiError("AI_REFUSED");
    if (result.status === "incomplete") throw new AiError("AI_INCOMPLETE");
    if (result.status !== "completed") throw new AiError("AI_PROVIDER_ERROR");
    if (
      result.output.some(
        (item) => !["message", "reasoning"].includes(item?.type),
      ) ||
      content.some(
        (item) => item?.type !== "output_text" || typeof item.text !== "string",
      )
    )
      throw new AiError("AI_INVALID_RESPONSE");
    return completion(
      content.map((item) => item.text).join(""),
      usage(
        result.usage?.input_tokens,
        result.usage?.output_tokens,
        result.usage?.total_tokens,
      ),
    );
  },
};
