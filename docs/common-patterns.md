# Common development patterns

These conventions describe the implemented application and the boundaries to preserve when extending it. Use [architecture](architecture.md) for the component map and [the backend guide](backend.md) for operational commands.

## Keep routes short and work asynchronous

HTTP handlers validate commands, persist them, and return a resource. Authentication to a job website and scraping belong in child processes. Queueing returns `202`; it does not wait for Chromium or external HTTP requests.

Use `AsyncStore.call()` for database access from service code. Add new service database methods to `rpcMethods` in `service-store.js`, which the database thread uses as an allowlist. Scraper processes can use the synchronous store directly because they have a separate event loop.

Do not replace the database thread with per-request threads or put browser work in Fastify handlers.

## Enforce ownership in storage queries

Pass the authenticated user ID from the request context, never from a submitted owner field:

```js
const run = await db.call('getRun', request.user.id, request.params.id);
```

New resource lookups, detail endpoints, event streams, and mutations must check ownership in their SQL. Return an unavailable/not-found response for resources owned by someone else. Admin-only navigation is a convenience; backend role and ownership checks remain authoritative.

## Validate input and serialize explicit resources

Follow the Fastify schemas in `src/service/schemas.js` and `app.js`. Reject unsupported fields/options and serialize defined resource shapes. Keep database rows containing hashes or encrypted credentials out of public responses.

API errors use one envelope:

```json
{
  "error": {
    "code": "RUN_EXISTS",
    "message": "A run is already queued or active for this connection.",
    "details": { "runId": "existing-run-id" }
  }
}
```

`details` is optional. Use stable codes for handling, readable messages for display, and generic messages for internal failures. Duplicate work should link to the existing run rather than trigger repeated submissions.

## Make local transitions durable before external writes

Preserve this ordering:

1. Extract and validate job identity, title, URL, and description.
2. Commit the full job and its processing row.
3. If tracking is enabled, persist `mark_pending`.
4. Send the website tracking action once.
5. Verify status and persist confirmation or an unresolved state.

A failed extraction or save must prevent the tracking action. SQLite and the external website do not share a transaction; this design does not promise exactly-once external writes. Recovery comes from recorded intent and verification.

Never automatically retry an uncertain tracking update or repeat it through another transport. Reconcile pending records before new changes. A read-only run performs extraction/persistence without website tracking updates.

## Keep retry and failure policies separate

| Situation | Pattern |
| --- | --- |
| Transient detail read | Runner makes at most three attempts with bounded waits |
| Ordinary per-job extraction failure | Skip that job for the current run and increment failure counters |
| Three failures before any save | Treat as a systemic failure |
| Authentication intervention or uncertain update | Finish with `attention_required` |
| Unsupported response/schema | Fail clearly; do not switch transports automatically |
| Frontend read failure | At most one automatic retry for network/server failures |
| Frontend command | No automatic retries or offline command queueing |

Use the core error types in `src/core/errors.js` so the runner can distinguish these outcomes. A user-requested retry is a new run with `parentRunId`, not a reset of the original run.

## Cooperate with cancellation

Pass `context.signal` to abortable work and check it before scheduling another operation. Keep any verification after a sent update bounded by its separate timeout/deadline. Release account locks, flush diagnostics, and close browser/database resources in cleanup paths.

Persist the stop request before sending IPC. Correctness must survive a missed IPC message, worker exit, or supervisor restart. Do not use an in-memory flag as the only stop or progress record.

## Share orchestration and isolate website behavior

The runner owns persistence and processing states. Plugins own selectors, authentication flows, endpoint payloads, pagination, and normalization. Both transports return the same job envelope; account-specific extras remain in JSON.

Keep website assumptions out of generic service routes and React page logic. Discover enabled sites and transports through `/api/v1/sites`. Declare tracking support only when both updating and verification are implemented. See [the plugin contract](website-plugins.md#transport-contract).

## Keep SQLite authoritative

Use ordinary columns for identity, ownership, filters, and timestamps; use JSON TEXT for lengthy or variable metadata. Validate JSON and preserve complete descriptions. An upsert must preserve pending/confirmed processing state instead of resetting it to `saved`.

Keep transactions short and use SQL constraints to enforce concurrency and identity. Add schema changes through versioned migrations. Export JSON/CSV from SQLite rather than introducing a competing file store.

Run events supplement current run rows; they are a progress/history log, not an event-sourced reconstruction mechanism.

## Use shared frontend state helpers

Use the relative API client and existing hooks:

```jsx
const jobs = useResource('jobs', { connectionId, q, cursor, limit: 20 });
const action = useAction();

async function stopRun(id) {
  await action.mutateAsync({ path: `/runs/${id}/stop` });
}
```

TanStack Query keys include the authenticated user ID. Logout, expiry, and session changes cancel requests and clear caches. Keep passwords only in transient form input; do not prefill them or persist credentials/tokens in browser storage.

`useFilters()` stores filters and cursor navigation in the URL. Use shared query invalidation instead of manually patching counters across pages. Refresh job queries when saved counters change or a collection finishes.

Poll visible dashboard/active run resources every two seconds. Stop detail polling after terminal states. Load events using the server cursor, deduplicate by ID, and retain at most 500 rendered entries. Do not infer global totals from a paginated list.

## Treat scraped content as untrusted data

Render description and metadata text through React; do not insert scraped HTML. Allow only HTTP/HTTPS external links and use `noopener noreferrer` for new tabs. Fetch raw JSON only when expanded and keep the server's redaction boundary in place.

Use shared components, CSS tokens, native dialog behavior, visible status text, keyboard-operable tabs/forms, and responsive table scrolling. Provide loading, empty, error, conflict, and permission states for new screens.

## Test with fixtures at the correct boundary

| Change | Relevant verification |
| --- | --- |
| SQL/schema/ownership | Temporary SQLite databases, migration/ownership tests |
| Worker lifecycle | Managed fixture workers for blocking, crashes, stops, and pending writes |
| Website transport | Local Jobright-shaped HTTP/browser fixtures |
| React behavior | Component tests with mocked resource APIs |
| Full frontend workflow | Playwright against production build and temporary backend |
| Hosting/proxy | SPA refresh, API/asset 404s, and trusted Origin tests |

Never use real Jobright credentials in regression tests. For a new feature, update schemas/storage first, expose the owner-scoped API, add worker behavior if needed, connect shared frontend hooks, test the affected boundaries, and update the corresponding documentation.
