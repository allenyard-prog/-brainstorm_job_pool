# Pluggable AI generation

The backend has a standalone generation layer in `src/ai/`, with OpenAI, Gemini, DeepSeek, and Claude provider plugins. It supports text and locally validated JSON. It does not read job data automatically, run tools/SQL, restore the old chatbot, or store prompts/results. The separate [specialization recommendation feature](ai-recommendations.md) supplies job context only after an administrator starts an operation; it adds schema version 8 for configuration and operational state.

## Configure providers and models

Set the relevant server-only values in the ignored `.env` file:

```dotenv
OPENAI_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
ANTHROPIC_API_KEY=
AI_TIMEOUT_MS=120000
# Optional: override the default catalog location.
# AI_MODELS_CONFIG=./config/ai-models.json
```

Edit `config/ai-models.json` to explicitly allow the exact model IDs your provider account supports. The shipped file has empty arrays for all four providers, so no model is enabled by default. Keys and model IDs must both be configured before generation; a missing key does not prevent the rest of the application from starting. Configuration is loaded at service startup; restart after changes. The provider ID for Anthropic's Claude API is `claude`.

Each provider array contains entries in this format (replace the placeholder before use):

```json
{
  "openai": [
    {
      "id": "EXACT_PROVIDER_MODEL_ID",
      "capabilities": { "text": true, "json": true }
    }
  ],
  "gemini": [],
  "deepseek": [],
  "claude": []
}
```

Declare `json: false` for models whose structured/JSON mode is unsupported. Text capability must be true. Configuration does not claim that a key/model has been verified remotely; no discovery request or automatic inference is sent at startup. Unsupported models, malformed catalogs, and unsupported capabilities fail explicitly. The service never substitutes another model/provider or chooses a default model.

## Shared functions

```js
import { createAiService } from './src/ai/index.js';

const ai = await createAiService();
try {
  const result = await ai.generateText({
    model: { provider: 'openai', id: 'EXACT_CONFIGURED_MODEL_ID' },
    prompt: 'Summarize this supplied text.',
    system: 'Return a concise answer.',
    maxOutputTokens: 2048,
    signal: AbortSignal.timeout(30000),
  }, { actorId: 'trusted-backend-user-id' });
  // Use result.text; do not add it to operational logs.
} finally {
  await ai.close();
}
```

`generateJson` accepts the same parameters plus `schema`. Every generation requires `model: {provider,id}`. Internal application features should reuse the service's `app.ai` instance and pass the authenticated user's ID as the second argument's `actorId`; do not construct a new service per request or accept actor identities from a client body. Calls without that context share the `internal` actor slot.

Results contain `requestId`, the requested `model` target, `text`, `data`, `usage`, `finishReason`, and `durationMs`. `data` is parsed JSON for JSON requests and null for text. Usage includes nullable `inputTokens`, `outputTokens`, and `totalTokens`, using only counters reported by the provider. Missing counters stay null; native totals can include provider-specific categories and are not a price estimate. Reasoning/thinking blocks are excluded from returned text and logs.

## Administrator APIs

Both endpoints require a backend administrator session. Normal users receive 403; unauthenticated requests receive 401. State-changing requests retain the existing trusted-Origin requirement. API keys are never accepted in request bodies or returned through these endpoints. Profile specialization settings select from these configured models; API keys and model allowlists remain server-managed.

| Request | Result |
| --- | --- |
| `GET /api/v1/ai/models` | Provider array with `id`, `name`, `enabled`, `disabledReason`, and configured `models`/capabilities |
| `POST /api/v1/ai/generate` | Completed normalized generation result, HTTP 200 |

Model capabilities expose `text`, `json`, and `jsonMode` (`native_schema`, `json_mode`, or null for text-only models). Disabled reasons are `missing_api_key` and `no_models`; configuration status is not a remote authentication check.

Text request:

```json
{
  "model": { "provider": "openai", "id": "EXACT_CONFIGURED_MODEL_ID" },
  "prompt": "Summarize the text supplied here.",
  "output": { "type": "text" },
  "maxOutputTokens": 2048
}
```

JSON request:

```json
{
  "model": { "provider": "deepseek", "id": "EXACT_CONFIGURED_MODEL_ID" },
  "prompt": "Extract the role title from this supplied description.",
  "output": {
    "type": "json",
    "schema": {
      "type": "object",
      "properties": { "title": { "type": ["string", "null"] } },
      "required": ["title"],
      "additionalProperties": false
    }
  }
}
```

For PowerShell, reuse the cookie session from the [backend guide](backend.md):

```powershell
Invoke-RestMethod "$api/api/v1/ai/models" -WebSession $backendSession

$body = @{
  model = @{ provider = 'openai'; id = 'EXACT_CONFIGURED_MODEL_ID' }
  prompt = 'Reply with OK.'
  output = @{ type = 'text' }
} | ConvertTo-Json -Depth 20

Invoke-RestMethod "$api/api/v1/ai/generate" -Method Post `
  -Headers @{ Origin = $api } -WebSession $backendSession `
  -ContentType 'application/json' -Body $body
```

Requests await asynchronous provider I/O without blocking other APIs. There is no durable generation queue, history endpoint, streaming, conversation state, or database access inside the AI module.

