# Backend API service

The backend supports multiple users on one Windows computer. It binds to `127.0.0.1:3000`, uses the existing SQLite database, and runs scraping in separate processes. No frontend UI is included.

## Initialize and run

Stop any existing CLI scraper before the first schema upgrade. Then run:

```powershell
# Prompts for the first backend administrator's email and password.
# Imports accounts configured in .env and assigns their legacy records to that admin.
.\npm.cmd run service:init -- --import-legacy

# Start API and background-run supervisor.
.\npm.cmd run service
```

Omit `--import-legacy` to leave old records unassigned and invisible to API users. Import can be completed later by rerunning initialization with the same administrator credentials and `--import-legacy`. The existing CLI continues working; imported accounts are identified by their existing account keys.

The first legacy schema upgrade creates `data/jobs.sqlite.pre-service.bak`. Migration preserves job IDs, full JSON, processing states and historical runs. Where legacy accounts shared one job row, it creates separate account copies. Import claims only the accounts configured in the local environment, never another user's new connection. Legacy sessions are copied into their new connection-specific directory.

Initialization generates a random `SERVICE_ENCRYPTION_KEY` in the ignored `.env`. Keep this key with your private database backups: losing it prevents decryption of job-site passwords. Do not change it after creating connections. Backend passwords are hashed with asynchronous scrypt; sessions are revocable and expire after 24 hours. For unattended initialization, supply `SERVICE_ADMIN_PASSWORD` in the environment instead of a command-line password.

Open **http://127.0.0.1:3000/docs** for interactive OpenAPI documentation and **http://127.0.0.1:3000/docs/json** for the specification. Use the exact `127.0.0.1` origin; `localhost` is a different browser origin.

Backend authentication and job-site authentication are separate. Signing in to this API does not automatically authenticate a Jobright account. Each user adds their own connection and queues its authentication or collection operation. A collection run can authenticate as part of its normal workflow.

## Endpoints

All application endpoints are under `/api/v1`. Cookies have `HttpOnly`, `SameSite=Strict` and `Path=/api/v1`; `Secure` is disabled for this loopback HTTP deployment. Write requests must include `Origin: http://127.0.0.1:3000`. No cross-origin browser access is enabled by default.

| Endpoint | Result |
| --- | --- |
| `POST /auth/login` | Sign in with email/password and set a session cookie |
| `POST /auth/logout` | Revoke the current session and clear its cookie |
| `GET /auth/me` | Current user without password/session material |
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

`GET /jobs` accepts `limit` (default 20, maximum 100), opaque `cursor`, `connectionId`, `site`, title/company search `q`, and processing `status` (`saved`, `mark_pending`, `mark_confirmed`). Summaries exclude large detail/raw columns. Run history supports the same page-size limits and an opaque cursor. List responses contain `items` and `nextCursor`. Poll run details and events every two seconds for a future dashboard.

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

Request/response schemas are included in OpenAPI. A remote deployment, public registration, frontend UI, scheduling, and distributed workers are outside this version.

## Verification

Run `.\npm.cmd test`. Tests use temporary databases, managed fixture processes, and a local Jobright-shaped website. They cover authentication, expiry, rate limiting, ownership, encryption/tampering, pagination, limits, async API responsiveness, graceful and forced stops, crashes, restart recovery, pending-write retries, schema migration and real browser/API workers. They never authenticate to or update the real Jobright account.
