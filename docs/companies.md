# Company directory and manual synchronization

Open **Companies** in the dashboard to organize company information already stored with your collected jobs. Each user has a private directory spanning that user's job-site profiles. A company can link to many job titles and profiles; other users, including administrators, cannot browse those records.

## Using the directory

Click **Sync companies** to queue synchronization. The page displays status, a progress bar, `processed / total`, and counts of created/refreshed companies, linked/skipped jobs, and identity warnings. Progress is stored in SQLite and restored after navigation or reload. Active progress polls every two seconds while visible.

The sync uses existing local job metadata only. It makes no website requests, changes no assignment or Jobright tracking, and submits no employer applications. There is no cron schedule or automatic startup backfill. Newly collected jobs appear after another manual sync.

Search companies by name or filter by profile. Open a company for its description, website, location, industry, team size, founding year, funding/stage, links, complete metadata, and paginated jobs. Available fields depend on what the source provided. Job rows show local **Assigned/Available** and collection/Jobright tracking independently. Their links open the existing job detail page and retain return navigation.

Company-list counts follow the selected profile. Company-detail summary counts cover all your profiles; its job table can be filtered independently. Counts represent stored job records, including separate records for the same source posting collected through different profiles. **Marked applied** is confirmed website tracking, not proof of employer submission.

## Column sorting

Company-list headers sort the entire filtered directory. Click again to reverse direction. Controls cover Company, Website, Location, Industry, Collected jobs, Assigned, Marked applied, and Blacklist. The last three count fields use current job states and the selected profile; Blacklist orders the saved boolean flag. Sorting does not hide any company or change its status.

`GET /api/v1/companies` accepts `sortBy=id|name|domain|location|industry|jobCount|assignedCount|markedAppliedCount|isBlacklisted` and `sortOrder=asc|desc`. Default ordering remains `id desc`. Text ignores case/outer whitespace, missing values stay last in both directions, and tied values use the company ID in the selected direction. Search/profile filters combine with ordering. For example: `/api/v1/companies?sortBy=jobCount&sortOrder=desc`.

Sorting is stored in the URL and preserved on reload, browser navigation, and return from company details. A sort change resets pagination. Cursor pagination covers all filtered results and rejects cursors from a different sort. Counts and flags can change while navigating pages, so this is a live view rather than a frozen snapshot. The company detail job table retains its existing ordering.

## Company blacklist

Each company row shows **Blacklisted** or **Not blacklisted** and an action to **Blacklist company** or **Remove from blacklist**. Changes apply to the current backend user across all their profiles. The affected row is disabled while saving; failures appear inline without automatic retries or optimistic status changes. Company details also show the status, and blacklisted companies and their related jobs remain visible in the directory.

In **Collected jobs → Filters**, enable **Exclude blacklisted companies** and Apply. The checkbox defaults to off and follows existing URL, draft, reset, cancel, chip, and pagination behavior. The same filter constrains CSV export, clipboard copying, and bulk assignment.

Only existing company links are checked. Newly collected unlinked jobs remain visible even if their name matches a blacklisted company; use **Sync companies** to establish links. Unknown/unlinked jobs remain included. There is no fuzzy matching, automatic sync, scraper skipping, website tracking change, or employer application workflow. “Whitelist” means removing the blacklist flag.

The flag is stored outside company metadata. Sync preserves it. When compatible companies merge, the survivor stays blacklisted if either record was blacklisted; users can explicitly remove the flag afterward. Flag updates leave source metadata and collection/sync timestamps unchanged. Confirmed changes refresh the current user's company/job queries.

## Identity and metadata rules

Company matching uses source company IDs scoped to the source website, official website domains, and normalized name aliases. Names use Unicode normalization, lowercase, and collapsed whitespace. Domains ignore `www.` and case. Arbitrary news/social links are not treated as official identity, and names are not fuzzy matched.

A normalized name can join one compatible company. Stronger evidence can merge compatible provisional records, keeping job links and identifiers. Conflicting source IDs/domains remain separate and produce warnings. Ambiguous name/domain-only records are skipped rather than assigned by guesswork. Missing identities remain unlinked. This version has no manual company editing/merge interface.

