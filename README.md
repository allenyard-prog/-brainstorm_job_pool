# Job site automation

Local Node.js 24 automation with interchangeable website plugins, browser and API transports, and SQLite storage. Jobright is implemented and has been inspected against the authenticated website.

See the [documentation index](docs/README.md) for architecture, common development patterns, the data model, plugin integration, and backend/dashboard setup.

## React dashboard and multi-user backend

The Fastify backend adds cookie authentication, private site connections, asynchronous start/stop/retry APIs, run progress/events, and owner-scoped job queries. Scrapers run in separate processes; SQLite access for HTTP runs in a database worker thread.

```powershell
.\npm.cmd run service:init -- --import-legacy
.\npm.cmd run web:build
.\npm.cmd run service
```

Initialization prompts for the first administrator and can claim existing records for that administrator. Open **http://127.0.0.1:3000** for the dashboard and **http://127.0.0.1:3000/docs** for the API. Manage private job-site profiles, start/stop/retry collections, and browse full job details. See [the backend guide](docs/backend.md) for setup, frontend development, endpoints, lifecycle behavior, and migration details.

For frontend development, keep the backend running and use `.\npm.cmd run web:dev`; open **http://127.0.0.1:5173**. Run `.\npm.cmd run web:test` for component tests, and build before `.\npm.cmd run web:e2e` for fixture-backed Playwright tests.

## Run on Windows

A workspace-local Node.js runtime and Chromium are installed under `.tools/`. Use the wrapper so Node does not need to be on your PATH:

```powershell
# Browser extraction and UI status updates
.\npm.cmd run start -- --site jobright --transport browser

# API job retrieval and status updates; browser-assisted authentication
.\npm.cmd run start -- --site jobright --transport api
```

Press **Ctrl+C** to stop. Only one runner can operate on an account at a time. Both commands save each job before marking it **Already applied** in Jobright. They do not submit employer applications.

For a fresh Windows checkout, run `.\setup.cmd` to download and checksum-verify Node.js 24, install locked dependencies, and install Chromium. On other platforms with Node.js 24, use `npm ci` and `npm run browsers:install`.

Copy `.env.example` to `.env` for a fresh setup and set `JOBRIGHT_EMAIL` and `JOBRIGHT_PASSWORD`. This workspace already has local credentials configured. `.env`, sessions, diagnostics, runtime downloads, and database files are ignored by Git.

`BROWSER_CHANNEL` defaults to bundled `chromium`; `chrome` or `msedge` selects an installed browser. This workspace's private configuration selects headless Chrome, which was used for live verification. `--headed` opens a visible browser when needed.

## Useful commands

```powershell
# Authenticate and persist the session
.\npm.cmd run login -- --site jobright --headed

# Read and save one job without updating its website status
.\npm.cmd run start -- --site jobright --transport browser --limit 1 --read-only

# Read, save, and mark one job, then exit
.\npm.cmd run start -- --site jobright --transport api --limit 1

# Compare one job through both transports; prefer a multi-location job
# This does not change application status or overwrite stored jobs.
.\npm.cmd run compare -- --site jobright

# Inspect a job and save redacted network diagnostics without marking it
.\npm.cmd run inspect -- --site jobright

# Export SQLite records
.\npm.cmd run export -- --site jobright --format json
.\npm.cmd run export -- --site jobright --format csv

# Run local tests, with no Jobright credentials or network access required
.\npm.cmd test
```

Without `--limit`, runs continue until stopped. Empty recommendations are polled every 30 seconds. The default interval between jobs is two seconds. Current account filters are preserved. Set `JOB_INTERVAL_MS`, `EMPTY_POLL_MS`, and `NAVIGATION_TIMEOUT_MS` in `.env` to change these values.

## SQLite and flexible details

The primary database is `data/jobs.sqlite`, using WAL and foreign keys. `DATA_DIR` changes its location.

| Table | Contents |
| --- | --- |
| `jobs` | Connection-scoped source job ID, ownership, URL, title, company, timestamps, `details_json`, `raw_json` |
| `job_processing` | Account-specific local processing state, website status, and last error |
| `runs` | Transport, timestamps, outcome, counters, and error |

Both JSON columns are stored as SQLite TEXT with JSON validity checks. Long descriptions are retained without truncation. `details_json` contains description text/HTML, locations, work arrangement, employment type, seniority, compensation, responsibilities, qualifications, skills, benefits, education, experience, sponsorship, company details, application URL, posting information, matching data, and additional metadata. Missing facts stay empty. Relative posting text is preserved in browser mode; API mode preserves the source posting timestamp. Pay currency/period are populated only when explicitly provided.

