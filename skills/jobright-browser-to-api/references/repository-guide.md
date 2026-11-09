# Repository guide

All paths below are relative to the automation repository root. This skill can be installed outside that repository; discover the active checkout before reading or editing these paths.

## Entry points

| Path | Role |
| --- | --- |
| `plugins/jobright/index.js` | Plugin identity, browser/API transports, supported operations |
| `plugins/jobright/browser.js` | DOM extraction, return-to-list behavior, card-scoped tracking controls |
| `plugins/jobright/auth.js` | Browser-assisted login and valid session reuse |
| `plugins/jobright/api.js` | Recommendation listing, normalization, tracking updates, Applied verification |
| `plugins/jobright/http.js` | Authenticated website requests, response envelopes, errors, timeouts |
| `plugins/jobright/normalize.js` | Shared detail defaults and API field mappings |
| `src/core/browser-manager.js` | Chromium context, session persistence, recorder attachment |
| `src/core/network-recorder.js` | First-party allowlist, action phases, redacted JSONL and endpoint catalog |
| `src/core/runner.js` | Save-before-update order, retries, reconciliation, cancellation |
| `src/core/compare.js` | Existing browser/API parity checks; extend for new fields |
| `src/cli.js` | Login, inspect, compare, finite collection, export |
| `src/service/worker.js` | Managed execution with connection ownership, account lock, IPC cancellation |
| `src/storage/database.js` | Job validation, connection-specific identity, JSON persistence, processing states |
| `test/helpers/fixture-server.js` | Local Jobright-shaped browser/API website |
| `test/browser.test.js`, `test/api.test.js` | Browser behavior and API parity/contract regression tests |
| `test/network-recorder.test.js` | Capture scope and redaction regression tests |

Read `docs/website-plugins.md`, `docs/common-patterns.md`, and the relevant parts of `docs/data-model.md` when changing their corresponding contracts. The root `README.md` records observed Jobright endpoints. Check current source and evidence rather than treating a historical endpoint list as proof it still works.

## Current interfaces and invariants

Both transports implement:

```js
authenticate(context)
listJobs(context, { excludeIds })
getJobDetails(context, job)
markAsApplied(context, job)
getApplicationStatus(context, job)
```

`context` includes Playwright `page`/browser `context`, `http` backed by the browser request context, credentials, configuration, recorder, session helpers, logger, and abort signal. Verification also receives a bounded deadline and signal.

List candidates use stable string `id` and `url`; details return `{ id, url, title, company, details, raw }`. Details must have a nonempty description. Source IDs must match the selected candidate. Use empty/null optional values rather than inventing facts.

The runner alone controls `saved -> mark_pending -> mark_confirmed`. Unknown update results stay pending; verified absence requires explicit source evidence. A retry reconciles pending changes before sending further updates. Account locks also protect CLI runs from overlapping managed workers.

The current recommendation response contains full `jobResult` and `companyResult` payloads, so API details do not require a separate request. Current write and verification paths are documented in the root README; revalidate affected behavior for the requested extension.

## Windows commands

Run commands from the repository root using its wrapper so Node and the workspace Chromium location are configured. On a configured non-Windows checkout, use the equivalent `npm run ...` commands.

```powershell
# Optional local visible login when existing session reuse is insufficient
.\npm.cmd run login -- --site jobright --headed

# Inspect one recommendation in the browser and record relevant requests.
# This does not save a collected job or mark its tracking status.
.\npm.cmd run inspect -- --site jobright

# Persist one browser-extracted job without updating website tracking
.\npm.cmd run start -- --site jobright --transport browser --limit 1 --read-only

# After implementing the API path, compare the same selected job through both transports.
# This reads without saving job details or changing website tracking.
.\npm.cmd run compare -- --site jobright

# Persist one API-extracted job without updating website tracking
.\npm.cmd run start -- --site jobright --transport api --limit 1 --read-only

# Fixture-based core/backend/plugin tests
.\npm.cmd test
```

`inspect` covers the current recommendation/detail path; it is not a generic executor for arbitrary UI actions. Use a focused Playwright discovery path for the requested additional action, reusing the same browser manager/recorder/lock and bounded cleanup. Do not make inspection silently perform unrelated mutations.

CLI credentials come from ignored local environment configuration. Managed connection credentials are encrypted and available through the managed worker flow; do not dump them or assume CLI configuration represents the selected user's connection. If CLI commands target a different account, use the managed connection or an appropriately isolated local harness instead.

CLI diagnostics are under `artifacts/<site-account>/<timestamp>/`; managed diagnostics are under `artifacts/<user-id>/<connection-id>/<run-id>/`. Useful files are `network.jsonl`, `endpoint-catalog.json`, `inspection.json`, and `comparison.json`, depending on the command. The endpoint catalog reflects the recorder's bounded recent history; the JSONL stream retains all captured exchanges. Preserve relevant earlier evidence rather than assuming the catalog is exhaustive.

For backend changes, also run `npm run test:service`. For affected frontend behavior, run `npm run web:test`, `npm run web:build`, and `npm run web:e2e`. These suites use fixture accounts, not the real website.