## Portable JSON schemas and provider contracts

The supported subset has an object root; nested objects, homogeneous arrays, strings, numbers, integers, booleans, null, nullable single-type unions, primitive enums, and optional title/description annotations. Every object must define `properties`, require every property, and set `additionalProperties: false`. Represent optional values as nullable required fields. Bounds are 10 levels, 200 schema nodes, 100 enum values, and 2,000 characters per annotation. References, patterns, formats, defaults, and other unsupported keywords are rejected before dispatch.

Ajv validates every parsed result without coercing types, inserting defaults, removing properties, stripping code fences, or making repair requests. Valid JSON syntax alone is insufficient. Native schema modes also receive this final local validation.

| Provider | Native API | JSON behavior |
| --- | --- | --- |
| OpenAI | `POST https://api.openai.com/v1/responses` | `text.format` JSON schema with strict mode; `store:false` |
| Gemini | `POST https://generativelanguage.googleapis.com/v1beta/models/{id}:generateContent` | `generationConfig.responseFormat.text` with JSON MIME/schema |
| DeepSeek | `POST https://api.deepseek.com/chat/completions` | `response_format: {type:"json_object"}` plus explicit JSON/schema instructions |
| Claude | `POST https://api.anthropic.com/v1/messages` | `output_config.format` JSON schema; version header `2023-06-01` |

Contracts follow the official [OpenAI structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [Gemini structured-output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), [DeepSeek JSON guide](https://api-docs.deepseek.com/guides/json_mode/), and [Claude structured-output guide](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). DeepSeek JSON mode does not supply native schema enforcement; invalid content is rejected locally. No application content history is persisted; provider-side handling follows the provider/account configuration.

## Limits, cancellation, and errors

- Two active generations globally and one per actor/administrator. Capacity is shared by the service instance; excess calls fail immediately with `429 AI_BUSY` without dispatching. No retry queue is created.
- Timeout defaults to 120 seconds; `AI_TIMEOUT_MS` accepts 1–600,000 milliseconds. Output allowance defaults to 2,048 tokens, maximum 8,192, mapped to the provider parameter rather than a universal billing ceiling.
- AI request bodies are limited to 256 KiB; provider response bodies to 2 MiB, including chunked responses. Other API body limits are unchanged.
- Caller cancellation, HTTP client disconnect, and service shutdown abort provider work. Shutdown cancels generations before Fastify waits for request drain. Capacity and timers are released on every exit path.
- Generation, invalid output, and uncertain network outcomes are never automatically retried; no provider fallback or output repair is attempted.

Errors use the existing `{error:{code,message}}` envelope with safe, static messages. Important codes include `AI_INVALID_REQUEST`, `AI_INVALID_SCHEMA`, `AI_UNKNOWN_PROVIDER`, `AI_MODEL_NOT_CONFIGURED`, `AI_UNSUPPORTED_CAPABILITY` (400); `AI_REFUSED` (422); `AI_BUSY` / `AI_RATE_LIMIT` (429); `AI_CANCELLED` (499, when a response is possible); `AI_NETWORK_ERROR`, `AI_PROVIDER_ERROR`, `AI_INVALID_RESPONSE`, `AI_INVALID_OUTPUT`, `AI_INCOMPLETE`, `AI_RESPONSE_TOO_LARGE` (502); `AI_PROVIDER_UNAVAILABLE`, `AI_PROVIDER_AUTH`, `AI_SHUTTING_DOWN` (503); and `AI_TIMEOUT` (504). Ordinary route-schema failures use the existing validation error. Raw provider bodies/errors are never forwarded.

Operational logs contain only generated request IDs, configured model targets, status/error codes, reported usage, and duration. They contain no prompts, outputs, keys, headers, or raw provider errors. AI keys remain outside scraper-worker environments and start payloads. The generation module has no SQL or content storage. Recommendation operations persist only configuration and processing state, as documented separately.

## Testing and adding a provider

Run `npm test` for local four-provider contract fixtures and service tests. They exercise strict validation, native wire formats/authentication, usage, hidden reasoning, refusals/truncation, invalid JSON, errors, body limits, deadlines, cancellation, concurrency, shutdown, admin/Origin enforcement, API responsiveness, and real scraper-child credential isolation. Fixtures remap requests to localhost and make no paid calls.

Live smoke tests are explicitly invoked, require configured keys and allowlisted model IDs, and make one generation each:

```powershell
.\npm.cmd run ai:smoke -- --provider openai --model EXACT_CONFIGURED_MODEL_ID
.\npm.cmd run ai:smoke -- --provider claude --model EXACT_CONFIGURED_MODEL_ID --json
```

Smoke output is metadata-only. These commands are not part of the normal test suite.

To add a provider, create a module under `src/ai/providers/` exporting `id`, `name`, `keyEnv`, `jsonMode`, and `generate(context, request)`. Use the shared bounded `postJson` helper, typed `AiError` codes, and normalized `{text,usage,finishReason}` output. Register it in `provider-registry.js`, add its empty catalog entry and environment-variable example, and extend the native-request/error fixtures. Generation context supplies only the provider's key, HTTP client, and abort signal. Production URLs belong in the adapter; callers cannot supply endpoints.
