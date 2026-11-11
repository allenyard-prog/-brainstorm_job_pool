import openai from "./providers/openai.js";
import gemini from "./providers/gemini.js";
import deepseek from "./providers/deepseek.js";
import claude from "./providers/claude.js";
import { AiError } from "./errors.js";

export const providers = Object.freeze([openai, gemini, deepseek, claude]);
export function createRegistry(catalog, keys = {}) {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    Array.isArray(catalog) ||
    Object.keys(catalog).some(
      (id) => !providers.some((provider) => provider.id === id),
    )
  )
    throw new Error("Invalid AI model catalog.");
  const entries = providers.map((plugin) => {
    if (
      !plugin.id ||
      typeof plugin.generate !== "function" ||
      !["native_schema", "json_mode"].includes(plugin.jsonMode)
    )
      throw new Error("Invalid AI provider plugin.");
    const models = catalog[plugin.id] ?? [];
    if (!Array.isArray(models)) throw new Error("Invalid AI model catalog.");
    const ids = new Set();
    const normalized = models.map((model) => {
      if (
        !model ||
        typeof model.id !== "string" ||
        !model.id.trim() ||
        model.id.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(model.id) ||
        ids.has(model.id) ||
        Object.keys(model).some(
          (key) => !["id", "capabilities"].includes(key),
        ) ||
        !model.capabilities ||
        typeof model.capabilities !== "object" ||
        Array.isArray(model.capabilities) ||
        Object.keys(model.capabilities).some(
          (key) => !["text", "json"].includes(key),
        ) ||
        model.capabilities.text !== true ||
        typeof model.capabilities.json !== "boolean"
      )
        throw new Error("Invalid AI model catalog.");
      ids.add(model.id);
      return {
        id: model.id,
        capabilities: {
          text: true,
          json: model.capabilities.json,
          jsonMode: model.capabilities.json ? plugin.jsonMode : null,
        },
      };
    });
    return {
      plugin,
      key: typeof keys[plugin.id] === "string" ? keys[plugin.id].trim() : "",
      models: normalized,
    };
  });
  return {
    list() {
      return entries.map(({ plugin, key, models }) => ({
        id: plugin.id,
        name: plugin.name,
        enabled: !!key && models.length > 0,
        disabledReason: !key
          ? "missing_api_key"
          : !models.length
            ? "no_models"
            : null,
        models: structuredClone(models),
      }));
    },
    resolve(target, kind) {
      const entry = entries.find(
        (value) => value.plugin.id === target.provider,
      );
      if (!entry) throw new AiError("AI_UNKNOWN_PROVIDER");
      const model = entry.models.find((value) => value.id === target.id);
      if (!model) throw new AiError("AI_MODEL_NOT_CONFIGURED");
      if (!model.capabilities[kind])
        throw new AiError("AI_UNSUPPORTED_CAPABILITY");
      if (!entry.key) throw new AiError("AI_PROVIDER_UNAVAILABLE");
      return { plugin: entry.plugin, key: entry.key };
    },
  };
}
