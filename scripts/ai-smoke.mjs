import { parseArgs } from "node:util";
import { createAiService } from "../src/ai/index.js";
import { aiError } from "../src/ai/errors.js";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
if (!values.provider || !values.model) {
  process.stderr.write(
    "Usage: npm run ai:smoke -- --provider PROVIDER --model MODEL_ID [--json]\n",
  );
  process.exitCode = 1;
} else {
  let ai;
  try {
    ai = await createAiService();
    const request = {
      model: { provider: values.provider, id: values.model },
      prompt: values.json
        ? "Return a JSON object with ok set to true."
        : "Reply with OK.",
      maxOutputTokens: 256,
    };
    const result = values.json
      ? await ai.generateJson({
          ...request,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        })
      : await ai.generateText(request);
    // Live smoke output remains metadata-only, like ordinary service diagnostics.
    console.log(
      JSON.stringify({
        requestId: result.requestId,
        model: result.model,
        success: true,
        usage: result.usage,
        durationMs: result.durationMs,
      }),
    );
  } catch (error) {
    const safe = aiError(error);
    console.error(JSON.stringify({ code: safe.code, message: safe.message }));
    process.exitCode = 1;
  } finally {
    await ai?.close();
  }
}
