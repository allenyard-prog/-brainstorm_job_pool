# Endpoint evidence and implementation record

Use this structure when maintaining a discovered operation. Fill only supported facts; omit irrelevant sections. Keep reports concise, and separate confirmed observations from hypotheses and fixture assumptions. This is a reporting template, not a request to collect unrelated account data.

## Operation and provenance

- Requested feature and expected visible result.
- Read-only or state-changing semantics; intended job/connection scope without personal identifiers.
- Observation date and capture mode: live website, existing sanitized capture, or fixture.
- Browser action/phase and local ignored artifact reference.
- Whether browser behavior worked before the API implementation.

## Request contract

| Field | What to record |
| --- | --- |
| Trigger | Specific UI control/action and expected postcondition |
| Host/path | Confirmed first-party route; replace dynamic account/job identifiers with placeholders |
| HTTP method | Observed verb; establish semantics independently of the verb |
| Query/body | Field names, types, required/optional behavior, harmless synthetic examples |
| Authentication | Cookie jar, header/token names and acquisition mechanism; no values |
| Success | HTTP status, source envelope, acknowledgement versus verified result |
| Pagination | Cursor/offset/page-size field names and progression; no real token values |
| Failure | Observed expiry, validation, rate-limit, or changed-schema behavior |

Retain required dynamic values in memory for the actual operation; they do not belong in the report. Do not paste raw HAR files, cookies, passwords, authorization headers, account payloads, or copied live request commands into tracked files.

## Response and parity mapping

| Normalized field or result | Browser evidence | Source response field | Validation/parity rule |
| --- | --- | --- | --- |
| `id` | Selected source job identity | Observed job ID field | Same stable ID in both transports |
| `details.<field>` | Visible or expanded section | Confirmed response field path | Preserve full content and missing-value behavior |
| Operation status | Resulting UI state | Confirmed acknowledgement and verification request | Verify outcome independently for writes |

Document whether data comes from a new request, initial-page data, cached recommendations, or prefetch. A click and a nearby request are not sufficient proof of causation. Add specific mappings for the requested feature rather than copying the entire account response.

## Implementation and verification

- Browser implementation and API implementation entry points.
- Changes to capture scope, normalizers, plugin capabilities, or orchestration.
- Fixture tests for success, empty/multiple pages, expiry, changed responses, and relevant interruption paths.
- Parity result, meaningful differences, and their evidence-backed explanations.
- For writes: persistence-before-send, unknown-result handling, and restart verification.
- Live checks actually completed, distinguishing reads from authorized mutations.
- Remaining unsupported or unverified behavior and what evidence is missing.

If a new API request remains hypothetical, mark it unconfirmed and do not expose it as a supported operation. If no additional request exists, document the observed data source instead of fabricating a detail endpoint.
