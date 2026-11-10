# Backend API service

The backend supports multiple users on one Windows computer. It binds to `127.0.0.1:3000`, uses the existing SQLite database, and runs scraping in separate processes. A React dashboard manages profiles, collection runs, collected jobs, and backend users.

## Initialize and run

Stop any existing CLI scraper before the first schema upgrade. Then run:

```powershell
# Prompts for the first backend administrator's email and password.
# Imports accounts configured in .env and assigns their legacy records to that admin.
.\npm.cmd run service:init -- --import-legacy

# Build the dashboard, then start Fastify and the background-run supervisor.
.\npm.cmd run web:build
.\npm.cmd run service
```

Omit `--import-legacy` to leave old records unassigned and invisible to API users. Import can be completed later by rerunning initialization with the same administrator credentials and `--import-legacy`. The existing CLI continues working; imported accounts are identified by their existing account keys.

The first legacy schema upgrade creates `data/jobs.sqlite.pre-service.bak`. Migration preserves job IDs, full JSON, processing states and historical runs. Where legacy accounts shared one job row, it creates separate account copies. Import claims only the accounts configured in the local environment, never another user's new connection. Legacy sessions are copied into their new connection-specific directory.

Initialization generates a random `SERVICE_ENCRYPTION_KEY` in the ignored `.env`. Keep this key with your private database backups: losing it prevents decryption of job-site passwords. Do not change it after creating connections. Backend passwords are hashed with asynchronous scrypt; sessions are revocable and expire after 24 hours. For unattended initialization, supply `SERVICE_ADMIN_PASSWORD` in the environment instead of a command-line password.

Open **http://127.0.0.1:3000** and sign in with your backend account. Interactive OpenAPI documentation remains at **http://127.0.0.1:3000/docs**; the specification is at **http://127.0.0.1:3000/docs/json**. Use the exact `127.0.0.1` origin; `localhost` is a different browser origin.

Backend authentication and job-site authentication are separate. Signing in to this API does not automatically authenticate a Jobright account. Each user adds their own connection and queues its authentication or collection operation. A collection run can authenticate as part of its normal workflow.

## React dashboard

The frontend is a JavaScript/JSX npm workspace in `web/`, using React, Vite, React Router, TanStack Query, and CSS design tokens. Run `.\npm.cmd install` after updating the checkout; dependencies share the root lockfile. Fresh installations use the existing `setup.cmd` workflow.

- **Overview:** active and queued operations, counters from the current run, recent runs, and recent jobs. The displayed recent records are not global totals.
- **Profiles:** a profile is your saved job-site connection. Add an account, authenticate it, replace its password, or open filtered jobs/history. Account email stays fixed; add another profile for a different identity. Credential changes are disabled while work is queued or active. Visible-browser sign-in is available for local verification.
- **Collection runs:** choose a profile, browser/API transport, and a finite limit or continuous operation. **Mark saved jobs as Already applied** defaults to enabled. Clear it to save without changing the job-site tracking status. Stop and retry operate on the backend's durable queue.
- **Collected jobs:** search titles/companies and open **Filters** for company name, posted/first-registered calendar dates, total/skill/industry match ranges, profile, website, and Tracking. Apply commits drawer edits; Reset clears the draft; Cancel/Escape discards it. Applied chips and cursor pagination live in the URL. Registered means first saved, while legacy collected-time links still use the latest scrape. **Assign all Jobs**, **Copy Available Jobs**, and **Download CSV** use the same filters across every page. Assignment remains local and separate from Jobright tracking. Copying produces Company Name, Job Title, and employer application Link columns for Google Sheets; select Available or Assigned to restrict the set. CSV retains detail JSON and assignment timestamps; raw JSON and secret fields are excluded. Details render scraped content as text and only allow HTTP/HTTPS links. See [advanced filters](job-filters.md) for range semantics and migration details.
- **Users:** administrators can create/list backend users, but cannot browse another user's jobs or profiles.
- **Companies:** click **Sync companies** to build a private company directory from existing jobs, view processed/total progress, then browse company metadata and linked roles. Assignment and Jobright tracking stay separate. Sync is manual and makes no website requests. See the [company guide](companies.md).

The dashboard and active run details poll every two seconds while visible. Run details stop polling on terminal status; events load incrementally and retain at most 500 rendered entries. Session cookies are managed by the browser. Passwords and authentication tokens are never saved in localStorage. Logout/session changes cancel requests and clear user-specific caches; expired sessions return to the originally requested route after sign-in.

For development, use two terminals:

```powershell
# Terminal 1
.\npm.cmd run service

# Terminal 2
.\npm.cmd run web:dev
```

Open **http://127.0.0.1:5173**. Vite proxies `/api`, `/health`, and `/ready` to Fastify. It rewrites the Origin header only for requests originating from that exact trusted frontend origin; the backend's origin validation remains enabled. `WEB_API_TARGET` may select another `http://127.0.0.1:<port>` backend for development/tests.

