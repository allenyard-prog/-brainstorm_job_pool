import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { serviceFixture, waitForRun } from "./helpers/service-fixture.js";
import { aiFixture, schema } from "./helpers/ai-fixture.js";

const input = (extra = {}) => ({
  model: { provider: "openai", id: "openai-fixture" },
  prompt: "private-prompt",
  output: { type: "text" },
  ...extra,
});
async function fixture(extra = {}) {
  const source = await aiFixture();
  const f = await serviceFixture({ ai: source.options, ...extra });
  const admin = await f.login("admin"),
    alice = await f.login("alice");
  return {
    ...f,
    source,
    admin,
    alice,
    async close() {
      await f.close();
      await source.close();
    },
  };
}
async function listen(f) {
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  f.config.origin = address;
  f.config.allowedOrigins.splice(0, f.config.allowedOrigins.length, address);
  return address;
}

test("AI APIs are administrator-only, enforce Origin/schema checks, and publish safe OpenAPI/model metadata", async () => {
  const f = await fixture();
  try {
    for (const method of ["GET", "POST"]) {
      const path =
        method === "GET" ? "/api/v1/ai/models" : "/api/v1/ai/generate";
      assert.equal(
        (await f.request(method, path, method === "POST" ? input() : undefined))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await f.request(
            method,
            path,
            method === "POST" ? input() : undefined,
            f.alice,
          )
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await f.request(
          "POST",
          "/api/v1/ai/generate",
          input(),
          f.admin,
          "https://untrusted.test",
        )
      ).statusCode,
      403,
    );
    for (const body of [
      input({ model: { provider: "other", id: "id" } }),
      input({ prompt: false }),
      input({ prompt: " " }),
      input({ maxOutputTokens: "10" }),
      input({ baseUrl: "https://untrusted.test" }),
      input({ actorId: "other-admin" }),
      input({ output: { type: "json" } }),
      input({ output: { type: "text", schema } }),
    ])
      assert.equal(
        (await f.request("POST", "/api/v1/ai/generate", body, f.admin))
          .statusCode,
        400,
      );
    const unknown = await f.request(
      "POST",
      "/api/v1/ai/generate",
      input({ model: { provider: "openai", id: "unknown" } }),
      f.admin,
    );
    assert.equal(unknown.json().error.code, "AI_MODEL_NOT_CONFIGURED");
    assert.equal(f.source.requests.length, 0);
    const models = await f.request(
      "GET",
      "/api/v1/ai/models",
      undefined,
      f.admin,
    );
    assert.equal(models.statusCode, 200);
    assert.equal(models.json().length, 4);
    assert.ok(!models.body.includes("secret"));
    assert.equal(
      f.app.swagger().paths["/api/v1/ai/generate"].post.requestBody.content[
        "application/json"
      ].schema.properties.output.anyOf.length,
      2,
    );
    assert.ok(!JSON.stringify(f.app.swagger()).includes("fixture-ai-secret"));
  } finally {
    await f.close();
  }
});

test("generation returns normalized text/JSON, accepts larger AI input, and persists no content or schema changes", async () => {
  const f = await fixture();
  try {
    const before = (await f.app.db.call("ping")).ok;
    const response = await f.request(
      "POST",
      "/api/v1/ai/generate",
      input({ prompt: "p".repeat(64 * 1024) }),
      f.admin,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().text, "fixture-answer");
    assert.equal(response.json().data, null);
    assert.equal(response.json().usage.inputTokens, 11);
    const json = await f.request(
      "POST",
      "/api/v1/ai/generate",
      input({ output: { type: "json", schema } }),
      f.admin,
    );
    assert.equal(json.statusCode, 200, json.body);
    assert.deepEqual(json.json().data, { answer: "fixture" });
    const oversized = await f.request(
      "POST",
      "/api/v1/ai/generate",
      input({ prompt: "p".repeat(256 * 1024) }),
      f.admin,
    );
    assert.equal(oversized.statusCode, 413);
    assert.equal(f.source.requests.length, 2);
    assert.equal((await f.request("GET", "/health")).statusCode, 200);
    assert.equal((await f.app.db.call("ping")).ok, before);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.config.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 8);
      assert.deepEqual(
        db
          .prepare(
            "SELECT id FROM ai_recommendations",
          )
          .all(),
        [],
      );
    } finally {
      db.close();
    }
    assert.ok(!JSON.stringify(f.source.logs).includes("private-prompt"));
  } finally {
    await f.close();
  }
});

test("pending AI calls do not block health/jobs; per-admin limits and sanitized AI errors retain their messages", async () => {
  const f = await fixture();
  try {
    f.source.mode("openai", "held");
    const pending = f.request("POST", "/api/v1/ai/generate", input(), f.admin);
    await f.source.waitFor(1);
    const started = Date.now();
    assert.equal((await f.request("GET", "/health")).statusCode, 200);
    assert.equal((await f.request("GET", "/ready")).statusCode, 200);
    assert.equal(
      (await f.request("GET", "/api/v1/jobs?page=1", undefined, f.alice))
        .statusCode,
      200,
    );
    assert.ok(Date.now() - started < 1000);
    const busy = await f.request(
      "POST",
      "/api/v1/ai/generate",
      input(),
      f.admin,
    );
    assert.equal(busy.statusCode, 429);
    assert.equal(busy.json().error.code, "AI_BUSY");
    assert.ok(!busy.json().error.message.includes("login"));
    assert.equal(f.source.requests.length, 1);
    await f.app.ai.close();
    assert.equal((await pending).json().error.code, "AI_SHUTTING_DOWN");
  } finally {
    await f.close();
  }
});

