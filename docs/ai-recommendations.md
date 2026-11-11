# AI specialization recommendations

Administrators can categorize their own collected jobs into each profile's specialization titles. Open **Profiles → Manage specializations**, enter a **Specialization rule prompt**, select an enabled **AI provider** and JSON-capable **AI model**, and save. No model is selected automatically. See [provider setup](ai-generation.md) to configure server keys and exact model IDs; the shipped allowlists are empty.

A rule might say: “Choose SRE for reliability, observability and incident response; Platform Engineer for internal developer platforms; DevOps Engineer for CI/CD and infrastructure delivery.” Add those specialization titles to the same profile first. Rules contain at most 8,000 characters; a blank rule disables recommendations. Clear AI settings removes both the rule and model. Settings stay separate from encrypted job-site credentials and remain editable during collection.

## Run from collected jobs

Apply job-list filters, then click **AI Recommendation**. The operation includes all matching jobs across every page, including jobs with existing preferred titles. It snapshots job IDs and title-selection revisions when queued. Changing filters or pagination afterward does not change that operation, and newly collected jobs wait for the next operation.

Each job uses its own profile's saved rule/model and active specializations. Profiles without prompts are skipped. Missing models, unavailable provider configuration, missing active titles, and more than 99 active titles produce explicit skipped reasons. The 99-title bound follows the portable JSON schema's 100-enum-value limit, including null.

AI receives up to **10 jobs per request**, grouped by profile. Each job includes its database `jobId`, title, company, description text, responsibilities, required/preferred qualifications and skills. The system message includes that profile's captured rule, active title IDs/names, and generated JSON schema; the user message is `{ "jobs": [...] }`. Profiles are never combined, even if their model choices match. The final partial batch runs immediately. Raw source records, account email, credentials and unrelated metadata are excluded. This supplied job content is sent to the configured provider; its handling follows that provider/account's policies.

Requests are packed within the existing 256 KiB generation-input limit using UTF-8 byte counts. Large groups are split before dispatch, without truncation, summarization or repair calls. A job that cannot fit by itself is marked failed with `INPUT_TOO_LARGE`. The existing default 2,048 output-token allowance and configured timeout are unchanged. Twenty-three eligible jobs from one profile normally require three calls: 10, 10 and 3; large descriptions can require smaller groups. Profile rules remain classification criteria, while the batch schema determines the output format.

The locally validated result contains only:

```json
{
  "results": [
    { "jobId": 101, "specializationId": "active-title-id" },
    { "jobId": 102, "specializationId": null }
  ]
}
```

Each submitted job must appear exactly once. Result order is irrelevant; the backend maps by `jobId`. A closed schema restricts job IDs to the submitted batch and specialization IDs to that profile's captured active titles or null. Missing, duplicate, unexpected or invalid results reject the whole response before any selections are saved. Every submitted job in that response is marked failed, and processing continues without retrying the generation. The result array remains inside an object to preserve the portable provider JSON contracts.

An actual specialization ID replaces the Preferred title automatically. The same ID counts as unchanged. Null counts as no match and leaves the current selection intact. Archived, foreign-profile or invented IDs are never applied. Scraped job titles, assignment timestamps, company flags and Jobright tracking do not change; this performs no job-site requests or employer applications.

Manual dropdowns remain available. A manual selection after enqueueing increments a revision, so an in-flight or pending AI result cannot overwrite it, including a change away from and back to the same value. Re-scraping preserves that revision and selection. Profile rules/models/title labels are captured in memory once execution starts; edits affect subsequent operations. Before saving, the chosen title must still be active on that exact profile.

## Progress, cancellation and recovery

The API queues work and returns immediately. The backend coordinator claims up to ten pending jobs from one profile, ordered by job ID, and uses asynchronous HTTP through the shared AI service and database-worker RPCs. It does not consume scraper workers or account locks. There are at most two active recommendation operations globally, one per administrator, with one batch generation at a time per administrator. Generic generation endpoints and recommendations share the AI service's two global generation slots. Recommendations wait for capacity without replaying any dispatched generation. Already changed selections and ineligible profiles are skipped before dispatch.

