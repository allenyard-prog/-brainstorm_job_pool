---
name: jobright-browser-to-api
description: Extend this Jobright automation project by implementing browser behavior first, capturing the associated website requests, and implementing and verifying the equivalent API transport. Use for new Jobright actions, missing scraped fields, pagination/filter support, or changed website endpoints.
---

# Jobright browser-to-API development

Deliver the requested behavior in the browser transport first, then implement the equivalent API transport from observed network evidence. Both transports must remain independently usable. This skill guides implementation; it is not a continuously running scraper or a new service worker.

## Establish the requested operation

Locate the repository containing `plugins/jobright/`, `src/core/runner.js`, and `web/package.json`. Treat paths in the supporting reference as relative to that repository, not the installed skill directory. Read [the repository guide](references/repository-guide.md) for entry points and existing commands; inspect the actual files before changing them.

Identify the UI trigger, expected result, needed fields, and whether the operation changes website state. Reuse task details and prior authorization. Ask only for information that genuinely blocks the operation; continue fixture and implementation work independently. If a live account or interactive verification is unavailable, complete everything supported by fixtures and report the live evidence gap without claiming an endpoint is confirmed.

Distinguish Jobright's website requests, such as `/swan/...`, from our `/api/v1/...` Fastify resources. Implement source behavior in the Jobright plugin. Extend backend routes, storage, workers, or the dashboard only when the requested feature needs those changes.

## Implement browser behavior and capture evidence

1. Inspect existing browser selectors, authentication, normalization, and fixture coverage. Implement or repair the requested browser operation before replacing its behavior with HTTP.
2. Use the existing browser manager, session handling, account lock, and `NetworkRecorder`. Prefer a bounded, read-only inspection for discovery. Source credentials stay in existing local configuration or encrypted connections, never in skill files, command arguments, screenshots, fixtures, or committed reports.
3. Observe the initial page, the relevant action, the resulting UI, and its request/response sequence. Tag recorder phases with meaningful action names to correlate requests with behavior. Distinguish background refreshes and prefetches from requests caused by the action.
4. Inspect the recorder's current host/path allowlist. It intentionally covers only selected first-party Jobright endpoints; an absent capture does not prove no API exists. If the requested operation lies outside it, add the narrow relevant first-party path and fixture coverage while preserving authentication/profile/resume exclusions. Do not enable unrestricted capture. If the task genuinely needs an excluded sensitive flow, inspect only the minimum required information in memory and keep its bodies/session material out of diagnostics.
5. Inspect DOM selectors rather than assuming supplied text is an ID. Scope controls to the target job ID, expand relevant sections, preserve account filters, and re-query after changing lists. Bound exploration; do not start an unlimited marking run merely to discover a request.

For state-changing actions, perform only the action already authorized for the task. Capture it during its intended execution; do not repeat it merely for discovery. Our collection path commits valid job details before marking **Already applied**, records pending intent, and verifies the result. Keep that ordering. Tracking status changes do not submit employer applications.

## Establish the endpoint contract

Use [the evidence template](references/endpoint-evidence.md) to record the requested operation, capture provenance, confirmed requests, and unresolved behavior. Keep captured files in ignored artifacts; commit a concise sanitized contract only when useful for maintaining the feature.

Confirm the method, path, parameter/body shape, required authentication context, success envelope, response fields, pagination, and observable postcondition. Separate observations from assumptions. Do not invent endpoints from URL names or assume a detail click requires a detail request: recommendations may already contain the payload.

Inspect pagination progression and empty states. Detect repeated pages/cursors and preserve current source filters. For writes, distinguish an acknowledgement from a verified outcome. For read-only POSTs, allow bounded read retries only when their semantics are established; do not infer mutation behavior from the HTTP method alone.

Determine whether additional headers/tokens are required from in-memory evidence without logging their values. Reuse the authenticated browser context's cookie jar and existing request helper. If a required value cannot be obtained reliably, report the operation as unsupported rather than hardcoding a live token.

## Implement API behavior

Implement confirmed requests in `plugins/jobright/api.js` and website-specific validation in `http.js`; share authentication and normalization where applicable. Retain browser support. API job operations must not silently fall back to DOM extraction.

Validate source envelopes and operation-specific schemas before using them. Map session expiry to `AuthenticationError`, unsupported/changed contracts to `UnsupportedError`, and rate-limit/systemic conditions to the existing systemic failure policy. Keep writes free of automatic retries. An uncertain update remains pending for reconciliation and may end the run as `attention_required`.

Normalize browser and API results into the same job envelope. Preserve long descriptions, stable IDs, account-specific matching, optional values, and source-specific metadata. The runner owns persistence and processing state; plugin methods must not save jobs or finish runs themselves.

If the requested action is a new semantic operation beyond the current five-method interface, define it explicitly in plugin capabilities and the affected orchestration/API contracts. Do not disguise it as `markAsApplied` or make every collection run perform an unrelated action. Preserve ownership and cancellation for any new asynchronous operation.

## Verify and finish

- Exercise browser and API behavior against local fixtures, including the new operation, response changes, empty/multiple pages, expiry, and relevant failure paths.
- Compare equivalent results for the same job/account/filter context. The current comparison helper checks a subset of fields; add checks for new fields. Run comparison after browser implementation works. If the API path is not yet functional, compare against independently obtained browser evidence instead of relying on the comparison command to discover the missing endpoint.
- For writes, test persistence failure, dropped/ambiguous responses, restart reconciliation, and cancellation. Never mark after failed extraction/save, infer `not_applied` from absence alone, or repeat a write through the other transport.
- Use bounded live read verification only when the task supports it. A live write check requires existing authorization for that specific action and target; use fixtures otherwise. State clearly which checks were fixture-only and which requests were observed live. Do not expand an authorized single action into bulk changes.
- Run the relevant regression commands from the repository guide. Update source contract documentation and capability metadata when behavior changes.

Finish with the browser behavior, captured API contract, implemented files, parity results, tests, and any remaining unsupported or unverified details. Never include credentials, cookie/token values, or unrelated account data in the report.
