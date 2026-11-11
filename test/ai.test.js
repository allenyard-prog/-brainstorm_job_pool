import test from "node:test";
import assert from "node:assert/strict";
import { createAiService } from "../src/ai/index.js";
import { aiConfig, readCatalog } from "../src/ai/config.js";
import { AiError } from "../src/ai/errors.js";
import {
  aiFixture,
  providerIds,
  catalog,
  schema,
} from "./helpers/ai-fixture.js";

const request = (provider) => ({
  model: { provider, id: `${provider}-fixture` },
  prompt: "private-prompt",
  system: "system instruction",
});
const code = (value) => (error) =>
  error instanceof AiError && error.code === value;

test("all provider plugins route explicit models and normalize text/JSON, usage and hidden reasoning", async () => {
  const f = await aiFixture(),
    ai = await createAiService(f.options);
  try {
    for (const provider of providerIds) {
      const text = await ai.generateText(request(provider));
      assert.equal(text.text, "fixture-answer");
      assert.equal(text.data, null);
      assert.deepEqual(text.model, request(provider).model);
      assert.equal(text.usage.inputTokens, 11);
      assert.equal(text.usage.outputTokens, 7);
      assert.equal(
        text.usage.totalTokens,
        provider === "claude" ? null : provider === "gemini" ? 20 : 18,
      );
      const json = await ai.generateJson({
        ...request(provider),
        schema,
        maxOutputTokens: 123,
      });
      assert.deepEqual(json.data, { answer: "fixture" });
      assert.equal(json.finishReason, "stop");
      assert.ok(!JSON.stringify(json).includes("hidden-reasoning"));
      const wire = f.requests.at(-1);
      assert.equal(wire.method, "POST");
      if (provider === "openai") {
        assert.equal(wire.path, "/v1/responses");
        assert.equal(wire.body.model, "openai-fixture");
        assert.equal(wire.body.store, false);
        assert.equal(wire.body.text.format.strict, true);
        assert.deepEqual(wire.body.text.format.schema, schema);
        assert.equal(wire.body.max_output_tokens, 123);
        assert.equal(wire.headers.authorization, `Bearer ${f.keys.openai}`);
      }
      if (provider === "gemini") {
        assert.equal(
          wire.path,
          "/v1beta/models/gemini-fixture:generateContent",
        );
        assert.equal(wire.headers["x-goog-api-key"], f.keys.gemini);
        assert.equal(wire.body.generationConfig.maxOutputTokens, 123);
        assert.deepEqual(
          wire.body.generationConfig.responseFormat.text.schema,
          schema,
        );
        assert.equal(
          wire.body.generationConfig.responseFormat.text.mimeType,
          "APPLICATION_JSON",
        );
      }
      if (provider === "deepseek") {
        assert.equal(wire.path, "/chat/completions");
        assert.equal(wire.body.model, "deepseek-fixture");
        assert.equal(wire.body.response_format.type, "json_object");
        assert.ok(
          wire.body.messages[0].content.includes(JSON.stringify(schema)),
        );
        assert.equal(wire.body.max_tokens, 123);
        assert.equal(wire.headers.authorization, `Bearer ${f.keys.deepseek}`);
      }
      if (provider === "claude") {
        assert.equal(wire.path, "/v1/messages");
        assert.equal(wire.body.model, "claude-fixture");
        assert.equal(wire.body.max_tokens, 123);
        assert.deepEqual(wire.body.output_config.format.schema, schema);
        assert.equal(wire.headers["x-api-key"], f.keys.claude);
        assert.equal(wire.headers["anthropic-version"], "2023-06-01");
      }
      f.mode(provider, "no-usage");
      assert.deepEqual((await ai.generateText(request(provider))).usage, {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      });
    }
    const logs = JSON.stringify(f.logs);
    for (const secret of [
      "private-prompt",
      "fixture-answer",
      "hidden-reasoning",
      ...Object.values(f.keys),
    ])
      assert.ok(!logs.includes(secret));
    assert.equal(f.logs.length, 12);
    assert.equal(f.logs[0].usage.inputTokens, 11);
    const models = ai.listModels();
    assert.equal(
      models.find((provider) => provider.id === "deepseek").models[0]
        .capabilities.jsonMode,
      "json_mode",
    );
    assert.equal(
      models.find((provider) => provider.id === "openai").models[0].capabilities
        .jsonMode,
      "native_schema",
    );
    assert.ok(!JSON.stringify(models).includes("secret"));
  } finally {
    await ai.close();
    await f.close();
  }
});

