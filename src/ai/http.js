import { AiError } from "./errors.js";
import { OUTPUT_BYTES } from "./validation.js";

export async function postJson(context, url, headers, body) {
  let response;
  try {
    response = await context.fetch(url, {
      method: "POST",
      redirect: "error",
      signal: context.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new AiError("AI_NETWORK_ERROR");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status))
      throw new AiError("AI_PROVIDER_AUTH");
    if (response.status === 429) throw new AiError("AI_RATE_LIMIT");
    throw new AiError("AI_PROVIDER_ERROR");
  }
  const cancel = () => {
    void response.body?.cancel().catch(() => {});
  };
  if (Number(response.headers.get("content-length")) > OUTPUT_BYTES) {
    cancel();
    throw new AiError("AI_RESPONSE_TOO_LARGE");
  }
  if (
    !/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    !response.body
  ) {
    cancel();
    throw new AiError("AI_INVALID_RESPONSE");
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OUTPUT_BYTES) {
        void reader.cancel().catch(() => {});
        throw new AiError("AI_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    if (error instanceof AiError) throw error;
    throw new AiError("AI_INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

const counter = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export const usage = (input, output, total) => ({
  inputTokens: counter(input),
  outputTokens: counter(output),
  totalTokens: counter(total),
});
export function completion(text, tokenUsage) {
  if (typeof text !== "string" || !text.trim())
    throw new AiError("AI_INVALID_RESPONSE");
  return { text, usage: tokenUsage, finishReason: "stop" };
}
