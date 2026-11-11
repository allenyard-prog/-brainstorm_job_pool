import { postJson, usage, completion } from "../http.js";
import { AiError } from "../errors.js";

export default {
  id: "deepseek",
  name: "DeepSeek",
  keyEnv: "DEEPSEEK_API_KEY",
  jsonMode: "json_mode",
  async generate(context, request) {
    const instruction =
      request.kind === "json"
        ? `Return only a JSON object that matches this JSON schema:\n${JSON.stringify(request.schema)}`
        : "";
    const system = [request.system, instruction].filter(Boolean).join("\n\n");
    const body = {
      model: request.model.id,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: request.prompt },
      ],
      max_tokens: request.maxOutputTokens,
      stream: false,
      ...(request.kind === "json"
        ? { response_format: { type: "json_object" } }
        : {}),
    };
    const result = await postJson(
      context,
      "https://api.deepseek.com/chat/completions",
      { authorization: `Bearer ${context.key}` },
      body,
    );
    const choice = result?.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter")
      throw new AiError("AI_REFUSED");
    if (choice?.finish_reason === "length") throw new AiError("AI_INCOMPLETE");
    if (choice?.finish_reason !== "stop" || choice.message?.tool_calls?.length)
      throw new AiError("AI_INVALID_RESPONSE");
    return completion(
      choice.message?.content,
      usage(
        result.usage?.prompt_tokens,
        result.usage?.completion_tokens,
        result.usage?.total_tokens,
      ),
    );
  },
};