test("all providers fail clearly on refusal, truncation, invalid schema output and changed response contracts without retries", async () => {
  const f = await aiFixture(),
    ai = await createAiService(f.options);
  try {
    for (const provider of providerIds)
      for (const [mode, expected] of [
        ["refused", "AI_REFUSED"],
        ["incomplete", "AI_INCOMPLETE"],
        ["invalid-json", "AI_INVALID_OUTPUT"],
        ["schema-mismatch", "AI_INVALID_OUTPUT"],
        ["extra-field", "AI_INVALID_OUTPUT"],
        ["malformed", "AI_INVALID_RESPONSE"],
        ["non-json", "AI_INVALID_RESPONSE"],
        ["changed", "AI_INVALID_RESPONSE"],
        ["http-401", "AI_PROVIDER_AUTH"],
        ["http-403", "AI_PROVIDER_AUTH"],
        ["http-429", "AI_RATE_LIMIT"],
        ["http-500", "AI_PROVIDER_ERROR"],
      ]) {
        f.mode(provider, mode);
        const before = f.requests.length;
        await assert.rejects(
          ai.generateJson({ ...request(provider), schema }),
          code(expected),
        );
        assert.equal(f.requests.length, before + 1);
      }
    const logs = JSON.stringify(f.logs);
    for (const value of [
      "private-prompt",
      "private-result",
      "private-refusal",
      ...Object.values(f.keys),
    ])
      assert.ok(!logs.includes(value));
  } finally {
    await ai.close();
    await f.close();
  }
});

test("validation rejects unsafe/unsupported schemas, missing targets, invalid parameters and oversized input before dispatch", async () => {
  const f = await aiFixture(),
    ai = await createAiService(f.options);
  try {
    for (const input of [
      {},
      { prompt: "test" },
      { ...request("openai"), model: { provider: "openai" } },
      { ...request("openai"), prompt: "" },
      { ...request("openai"), prompt: false },
      { ...request("openai"), signal: {} },
      { ...request("openai"), baseUrl: "http://evil.test" },
      { ...request("openai"), maxOutputTokens: 8193 },
      { ...request("openai"), maxOutputTokens: 0 },
      { ...request("openai"), prompt: "x".repeat(256 * 1024) },
    ])
      await assert.rejects(ai.generateText(input), code("AI_INVALID_REQUEST"));
    await assert.rejects(
      ai.generateText({
        ...request("openai"),
        model: { provider: "../../anything", id: "id" },
      }),
      code("AI_UNKNOWN_PROVIDER"),
    );
    await assert.rejects(
      ai.generateText({
        ...request("openai"),
        model: { provider: "openai", id: "unconfigured" },
      }),
      code("AI_MODEL_NOT_CONFIGURED"),
    );
    const discovery = ai.listModels();
    discovery[0].models[1].capabilities.json = true;
    await assert.rejects(
      ai.generateJson({
        ...request("openai"),
        model: { provider: "openai", id: "openai-text-only" },
        schema,
      }),
      code("AI_UNSUPPORTED_CAPABILITY"),
    );
    for (const invalid of [
      undefined,
      {},
      { type: "array", items: { type: "string" } },
      { $ref: "https://untrusted.test/schema" },
      { ...schema, additionalProperties: true },
      { ...schema, required: [] },
      { ...schema, properties: { answer: { type: "string", pattern: ".*" } } },
    ])
      await assert.rejects(
        ai.generateJson({ ...request("openai"), schema: invalid }),
        code("AI_INVALID_SCHEMA"),
      );
    assert.equal(f.requests.length, 0);
  } finally {
    await ai.close();
    await f.close();
  }
});

test("timeouts, caller cancellation, concurrency and shutdown release slots including stalled bodies", async () => {
  const f = await aiFixture(),
    ai = await createAiService({ ...f.options, timeoutMs: 150 });
  try {
    for (const mode of ["held", "held-body"]) {
      f.mode("openai", mode);
      await assert.rejects(
        ai.generateText(request("openai")),
        code("AI_TIMEOUT"),
      );
      f.mode("openai", "success");
      assert.equal(
        (await ai.generateText(request("openai"))).text,
        "fixture-answer",
      );
    }
    f.mode("openai", "held");
    const controller = new AbortController(),
      before = f.requests.length;
    const pending = ai.generateText(
      { ...request("openai"), signal: controller.signal },
      { actorId: "admin-a" },
    );
    const stopped = assert.rejects(pending, code("AI_CANCELLED"));
    await f.waitFor(before + 1);
    await assert.rejects(
      ai.generateText(request("gemini"), { actorId: "admin-a" }),
      code("AI_BUSY"),
    );
    f.mode("gemini", "held");
    const second = ai.generateText(request("gemini"), { actorId: "admin-b" });
    const shutdown = assert.rejects(second, code("AI_SHUTTING_DOWN"));
    await f.waitFor(before + 2);
    await assert.rejects(
      ai.generateText(request("claude"), { actorId: "admin-c" }),
      code("AI_BUSY"),
    );
    controller.abort(new Error("private-cancellation-reason"));
    await stopped;
    assert.equal(
      (await ai.generateText(request("claude"), { actorId: "admin-a" })).text,
      "fixture-answer",
    );
    await ai.close();
    await shutdown;
    await assert.rejects(
      ai.generateText(request("claude")),
      code("AI_SHUTTING_DOWN"),
    );
    assert.ok(!JSON.stringify(f.logs).includes("private-cancellation-reason"));
  } finally {
    await ai.close();
    await f.close();
  }
});