Validated batch results commit in one short transaction. Ownership, operation status, title availability and selection revisions are checked again; individual results made stale by manual edits or title archiving are skipped while other eligible selections commit. Persistence failures roll back the batch's title, revision, item-state and counter updates, fail the operation, and never replay the AI call. Shutdown/recovery handles all working items in the batch using the existing lifecycle; no schema migration is needed for batching.

The job page shows total/processed progress, updated/unchanged/no-match/skipped/failed counters, issues, and Stop. Counters represent jobs, not requests, and update after batch commits. Progress restores after navigation or reload and polls every two seconds while visible and active. Saved title changes refresh job queries. A duplicate click attaches to the existing operation.

States are `queued`, `running`, `stop_requested`, `completed`, `stopped`, `failed`, and `interrupted`. Refusals, malformed outputs, timeouts and other non-systemic generation failures fail the submitted batch and processing continues. Provider authentication, rate-limit and configuration failures during generation stop the operation. Completed operations can contain skipped/failed items; counters explain the result.

Stop immediately ends queued work or aborts an active generation. Committed selections remain; cancelled/incomplete calls are never replayed. Service shutdown closes the recommendation coordinator before AI/database resources. Queued operations survive restart; previously running work becomes interrupted and is not automatically resumed. Click AI Recommendation again to explicitly start a new snapshot, which can reclassify previously processed jobs.

## API and storage

All endpoints below require an administrator session, existing Origin checks for mutations, and owner-scoped access. Administrators cannot operate on another user's profiles/jobs or view their operations.

| Endpoint under `/api/v1` | Behavior |
| --- | --- |
| `PATCH /connections/:id` | Partial updates including nullable `specializationPrompt` and `specializationModel: {provider,id}`; ordinary users can still edit person names, but cannot update AI settings |
| `POST /ai/recommendations` | `{ "filters": { ...sharedJobFilters } }`; returns HTTP 202 with the operation |
| `GET /ai/recommendations/latest` | Active or latest operation, or null |
| `GET /ai/recommendations/:id` | Operation status, timestamps, counters, `errorCode` and grouped `issues: [{code,count}]` |
| `POST /ai/recommendations/:id/stop` | Idempotent stop request; returns current progress |

Connection responses include the nullable prompt and model target. A non-null model must be enabled, configured and JSON-capable when saved. State-changing mutations are never retried automatically. A duplicate operation returns `409 RECOMMENDATION_EXISTS` with `error.details.recommendationId`. Filters use the shared job-filter schema, including profile, preferred title, company blacklist, dates and scores; pagination/sorting parameters are not accepted in the start body.

Example profile configuration:

```json
{
  "specializationPrompt": "Choose the most suitable active role. Return no match when none fits.",
  "specializationModel": { "provider": "openai", "id": "EXACT_ALLOWLISTED_MODEL_ID" }
}
```

Example start:

```json
{ "filters": { "connectionId": "profile-id", "excludeBlacklistedCompanies": true } }
```

Schema version 8 adds nullable prompt/model configuration to connections, `jobs.preferred_title_revision`, `ai_recommendations`, and `ai_recommendation_jobs`. Migration is transactional and retains supported earlier paths, including dormant tables from the recognized reverted feature. Jobs, company links, long JSON, assignments, pending tracking and existing preferred titles are preserved. Old records start with no AI settings and revision zero.

Operation history stores IDs, expected revisions, lifecycle, timestamps, counters and static error codes. It does not store constructed prompts, copied job context, raw generation results or explanations. The profile rule is intentionally persistent configuration. The standalone AI module remains stateless and logs only sanitized operational metadata.

## Verification

Run the standard backend, frontend component, production-build and browser-workflow commands in the [documentation index](README.md). Recommendation fixtures cover all four native providers, partial profile editing, permissions, snapshot membership, replacement/no-match, model eligibility, filtered pages, manual changes, title archiving, concurrent administrators, capacity waiting, shutdown/restart, oversized input and content redaction. Browser tests use temporary accounts/databases and localhost provider fixtures; no paid calls or real Jobright updates occur.