For production, rebuild after frontend changes and restart the service if the build was absent at startup. Fastify serves `web/dist/`, including direct refreshes on `/runs/:id` and `/jobs/:id`. Missing assets and API resources retain real JSON 404 responses. API-only startup remains supported when no frontend build exists. Generated builds are ignored by Git.

## Endpoints

All application endpoints are under `/api/v1`. Cookies have `HttpOnly`, `SameSite=Strict` and `Path=/api/v1`; `Secure` is disabled for this loopback HTTP deployment. Write requests must include `Origin: http://127.0.0.1:3000`. No cross-origin browser access is enabled by default.

| Endpoint | Result |
| --- | --- |
| `POST /auth/login` | Sign in with email/password and set a session cookie |
| `POST /auth/logout` | Revoke the current session and clear its cookie |
| `GET /auth/me` | Current user without password/session material |
| `GET /sites` | Enabled website plugins, names, transports, and supported operations |
| `POST /company-syncs` | Queue manual company synchronization; returns `202` |
| `GET /company-syncs/latest`, `GET /company-syncs/:id` | Restore/retrieve owned sync progress |
| `GET /companies`, `GET /companies/:id` | Search/paginate company summaries or retrieve full details |
| `POST /users` | Administrator creates a user; password minimum 12 characters |
| `GET /users` | Administrator lists users |
| `POST /connections` | Save a site account using `site`, `email`, `password` |
| `GET /connections` | List only the current user's connection status |
| `PATCH /connections/:id/credentials` | Replace credentials for the same account; clears its saved browser session |
| `POST /connections/:id/authenticate` | Queue login; optional `{ "headed": true }` for local interactive verification |
| `POST /runs` | Queue a collection run |
| `GET /runs`, `GET /runs/:id` | Paginated history or current progress |
| `POST /runs/:id/stop` | Persist cancellation and return `202` |
| `POST /runs/:id/retry` | Create a linked retry with the same options |
| `GET /runs/:id/events?after=0&limit=50` | Sanitized event stream with an integer cursor |
| `GET /jobs` | Paginated summaries; filters below |
| `GET /jobs/export` | CSV attachment containing all jobs matching the same filters, without cursor/limit parameters |
| `POST /jobs/assign` | Mark all jobs matching the body filters as Assigned; returns `assignedCount` |
| `GET /jobs/clipboard` | Tab-separated Company Name, Job Title, employer application Link table for all jobs matching the filters |
| `GET /jobs/:id` | Full parsed detail JSON |
| `GET /jobs/:id?includeRaw=true` | Include job-specific raw source JSON with secret fields redacted |
| `GET /health` | Process liveness, without authentication |
| `GET /ready` | Database readiness; returns `503` if unavailable |

Queued operations return their run resource with HTTP `202`; they do not wait for browser startup or scraping. Errors use `{ "error": { "code": "...", "message": "...", "details": {} } }`. Duplicate queued/active work for a connection returns `409 RUN_EXISTS` with the existing `runId`. Ownership failures return `404`; knowing a resource ID grants no access, including to administrators.

Example collection body:

```json
{
  "connectionId": "connection-id",
  "transport": "api",
  "readOnly": false,
  "limit": 100
}
```

Defaults are `transport: "browser"`, `readOnly: false`, and an unlimited run when `limit` is omitted or null. Non-read-only runs save jobs and mark them **Already applied** in the job site; they do not submit employer applications. API mode never silently falls back to browser scraping.

`GET /jobs` accepts `limit` (default 20, maximum 100), opaque `cursor`, `connectionId`, `site`, title/company search `q`, processing `status` (`saved`, `mark_pending`, `mark_confirmed`), and optional inclusive `collectedFrom`/`collectedTo` ISO 8601 timestamps with a time zone. Time filters compare `lastScrapedAt`; reversed or invalid ranges return `400`. Summaries exclude large detail/raw columns. `GET /jobs/export` accepts the same filters without pagination and streams the matching CSV in batches of 100. It requires the same session and owner scope as the list, including for administrators. CSV timestamps are UTC; spreadsheet formula prefixes in scraped strings are escaped. Run history supports the same page-size limits and an opaque cursor, plus `connectionId` and lifecycle `status` filters. `status=active` includes queued, starting, running, and stop-requested operations. List responses contain `items` and `nextCursor`.

The jobs `status` filter also accepts `assigned` and `available`. Assigned jobs appear under `assigned`; `available` and the three processing-state filters exclude assigned jobs. Omitting `status` includes both. `/jobs/assign` accepts the same filters in a JSON body, without pagination; the update is atomic and owner-scoped, and reassigning already assigned jobs returns zero new assignments. `/jobs/clipboard` accepts the same query filters without pagination and copies the exact matching set, including assigned jobs when they match. It streams three columns in batches of 100, flattens embedded tabs/newlines inside cells, and escapes spreadsheet formula prefixes. Neither operation changes Jobright tracking or the scraper's processing state.