test("native provider errors, timeouts, invalid JSON and response limits stay typed and never expose provider bodies", async () => {
  const source = await aiFixture();
  const f = await serviceFixture({ ai: { ...source.options, timeoutMs: 100 } });
  try {
    const admin = await f.login("admin");
    for (const [mode, expectedStatus, expectedCode] of [
      ["http-401", 503, "AI_PROVIDER_AUTH"],
      ["http-429", 429, "AI_RATE_LIMIT"],
      ["http-500", 502, "AI_PROVIDER_ERROR"],
      ["refused", 422, "AI_REFUSED"],
      ["incomplete", 502, "AI_INCOMPLETE"],
      ["schema-mismatch", 502, "AI_INVALID_OUTPUT"],
      ["huge", 502, "AI_RESPONSE_TOO_LARGE"],
      ["held", 504, "AI_TIMEOUT"],
    ]) {
      source.mode("openai", mode);
      const response = await f.request(
        "POST",
        "/api/v1/ai/generate",
        input({ output: { type: "json", schema } }),
        admin,
      );
      assert.equal(response.statusCode, expectedStatus, response.body);
      assert.equal(response.json().error.code, expectedCode);
      for (const secret of [
        "private-prompt",
        "private-result",
        ...Object.values(source.keys),
      ])
        assert.ok(!response.body.includes(secret));
    }
    source.mode("openai", "success");
    assert.equal(
      (await f.request("POST", "/api/v1/ai/generate", input(), admin))
        .statusCode,
      200,
    );
  } finally {
    await f.close();
    await source.close();
  }
});

test("real HTTP client disconnect cancels generation and releases capacity without logging content", async () => {
  const f = await fixture();
  try {
    const address = await listen(f);
    f.source.mode("openai", "held-body");
    const client = httpRequest(`${address}/api/v1/ai/generate`, {
      method: "POST",
      headers: {
        cookie: f.admin,
        origin: address,
        "content-type": "application/json",
      },
    });
    client.on("error", () => {});
    client.end(JSON.stringify(input()));
    await f.source.waitFor(1);
    client.destroy();
    const deadline = Date.now() + 2000;
    while (
      !f.source.logs.some((log) => log.code === "AI_CANCELLED") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(f.source.logs.some((log) => log.code === "AI_CANCELLED"));
    f.source.mode("openai", "success");
    assert.equal(
      (await f.request("POST", "/api/v1/ai/generate", input(), f.admin))
        .statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test("service shutdown cancels active HTTP generation before waiting for request drain", async () => {
  const f = await fixture();
  try {
    const address = await listen(f);
    f.source.mode("openai", "held");
    const response = fetch(`${address}/api/v1/ai/generate`, {
      method: "POST",
      headers: {
        cookie: f.admin,
        origin: address,
        "content-type": "application/json",
      },
      body: JSON.stringify(input()),
    });
    await f.source.waitFor(1);
    const started = Date.now();
    await f.app.close();
    const result = await response;
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, "AI_SHUTTING_DOWN");
    assert.ok(Date.now() - started < 2000);
  } finally {
    await f.close();
  }
});

test("AI credentials are absent from real scraper-child environments and IPC start payloads", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-ai-secret-isolation";
  const f = await fixture({
    supervise: true,
    workerModule: fileURLToPath(
      new URL("./helpers/ai-isolation-worker.mjs", import.meta.url),
    ),
  });
  try {
    const profile = await f.connect(f.alice);
    const run = (
      await f.request(
        "POST",
        "/api/v1/runs",
        {
          connectionId: profile.id,
          transport: "api",
          readOnly: true,
          limit: 1,
        },
        f.alice,
      )
    ).json();
    await waitForRun(f, f.alice, run.id, ["completed"]);
    const events = (
      await f.request(
        "GET",
        `/api/v1/runs/${run.id}/events`,
        undefined,
        f.alice,
      )
    ).json().items;
    assert.deepEqual(
      events.find((event) => event.type === "ai_isolation").payload,
      { environmentHasKeys: false, payloadHasKeys: false },
    );
    assert.equal(f.source.requests.length, 0);
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("an unconfigured AI layer starts normally and exposes no enabled models", async () => {
  const f = await serviceFixture({
    ai: {
      catalog: { openai: [], gemini: [], deepseek: [], claude: [] },
      keys: {},
      log: () => {},
    },
  });
  try {
    const admin = await f.login("admin");
    const result = await f.request(
      "GET",
      "/api/v1/ai/models",
      undefined,
      admin,
    );
    assert.ok(
      result
        .json()
        .every((provider) => !provider.enabled && provider.models.length === 0),
    );
    assert.equal((await f.request("GET", "/ready")).statusCode, 200);
  } finally {
    await f.close();
  }
});
