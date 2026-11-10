# Website plugins

Each website owns its authentication, selectors, API requests, pagination, normalization, and status verification. Shared infrastructure owns browsers, recording, persistence, concurrency, cancellation, and run lifecycle.

Jobright implements both browser and API transports. The API uses requests confirmed during browser execution; it does not silently fall back to DOM scraping when an endpoint changes.

For a guided implementation workflow, invoke `$jobright-browser-to-api` in Codex and describe the Jobright behavior to add. The versioned skill source is [`skills/jobright-browser-to-api/`](../skills/jobright-browser-to-api/); its `SKILL.md` covers browser-first discovery, network evidence, API implementation, and verification. For example: "Use $jobright-browser-to-api to add the requested recommendation filter to the browser and API transports." The skill itself performs no website action until invoked for a concrete task.

## Plugin layout and metadata

```text
plugins/jobright/
  index.js       Plugin identity, capabilities, and transport map
  auth.js        Shared browser-assisted login/session handling
  browser.js     Rendered extraction and UI tracking updates
  api.js         API listing/details/tracking/verification
  http.js        Website-specific authenticated request validation
  normalize.js   Common detail defaults and API normalization
```

Jobright metadata follows this structure:

```js
export default {
  id: 'jobright',
  name: 'Jobright',
  capabilities: {
    transports: ['browser', 'api'],
    authentication: 'browser',
    operations: [
      'listJobs',
      'getJobDetails',
      'markAsApplied',
      'getApplicationStatus',
    ],
  },
  transports: { browser, api },
};
```

The registry validates plugin identity, transport availability, required functions, and verified-write capabilities. `/api/v1/sites` exposes enabled plugin names, transports, and operations to the frontend without credentials.

## Transport contract

Every transport supplies these asynchronous methods:

```js
authenticate(context)
listJobs(context, { excludeIds })
getJobDetails(context, job)
markAsApplied(context, job)
getApplicationStatus(context, job)
```

| Method | Responsibility |
| --- | --- |
| `authenticate` | Reuse a valid session or sign in; save refreshed session state |
| `listJobs` | Return candidates with stable string IDs/URLs in source order; advance past excluded IDs |
| `getJobDetails` | Return normalized content for the selected ID; preserve full description and available metadata |
| `markAsApplied` | Perform the intended tracking change once; leave persistence and retry policy to the runner |
| `getApplicationStatus` | Verify status within the supplied deadline; return `applied`, explicitly established `not_applied`, or `unknown` |

`context` supplies the Playwright `page`, browser `context`, authenticated `http` client, `saveSession`, `hasSession`, credentials, configuration, recorder, logger, and abort signal. Status verification receives a separately bounded signal and deadline so an already-sent update can be checked during cancellation.

Details use this envelope:

```js
{
  id: 'stable-source-id',
  url: 'https://example.test/jobs/stable-source-id',
  title: 'Example role',
  company: 'Example company',
  details: {
    description: { text: 'Complete description', html: null },
    // Other common fields follow the data model.
  },
  raw: null,
}
```