test("oversized provider bodies are bounded with and without Content-Length, and recovery works", async () => {
  const f = await aiFixture(),
    ai = await createAiService(f.options);
  try {
    for (const mode of ["huge", "huge-chunked"]) {
      f.mode("openai", mode);
      await assert.rejects(
        ai.generateText(request("openai")),
        code("AI_RESPONSE_TOO_LARGE"),
      );
    }
    f.mode("openai", "success");
    assert.equal(
      (await ai.generateText(request("openai"))).text,
      "fixture-answer",
    );
  } finally {
    await ai.close();
    await f.close();
  }
});

test("providers without keys remain discoverable and catalogs/timeout configuration are explicit", async () => {
  const ai = await createAiService({ catalog, keys: {}, log: () => {} });
  try {
    assert.ok(
      ai
        .listModels()
        .every(
          (provider) =>
            !provider.enabled && provider.disabledReason === "missing_api_key",
        ),
    );
    await assert.rejects(
      ai.generateText(request("openai")),
      code("AI_PROVIDER_UNAVAILABLE"),
    );
    assert.equal(aiConfig({}).timeoutMs, 120000);
    assert.throws(() => aiConfig({ AI_TIMEOUT_MS: "0" }), /AI_TIMEOUT_MS/);
    await assert.rejects(
      readCatalog("missing-ai-fixture-file.json"),
      /unavailable/,
    );
    for (const bad of [
      { unsupported: [] },
      { openai: [{ id: "model" }] },
      {
        openai: [
          { id: "model", capabilities: { text: true, json: true } },
          { id: "model", capabilities: { text: true, json: true } },
        ],
      },
    ])
      await assert.rejects(
        createAiService({ catalog: bad, keys: {} }),
        /Invalid AI model catalog/,
      );
  } finally {
    await ai.close();
  }
});

test("portable schemas support nested closed objects, nullable values, arrays and enums without mutation or coercion", async () => {
  const f = await aiFixture();
  const structured = {
    type: "object",
    properties: {
      roles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: ["string", "null"] },
            active: { type: "boolean" },
            level: { type: "string", enum: ["senior", "junior"] },
          },
          required: ["title", "active", "level"],
          additionalProperties: false,
        },
      },
    },
    required: ["roles"],
    additionalProperties: false,
  };
  let output = '{"roles":[{"title":null,"active":true,"level":"senior"}]}';
  const ai = await createAiService({
    ...f.options,
    fetch: async (url, options) => {
      const response = await f.options.fetch(url, options);
      const native = await response.json();
      native.output[1].content[0].text = output;
      return new Response(JSON.stringify(native), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const argument = {
      ...request("openai"),
      schema: structuredClone(structured),
    };
    const pending = ai.generateJson(argument);
    argument.schema.properties.roles.items.properties.title.type = "boolean";
    const result = await pending;
    assert.deepEqual(result.data, {
      roles: [{ title: null, active: true, level: "senior" }],
    });
    output = '{"roles":[{"title":null,"active":"true","level":"senior"}]}';
    await assert.rejects(
      ai.generateJson({ ...request("openai"), schema: structured }),
      code("AI_INVALID_OUTPUT"),
    );
    output = '{"roles":[{"title":null,"level":"senior"}]}';
    await assert.rejects(
      ai.generateJson({ ...request("openai"), schema: structured }),
      code("AI_INVALID_OUTPUT"),
    );
    let deep = { type: "string" };
    for (let i = 0; i < 12; i++)
      deep = {
        type: "object",
        properties: { value: deep },
        required: ["value"],
        additionalProperties: false,
      };
    await assert.rejects(
      ai.generateJson({ ...request("openai"), schema: deep }),
      code("AI_INVALID_SCHEMA"),
    );
  } finally {
    await ai.close();
    await f.close();
  }
});

test("network errors are safe, pre-cancelled requests never dispatch, and diagnostics failures cannot fail generation", async () => {
  const f = await aiFixture();
  const ai = await createAiService({
    ...f.options,
    fetch: async () => {
      throw new Error(f.keys.openai + " private-prompt");
    },
  });
  try {
    await assert.rejects(
      ai.generateText(request("openai")),
      code("AI_NETWORK_ERROR"),
    );
    const controller = new AbortController();
    controller.abort(new Error("private-reason"));
    await assert.rejects(
      ai.generateText({ ...request("openai"), signal: controller.signal }),
      code("AI_CANCELLED"),
    );
    assert.ok(!JSON.stringify(f.logs).includes(f.keys.openai));
    assert.equal(f.requests.length, 0);
    const logged = await createAiService({
      ...f.options,
      log: () => {
        throw new Error("diagnostic failure");
      },
    });
    try {
      assert.equal(
        (await logged.generateText(request("openai"))).text,
        "fixture-answer",
      );
    } finally {
      await logged.close();
    }
  } finally {
    await ai.close();
    await f.close();
  }
});
