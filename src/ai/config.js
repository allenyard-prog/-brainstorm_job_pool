import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providers } from "./provider-registry.js";

export function aiConfig(env = process.env) {
  const timeoutMs = Number(env.AI_TIMEOUT_MS ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new Error("AI_TIMEOUT_MS must be between 1 and 600000.");
  return {
    timeoutMs,
    keys: Object.fromEntries(
      providers.map((provider) => [provider.id, env[provider.keyEnv] ?? ""]),
    ),
    catalogPath: env.AI_MODELS_CONFIG
      ? resolve(env.AI_MODELS_CONFIG)
      : fileURLToPath(new URL("../../config/ai-models.json", import.meta.url)),
  };
}
export async function readCatalog(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("AI model catalog is unavailable or invalid.");
  }
}