The clipboard **Link** column uses the stored `details.applicationUrl`, pointing to the employer/ATS application page. Missing, invalid, non-HTTP(S), or Jobright URLs produce an empty Link cell; copying never falls back to the Jobright posting. Only the application URL field is projected from metadata for clipboard requests. CSV exports retain their existing source `url` column.

## Architecture and lifecycle

The Fastify process handles HTTP and supervision. A persistent database worker thread executes its synchronous SQLite operations, so database waits do not block the HTTP event loop. Each scraping/authentication operation is a child process with its own SQLite connection, browser, account lock and abort controller. SQLite uses WAL and short transactions. Site passwords are encrypted with AES-256-GCM and bound to their user/site/account identity.

Two workers run globally by default (`WORKER_CONCURRENCY`), with at most one per user. The same source account is serialized across users. Existing CLI operations share the account filesystem lock: a worker defers for five seconds when that account is already in use. A separate service lock prevents competing API supervisors on the same data directory. Backend workers inherit only necessary OS/browser environment variables, not all configured accounts or the service encryption key.

```text
queued -> starting -> running -> completed
                      |
                      +-> stop_requested -> stopped

Other terminal outcomes: failed, attention_required, interrupted
```

`attention_required` includes expired authentication and uncertain external updates. Workers publish progress/heartbeats at least once per second and persist critical per-job states immediately. These per-job states remain separate from run lifecycle.

Stopping a queued run prevents process startup. Stopping active work sends IPC cancellation, stops new jobs, and allows bounded reconciliation of an already-sent source update. After 30 seconds, the supervisor terminates only that worker's owned process tree. Forced termination is recorded as `stopped` with `forced: true`; unresolved per-job changes remain pending. Requests to stop an already terminal run are harmless.

Queued work survives restarts. Abandoned managed runs become `interrupted`; active external writes are never automatically replayed. Workers abort when their parent disconnects. Retrying a stopped, failed, interrupted or attention-required run creates a new row with `parentRunId`, keeping the old run and events. Pending updates are reconciled before further status changes. Completed runs cannot be retried; start a new run instead.

Browser sessions live under `data/sessions/<user-id>/<connection-id>/`. Diagnostics live under `artifacts/<user-id>/<connection-id>/<run-id>/`. Resource APIs never expose these paths or session files. Credentials cannot be replaced while a connection has queued/active work. Job identity is scoped to the connection because matching data is account-specific.

## Browser and API-tool access

The backend is intended for a same-origin browser frontend. For PowerShell/Postman/curl, keep the session cookie and send the Origin header on writes. A PowerShell example:

```powershell
$api = 'http://127.0.0.1:3000'
$headers = @{ Origin = $api }
$credential = Get-Credential -Message 'Backend account'
$loginBody = @{ email = $credential.UserName; password = $credential.GetNetworkCredential().Password } | ConvertTo-Json
Invoke-RestMethod "$api/api/v1/auth/login" -Method Post -Headers $headers -ContentType 'application/json' -Body $loginBody -SessionVariable backendSession
Invoke-RestMethod "$api/api/v1/connections" -WebSession $backendSession
```

Request/response schemas are included in OpenAPI. Remote deployment, public registration, scheduling, and distributed workers are outside this version.

## Verification

Company summaries/details expose `isBlacklisted`, set by owner-scoped `PATCH /api/v1/companies/:id` with a boolean body field. The drawer's **Exclude blacklisted companies** option defaults to off and maps to shared boolean `excludeBlacklistedCompanies` for listing, export, clipboard, and assignment. Only linked jobs are excluded; synchronize companies to include new jobs in filtering. See [blacklist behavior](companies.md#company-blacklist).

The jobs **Filters** drawer now supports company name, posted/first-registered calendar dates, total/skill/industry score ranges, profile, website, and tracking. See [advanced filter APIs, normalization, and migration](job-filters.md). All applied filters also constrain export, copying, and assignment; legacy collected-time parameters retain their latest-scrape meaning.

Run `.\npm.cmd test`. Tests use temporary databases, managed fixture processes, and a local Jobright-shaped website. They cover authentication, expiry, rate limiting, ownership, encryption/tampering, pagination, limits, async API responsiveness, graceful and forced stops, crashes, restart recovery, pending-write retries, schema migration and real browser/API workers. They never authenticate to or update the real Jobright account.

```powershell
.\npm.cmd run web:test
.\npm.cmd run web:build
.\npm.cmd run web:e2e
```

Frontend component tests cover session changes/expiry, user cache isolation, collection options, filters, and safe detail rendering. Playwright runs the production build against temporary backend databases and fixture workers, covering collection controls, authentication, profile credentials, admin creation, isolation, detail refresh, and mobile layout. It never uses real Jobright credentials. Screenshots are written to the ignored `artifacts/frontend/` directory.
