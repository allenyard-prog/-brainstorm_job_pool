import { randomUUID } from "node:crypto";
import { aiConfig, readCatalog } from "./config.js";
import { createRegistry } from "./provider-registry.js";
import { validateRequest, compileOutputSchema } from "./validation.js";
import { AiError, aiError } from "./errors.js";

export async function createAiService(options = aiConfig()) {
  const registry = createRegistry(
    options.catalog ?? (await readCatalog(options.catalogPath)),
    options.keys,
  );
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new Error("Invalid AI timeout.");
  const fetchImpl = options.fetch ?? globalThis.fetch,
    active = new Map(),
    actors = new Set(),
    capacityWaiters = new Set();
  let closed = false;
  const secrets = Object.values(options.keys ?? {}).filter(
    (value) => typeof value === "string" && value,
  );
  function log(metadata) {
    // Construct only allowlisted metadata; never pass request/response/error objects.
    let line = JSON.stringify(metadata);
    for (const secret of secrets) line = line.replaceAll(secret, "[REDACTED]");
    try {
      if (options.log) options.log(JSON.parse(line));
      else process.stderr.write(line + "\n");
    } catch {
      /* Diagnostics cannot fail a generation. */
    }
  }
  async function generate(input, kind, { actorId = "internal" } = {}) {
    const requestId = randomUUID(),
      started = Date.now();
    let timer,
      controller,
      aborted,
      finish,
      callerSignal,
      acquired = false,
      model,
      tokenUsage;
    try {
      if (closed) throw new AiError("AI_SHUTTING_DOWN");
      const request = validateRequest(input, kind);
      callerSignal = request.signal;
      if (kind === "json") {
        try {
          request.schema = structuredClone(request.schema);
        } catch {
          throw new AiError("AI_INVALID_SCHEMA");
        }
      }
      if (typeof actorId !== "string" || !actorId)
        throw new AiError("AI_INVALID_REQUEST");
      const validate =
        kind === "json" ? compileOutputSchema(request.schema) : null;
      const resolved = registry.resolve(request.model, kind);
      model = request.model;
      if (request.signal?.aborted) throw new AiError("AI_CANCELLED");
      if (active.size >= 2 || actors.has(actorId)) throw new AiError("AI_BUSY");
      controller = new AbortController();
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      active.set(requestId, { controller, done });
      actors.add(actorId);
      acquired = true;
      const cancelled = new Promise((resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      });
      aborted = () => controller.abort(new AiError("AI_CANCELLED"));
      request.signal?.addEventListener("abort", aborted, { once: true });
      if (request.signal?.aborted) aborted();
      timer = setTimeout(
        () => controller.abort(new AiError("AI_TIMEOUT")),
        timeoutMs,
      );
      const result = await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return resolved.plugin.generate(
            { key: resolved.key, fetch: fetchImpl, signal: controller.signal },
            request,
          );
        }),
        cancelled,
      ]);
      controller.signal.throwIfAborted();
      tokenUsage = result.usage;
      let data = null;
      if (validate) {
        try {
          data = JSON.parse(result.text);
        } catch {
          throw new AiError("AI_INVALID_OUTPUT");
        }
        if (!validate(data)) throw new AiError("AI_INVALID_OUTPUT");
      }
      const durationMs = Date.now() - started;
      log({
        event: "ai_generation",
        requestId,
        model,
        status: "completed",
        usage: tokenUsage,
        durationMs,
      });
      return {
        requestId,
        model,
        text: result.text,
        data,
        usage: tokenUsage,
        finishReason: result.finishReason,
        durationMs,
      };
    } catch (error) {
      const safe = aiError(error);
      log({
        event: "ai_generation",
        requestId,
        ...(model ? { model } : {}),
        status: "failed",
        code: safe.code,
        ...(tokenUsage ? { usage: tokenUsage } : {}),
        durationMs: Date.now() - started,
      });
      throw safe;
    } finally {
      clearTimeout(timer);
      if (aborted) callerSignal?.removeEventListener("abort", aborted);
      if (acquired) {
        active.delete(requestId);
        actors.delete(actorId);
        finish();
        for (const check of [...capacityWaiters]) check();
      }
    }
  }
  return {
    listModels: () => registry.list(),
    validateModel: (model, kind = 'json') => { registry.resolve(model, kind); },
    waitForCapacity({ actorId, signal }) {
      return new Promise((resolve, reject) => {
        const cleanup = () => { capacityWaiters.delete(check); signal?.removeEventListener('abort', check); };
        const check = () => {
          if (closed || signal?.aborted) { cleanup(); reject(new AiError(closed ? 'AI_SHUTTING_DOWN' : 'AI_CANCELLED')); }
          else if (active.size < 2 && !actors.has(actorId)) { cleanup(); resolve(); }
        };
        capacityWaiters.add(check);
        signal?.addEventListener('abort', check, { once: true });
        check();
      });
    },
    generateText: (request, context) => generate(request, "text", context),
    generateJson: (request, context) => generate(request, "json", context),
    async close() {
      closed = true;
      for (const check of [...capacityWaiters]) check();
      const pending = [...active.values()];
      for (const entry of pending)
        entry.controller.abort(new AiError("AI_SHUTTING_DOWN"));
      await Promise.allSettled(pending.map((entry) => entry.done));
    },
  };
}