The detail ID must match the selected candidate. Keep missing optional values empty, retain source-specific fields in `extra`/`raw`, and use the [common data model](data-model.md#job-content). Do not save jobs, create runs, or change processing rows from plugin methods.

## Browser-first discovery and API integration

1. Implement authentication and recommendation listing against a local fixture, then verify authorized website behavior.
2. Open a job, expand relevant sections, and extract complete content. Inspect close selectors rather than assuming a CSS class is an ID.
3. After the runner commits the job, return to the list, locate its card by stable ID, scope the dropdown to that card, and perform the intended tracking update.
4. Record relevant first-party requests/responses during these intended actions. Exclude credential requests, unrelated account data, and analytics; redact secrets and identifiers from diagnostic output.
5. Implement API operations from confirmed request methods, payloads, pagination, and response shapes. Capture a status change during its intended execution; do not repeat a write merely to discover an endpoint.
6. Compare both transports for the same job using the read-only comparison command and fixture tests.

An API detail operation does not require a separate detail endpoint. Jobright currently normalizes the full corresponding job/company payload returned by recommendations. Verification searches Applied history with cursor pagination; absence alone is uncertain, not proof that no update happened. Observed endpoint details are recorded in the [root README](../README.md#jobright-endpoints-observed-from-the-browser).

Preserve the user's source filters. Re-query changing lists after tracking updates because cards can disappear. Honor exclusions without repeatedly returning an already handled first page. Leave job intervals, empty-list polling, and extraction retry policy to the shared runner.

## Jobright navigation and authentication

Jobright can show a valid authenticated account while a deferred/background asset prevents `DOMContentLoaded` from firing. The shared browser/API login waits for the main document to commit, then checks visible Jobright controls. Detail/list/Applied navigation uses the same readiness helper. HTTP success alone is not accepted as proof of authentication.

Main-document reads allow at most three attempts for transient network failures and 5xx responses, bounded by `NAVIGATION_TIMEOUT_MS` and any verification deadline. Commits wait at most 15 seconds per attempt; readiness uses the remaining overall budget. Authentication failures, verification challenges, rate limits, and unsupported pages receive explicit errors. Credential submissions and tracking updates are never automatically retried.

On fresh sign-in, the server-rendered **SIGN IN** button may appear before React attaches its click handler. Login retries only opening that dialog within the configured timeout, checks for usable email/password controls after each activation, and waits without reactivating the trigger once a dialog is visible. Credentials are submitted once after the dialog is ready. A dialog that never becomes interactive produces a specific error stating that no credentials were submitted. Both transports share this behavior; cancellation interrupts the wait.

Stop interrupts a held navigation by closing that page, keeping its authenticated HTTP context available for reconciliation. Uncertain tracking updates retain the existing pending-state policy. New scraper processes load plugin code on startup, so use **Retry run** for a failed collection after this repair. Terminal escape sequences are stripped from newly recorded errors.

Fixtures cover stalled deferred scripts, HTTP-success pages without account controls, transient document failures, rejected credentials, and managed-worker cancellation. Live read-only verification on November 10, 2026 confirmed both transports reused the affected saved session in under three seconds while `DOMContentLoaded` remained pending. An API read returned 20 recommendations with no tracking changes. Live browser-mode listing found no job cards, so browser extraction parity remains fixture-verified only. No new website endpoints were introduced.

Fresh sign-in fixtures also cover delayed hydration for both transports, a partially rendered dialog, bounded failure, single credential submission on rejection, and cancellation. A separate live fresh-browser check on November 10, 2026 opened the empty sign-in dialog after two trigger activations in approximately six seconds. It submitted no credentials and made no tracking updates; successful account authentication remains fixture-verified for this specific repair.

## Adding another website

```powershell
.\npm.cmd run plugin:create -- --id another-site
```

The scaffold creates `index.js` and `browser.js` under a new plugin directory. IDs use lowercase letters, digits, and hyphens and begin with a letter. Authentication/list/detail methods initially throw `UnsupportedError`; the scaffold is not a functional scraper until implemented.

Implement browser behavior first. Keep unsupported status methods present, but declare only supported operations. Add `markAsApplied` and `getApplicationStatus` capabilities together after update and verification behavior is implemented. Add `api.js` and its transport metadata when confirmed requests are available.

For CLI use, local credentials follow `<SITE_ID>_EMAIL` and `<SITE_ID>_PASSWORD`, uppercasing the ID and replacing hyphens with underscores. For backend use, add the plugin ID to the service's `sites` configuration/allowlist; filesystem presence alone does not enable it in connection creation or the capabilities endpoint. Backend users then create their own encrypted connections through the API/UI.

Add fixture coverage for login/session expiry, detail identity, long/missing fields, pagination, disappearing cards, verified updates, uncertain writes, cancellation, and transport parity. Regression tests must not authenticate to or update the real source account.