The normalized fields are shared, while transport-specific detail objects may contain more information: browser mode retains rendered text/HTML and company sections; API mode retains structured source fields. API responses include the complete job and company payload in `raw_json`. Browser mode also preserves a redacted job-specific network snapshot when available. Skills are normalized to names in both modes; source skill scores remain in raw API data and matching metadata.

Example SQLite query:

```sql
SELECT source_job_id, title, company,
       json_extract(details_json, '$.workArrangement') AS work_arrangement,
       json_extract(details_json, '$.qualifications.required') AS requirements
FROM jobs
WHERE site = 'jobright';
```

JSON/CSV exports are derived from SQLite. CSV includes JSON-encoded detail columns to avoid losing nested information.

## Jobright endpoints observed from the browser

| Operation | Request |
| --- | --- |
| Recommendations and complete job/company payloads | `GET /swan/recommend/list/jobs` |
| Mark Already applied | `POST /swan/job/apply` with `{ "jobId": "...", "source": 0 }` |
| Verify Applied membership | `POST /swan/job/applied/jobs-v3` with `{ "cursor": null, "pageSize": 20, "applyStatus": 0 }` |

Recommendations use `refresh`, `sortCondition=0`, `position`, `count=20`, and `syncRerank=false`. Later pages use increasing positions. Applied history returns `list`, `cursor`, and `hasMore`.

The recommendation response already supplies the job summary, responsibilities, qualifications, benefits, matching information, and company details shown on the detail page. A separate detail XHR was not observed, so API detail retrieval normalizes the corresponding job payload from this response instead of inventing another endpoint.

API mode uses the authenticated browser context's cookie jar. Only authentication uses browser navigation; API job operations never silently fall back to scraping. These are observed website endpoints and can change. Changed response shapes fail clearly.

Sanitized diagnostics are stored in `artifacts/<site-account>/<run-time>/network.jsonl` and `endpoint-catalog.json`. Credential requests, analytics, and unrelated profile endpoints are excluded. Sensitive fields, live tokens, cookies, emails, account IDs, and pagination cursors are redacted. Diagnostic response history in memory is bounded; the full diagnostic stream remains on disk.

## Recovery and stopping

Processing follows `saved → mark_pending → mark_confirmed`. A failed extraction or SQLite write prevents the website update. Pending updates are verified before new work on restart. An ambiguous update is never blindly retried or repeated through the other transport.

API verification searches the Applied history by cursor within a bounded time. Absence from Applied is treated as uncertain: a job might have moved to another tracking category. The runner pauses rather than asserting it was never applied. Browser recovery checks the Applied view and also pauses if membership cannot be confirmed.

Recover an uncertain record by inspecting its actual Jobright status and the `job_processing` row. The runner deliberately does not reset pending records automatically. A safe manual reset to `saved` requires confirming that the prior update did not occur.

Ctrl+C stops scheduling jobs and prevents new status clicks. An already-sent update receives bounded verification; unresolved updates remain pending for restart. In-flight navigation may take up to its configured timeout. Authentication errors, rate limits, schema changes, and uncertain writes stop the run with a nonzero exit code; ordinary job extraction failures are retried and then skipped for that run.

## Add a website plugin

```powershell
.\npm.cmd run plugin:create -- --id another-site
```

Implement the generated plugin under `plugins/another-site/` and add site-specific credentials (`ANOTHER_SITE_EMAIL`, `ANOTHER_SITE_PASSWORD`) to `.env`. The registry loads plugins by ID and validates their interface and declared capabilities.

Each transport implements:

```js
authenticate(context)
listJobs(context, { excludeIds })
getJobDetails(context, job)
markAsApplied(context, job)
getApplicationStatus(context, job)
```

`context` supplies `page`, browser `context`, authenticated `http`, `saveSession`, `hasSession`, `credentials`, `config`, `log`, `recorder`, and an abort `signal`. Status verification also receives a `deadline`. A status method returns `applied`, `not_applied` only when explicitly established, or `unknown`.

Return list items with stable string IDs and URLs. Details must include matching `id`, `url`, nonempty `title`, optional `company`, `details.description.text`, the common metadata fields, and optional `raw`. Listing must advance past `excludeIds` without changing account filters. Keep selectors, response mapping, and site-specific validation inside the plugin. The core alone controls persistence and processing order.

Declare supported transports and operations in plugin metadata. The generated template supports read-only scaffolding until its methods are implemented. Add `markAsApplied` and `getApplicationStatus` to declared operations only after verification is implemented. Unsupported writes are rejected before execution.

## Tests

Fixtures exercise real headless browser login, session reuse, detail extraction, expanded locations, closing details, dropdown updates, cookie-authenticated HTTP requests, pagination, transport parity, schema changes, session expiry, and a dropped write response. Core tests cover SQLite JSON round trips, account isolation, deduplication, persistence failures, pending recovery, interruption, locks, and secret redaction. Tests never connect to Jobright or mutate its real account.