Metadata supports browser company `name/text/links` and API `companyName/companyDesc/companyURL` shapes. Each nonempty field carries its original collection timestamp so an older job processed later cannot overwrite newer values. Empty values do not erase useful data; original job JSON remains intact. Full source company fields remain in company metadata, and resource APIs redact secret fields. The UI renders text and permits only HTTP/HTTPS links.

## Background processing and recovery

The service records a sync request before returning `202`. It snapshots the owned-job count and maximum job ID; later job inserts wait for the next manual sync. Metadata updates to an included job are read when its batch runs, rather than holding a long database snapshot transaction.

The company coordinator uses the existing database worker in batches of at most 100 jobs, yielding between batches. Syncs do not consume scraper workers or acquire source-account locks. One sync executes globally, and each user can have only one queued/running request. Duplicate submissions return `409 COMPANY_SYNC_EXISTS` with `details.syncId`; the dashboard attaches to that progress.

```text
queued -> running -> completed
              +--> failed
              +--> interrupted
```

Each batch commits company changes, job links, and progress together. A failed batch rolls back without undoing previous committed batches. On restart, queued requests remain queued and are processed; unfinished running requests become interrupted. Shutdown waits for the current batch and records interruption before closing the database. Click Sync again to reconcile all stored jobs idempotently.

Created/refreshed counters count distinct surviving company records touched by the sync; linked/skipped/warning counters describe processed jobs. Current assignment and confirmed-tracking counts are computed from job rows, so changing those states does not require rebuilding company metadata.

## API

All endpoints require the current backend user's session and retain existing Origin checks on writes.

| Endpoint | Response |
| --- | --- |
| `POST /api/v1/company-syncs` | `202` with durable sync progress |
| `GET /api/v1/company-syncs/latest` | Latest owned sync, or `null` before the first request |
| `GET /api/v1/company-syncs/:id` | Owner-scoped progress and sanitized failure information |
| `GET /api/v1/companies` | Summaries with `items` and `nextCursor`; accepts `q`, `connectionId`, `cursor`, `limit` |
| `GET /api/v1/companies/:id` | Full company metadata and all-profile job counts |
| `PATCH /api/v1/companies/:id` | Set `{ "isBlacklisted": true }` or false; return the updated company summary |
| `GET /api/v1/jobs?companyId=123` | Existing paginated job summaries restricted to that company and user |

Job resources additionally return nullable `companyId` and `companyName`. Shared job filters, assignment, and exports also accept `companyId`. Company page size defaults to 20 with a maximum of 100; cursors follow descending integer company IDs. Company list responses omit large metadata JSON.

## Storage and verification

Schema version 6 adds `companies.is_blacklisted`, constrained to 0/1 and defaulting existing companies to 0. Company summaries/details expose boolean `isBlacklisted`. PATCH requires that boolean and rejects missing, extra, or non-boolean fields. Repeated updates are harmless; another user's company returns 404, including for administrators. Shared job APIs accept boolean `excludeBlacklistedCompanies`: true excludes linked blacklisted companies owned by the requesting user, while false/omission preserves the full set. Invalid boolean values return 400.

Earlier supported schemas still migrate normally; dormant AI tables remain preserved without restoring AI functionality. No job data or processing state is rewritten by the version-6 migration. Tests cover owner isolation, merge/sync preservation, typed exclusion, bulk consistency, reversible actions, and reload/mobile behavior.

Schema version 3 adds `companies`, `company_identifiers`, `company_syncs`, and nullable `jobs.company_id`. It preserves existing job details/raw JSON, assignment timestamps, source IDs, and pending tracking updates. Indexes enforce strong identifier uniqueness and sync exclusivity; company-job ownership is also guarded by SQLite triggers. Existing jobs are linked only after the user starts a sync.

Backend fixtures cover matching, conflicts, metadata preservation, ownership, migration, cutoff/batching, failures, and restart recovery. React tests cover progress polling, duplicate attachment, safe rendering, filters, and navigation. Playwright covers the production directory workflow with temporary databases, multiple profiles, independent statuses, pagination, refresh, privacy, and a narrow viewport. Use the [standard test commands](README.md#development-commands); no real Jobright account is needed.
