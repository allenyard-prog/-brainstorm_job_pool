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

## Adding another website

```powershell
.\npm.cmd run plugin:create -- --id another-site
```

The scaffold creates `index.js` and `browser.js` under a new plugin directory. IDs use lowercase letters, digits, and hyphens and begin with a letter. Authentication/list/detail methods initially throw `UnsupportedError`; the scaffold is not a functional scraper until implemented.

Implement browser behavior first. Keep unsupported status methods present, but declare only supported operations. Add `markAsApplied` and `getApplicationStatus` capabilities together after update and verification behavior is implemented. Add `api.js` and its transport metadata when confirmed requests are available.

For CLI use, local credentials follow `<SITE_ID>_EMAIL` and `<SITE_ID>_PASSWORD`, uppercasing the ID and replacing hyphens with underscores. For backend use, add the plugin ID to the service's `sites` configuration/allowlist; filesystem presence alone does not enable it in connection creation or the capabilities endpoint. Backend users then create their own encrypted connections through the API/UI.

Add fixture coverage for login/session expiry, detail identity, long/missing fields, pagination, disappearing cards, verified updates, uncertain writes, cancellation, and transport parity. Regression tests must not authenticate to or update the real source account.
