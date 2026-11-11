import Ajv from "ajv";
import { providers } from "../ai/provider-registry.js";
import { INPUT_BYTES } from "../ai/validation.js";
import { aiError } from "../ai/errors.js";
import { error } from "./schemas.js";

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const target = object({
  provider: { type: "string", enum: providers.map((provider) => provider.id) },
  id: { type: "string", minLength: 1, maxLength: 200 },
});
const nullableNumber = {
  anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
};
const requestSchema = object(
  {
    model: target,
    prompt: { type: "string", minLength: 1 },
    system: { type: "string" },
    maxOutputTokens: { type: "integer", minimum: 1, maximum: 8192 },
    output: {
      anyOf: [
        object({ type: { const: "text" } }),
        object({ type: { const: "json" }, schema: { type: "object" } }),
      ],
    },
  },
  ["model", "prompt", "output"],
);
const resultSchema = object({
  requestId: { type: "string" },
  model: target,
  text: { type: "string" },
  data: {},
  usage: object({
    inputTokens: nullableNumber,
    outputTokens: nullableNumber,
    totalTokens: nullableNumber,
  }),
  finishReason: { type: "string" },
  durationMs: { type: "integer", minimum: 0 },
});
const discovery = {
  type: "array",
  items: object({
    id: { type: "string" },
    name: { type: "string" },
    enabled: { type: "boolean" },
    disabledReason: { anyOf: [{ type: "string" }, { type: "null" }] },
    models: {
      type: "array",
      items: object({
        id: { type: "string" },
        capabilities: object({
          text: { type: "boolean" },
          json: { type: "boolean" },
          jsonMode: { anyOf: [{ type: "string" }, { type: "null" }] },
        }),
      }),
    },
  }),
};
const errors = Object.fromEntries(
  [400, 401, 403, 413, 422, 429, 499, 500, 502, 503, 504].map((status) => [
    status,
    error,
  ]),
);

export function registerAiRoutes(app, ai) {
  const validator = new Ajv({
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    allErrors: false,
  });
  app.route({
    method: "GET",
    url: "/api/v1/ai/models",
    config: { admin: true },
    schema: {
      security: [{ session: [] }],
      response: { 200: discovery, ...errors },
    },
    handler: () => ai.listModels(),
  });
  app.route({
    method: "POST",
    url: "/api/v1/ai/generate",
    config: { admin: true },
    bodyLimit: INPUT_BYTES,
    validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: {
      security: [{ session: [] }],
      body: requestSchema,
      response: { 200: resultSchema, ...errors },
    },
    async handler(request, reply) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const disconnected = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", disconnected);
      try {
        if (request.raw.aborted || reply.raw.destroyed) abort();
        const { output, ...input } = request.body;
        const method = output.type === "json" ? "generateJson" : "generateText";
        const result = await ai[method](
          {
            ...input,
            ...(output.type === "json" ? { schema: output.schema } : {}),
            signal: controller.signal,
          },
          { actorId: request.user.id },
        );
        if (!reply.raw.destroyed) return reply.send(result);
      } catch (error) {
        const safe = aiError(error);
        // Controlled errors retain their safe AI messages, including 429/5xx.
        if (!reply.raw.destroyed)
          return reply
            .code(safe.statusCode)
            .send({ error: { code: safe.code, message: safe.message } });
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", disconnected);
      }
    },
  });
}
