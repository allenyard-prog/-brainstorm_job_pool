import { createServer } from "node:http";
import { once } from "node:events";

export const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
export const providerIds = ["openai", "gemini", "deepseek", "claude"];
export const catalog = Object.fromEntries(
  providerIds.map((provider) => [
    provider,
    [
      { id: `${provider}-fixture`, capabilities: { text: true, json: true } },
      {
        id: `${provider}-text-only`,
        capabilities: { text: true, json: false },
      },
    ],
  ]),
);
const hosts = {
  "api.openai.com": "openai",
  "generativelanguage.googleapis.com": "gemini",
  "api.deepseek.com": "deepseek",
  "api.anthropic.com": "claude",
};

export async function aiFixture({jsonOutput} = {}) {
  const requests = [],
    logs = [],
    modes = new Map();
  const keys = Object.fromEntries(
    providerIds.map((provider) => [provider, `fixture-ai-secret-${provider}`]),
  );
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const [, provider, ...path] = req.url.split("/");
    const data = JSON.parse(body),
      mode = modes.get(provider) ?? "success";
    requests.push({
      provider,
      method: req.method,
      path: "/" + path.join("/"),
      headers: req.headers,
      body: data,
    });
    res.setHeader("content-type", "application/json");
    if (mode === "held") return;
    if (mode === "held-body") {
      res.writeHead(200);
      res.flushHeaders();
      res.write("{");
      return;
    }
    if (mode.startsWith("http-")) {
      res.statusCode = Number(mode.slice(5));
      res.end(
        JSON.stringify({
          error: { message: `${keys[provider]} private-prompt private-result` },
        }),
      );
      return;
    }
    if (mode === "malformed") {
      res.end("{malformed private-result");
      return;
    }
    if (mode === "non-json") {
      res.setHeader("content-type", "text/plain");
      res.end("private-result");
      return;
    }
    if (mode === "huge") {
      res.end(JSON.stringify({ junk: "x".repeat(2 * 1024 * 1024) }));
      return;
    }
    if (mode === "huge-chunked") {
      res.write(" ".repeat(1024 * 1024));
      res.end(" ".repeat(1024 * 1024 + 1));
      return;
    }
    if (mode === "changed") {
      res.end("{}");
      return;
    }
    const isJson = !!(
      data.text?.format ||
      data.generationConfig?.responseFormat ||
      data.response_format ||
      data.output_config
    );
    const text =
      mode === "invalid-json"
        ? "not JSON"
        : mode === "schema-mismatch"
          ? '{"answer":42}'
          : mode === "extra-field"
            ? '{"answer":"fixture","extra":true}'
            : isJson
              ? jsonOutput ? JSON.stringify(await jsonOutput({provider,body:data})) : '{"answer":"fixture"}'
              : "fixture-answer";
    let result;
    if (provider === "openai")
      result = {
        id: "r1",
        status: mode === "incomplete" ? "incomplete" : "completed",
        output: [
          { type: "reasoning", summary: [{ text: "hidden-reasoning" }] },
          {
            type: "message",
            content: [
              mode === "refused"
                ? { type: "refusal", refusal: "private-refusal" }
                : { type: "output_text", text },
            ],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      };
    if (provider === "gemini")
      result = {
        candidates: [
          {
            finishReason:
              mode === "incomplete"
                ? "MAX_TOKENS"
                : mode === "refused"
                  ? "SAFETY"
                  : "STOP",
            content: {
              parts: [{ thought: true, text: "hidden-reasoning" }, { text }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 7,
          totalTokenCount: 20,
        },
      };
    if (provider === "deepseek")
      result = {
        choices: [
          {
            finish_reason:
              mode === "incomplete"
                ? "length"
                : mode === "refused"
                  ? "content_filter"
                  : "stop",
            message: { content: text, reasoning_content: "hidden-reasoning" },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      };
    if (provider === "claude")
      result = {
        stop_reason:
          mode === "incomplete"
            ? "max_tokens"
            : mode === "refused"
              ? "refusal"
              : "end_turn",
        content: [
          { type: "thinking", thinking: "hidden-reasoning" },
          { type: "text", text },
        ],
        usage: { input_tokens: 11, output_tokens: 7 },
      };
    if (mode === "no-usage") {
      delete result.usage;
      delete result.usageMetadata;
    }
    res.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    logs,
    keys,
    mode: (provider, mode) => modes.set(provider, mode),
    options: {
      catalog: structuredClone(catalog),
      keys,
      log: (entry) => logs.push(entry),
      fetch: (url, options) => {
        const target = new URL(url),
          provider = hosts[target.hostname];
        if (!provider || target.protocol !== "https:")
          throw new Error("Unexpected fixture target.");
        return fetch(
          `${baseUrl}/${provider}${target.pathname}${target.search}`,
          options,
        );
      },
    },
    async waitFor(count) {
      const deadline = Date.now() + 3000;
      while (requests.length < count && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      if (requests.length < count)
        throw new Error("Fixture request was not received.");
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
