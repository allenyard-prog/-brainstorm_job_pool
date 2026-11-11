# Profile specializations and preferred job titles

A profile remains one connected job-site account. It can now have an optional person name and several specialization labels, such as Daniel Zhang's DevOps Engineer, SRE, Platform Engineer, and DevSecOps Engineer resumes. Labels are configured manually; resume files remain outside this application.

## Manage a profile

Open **Profiles → Manage specializations**. Save or clear the person name, add role titles, rename them, or archive/restore them. The person name is displayed alongside the account email throughout profile selectors, runs, and job context. It never replaces the email used for authentication. New profiles can include an optional person name during creation.

Titles are private to their profile and backend user. Duplicate titles in a profile are rejected after Unicode normalization, trimming, collapsing whitespace, and ignoring case. The same title can exist independently in another profile. Titles contain 1–100 characters; person names contain at most 200. Empty person names clear the optional name.

Archiving keeps existing selections and prevents new jobs from selecting that title. Archived titles remain available in filters. Restoring uses the same ID. Renaming updates displayed labels on selected jobs without rewriting their scraped metadata. Titles are never hard-deleted through the API. Metadata remains editable while work is queued or running; credential changes retain their existing busy-state restriction.

## Choose a preferred title

Each collected-job row has a **Preferred title** dropdown with that job's profile-specific active titles and **No title selected**. Changes save immediately. The control is disabled while saving; failures retain the confirmed value, display inline, and are not automatically retried. An existing archived choice is shown with an archived label and can be cleared or replaced with an active choice. Job details display the saved choice.

The source job title stays intact. Selecting a preferred title does not set Assigned, alter assignment timestamps, change Jobright tracking, submit an application, or upload a resume. Re-scraping preserves the selection. Administrators can also configure per-profile prompts/models and run [AI recommendations](ai-recommendations.md) across filtered jobs; manual selection remains available.

The filter drawer offers **All preferred titles**, **No title selected**, and profile-grouped active/archived choices. Applying a different profile clears an incompatible title filter. Draft/Apply/Cancel/Reset, chips, sorting, totals, and numbered pagination retain their normal behavior. The Preferred title column sorts by label with missing values last. Profile sorting uses the person name when present and otherwise the email.

Preferred-title filtering applies to job listing, CSV, clipboard, and bulk assignment. CSV appends `preferredTitleId`, `preferredTitle`, and `preferredTitleArchived`; the existing scraped `title` column stays unchanged. Clipboard copying retains its three columns, original job title, and employer application link. Bulk assignment remains a separate action and respects the selected title filter.

## API

All routes use `/api/v1`, existing session cookies and Origin checks, and owner-scoped queries. Administrators cannot edit another user's profiles or job preferences.

| Request | Body / behavior |
| --- | --- |
| `POST /connections` | Existing account fields plus optional `personName` |
| `PATCH /connections/:id` | Partial `personName` updates, or null to clear; administrators can also save nullable `specializationPrompt` and `specializationModel` |
| `POST /connections/:id/titles` | `{ "title": "SRE" }`; returns the created title with 201 |
| `PATCH /connections/:id/titles/:titleId` | Rename with `title`, archive/restore with boolean `isArchived`, or both |
| `PATCH /jobs/:id` | `{ "preferredTitleId": "UUID" }`, or null to clear; returns a job summary |

Connection responses include `personName` and `titles: [{id,title,isArchived}]`. Job summaries/details include nullable `preferredTitleId` and `preferredTitle`, plus boolean `preferredTitleArchived`. Selection validates the owning user and the job's exact connection. Retaining the same archived selection is allowed; selecting an archived title on another job returns `409 TITLE_ARCHIVED`. Duplicate titles return `409 TITLE_EXISTS`; foreign or cross-profile resources are unavailable with 404.

Use `preferredTitleId=UUID` or `preferredTitleId=unselected` with shared job-filter endpoints. `sortBy=preferredTitle&sortOrder=asc|desc` follows the existing sorting contract. Filters and ordering can be combined with profile, company, date/score filters, and pagination. Assignment accepts filters but not sorting or pagination.

## Storage and verification

Schema version 7 adds nullable `connections.person_name`, the `profile_titles` table, nullable `jobs.preferred_title_id`, and owner-scoped indexes. Preferences reference stable title IDs rather than copying labels into scraped JSON. Archive state is stored on the title, separately from source data and processing state.

Migration from version 6 is transactional; previous supported paths, including the recognized reverted-AI version 4, continue through current version 8. Version 8 adds optional AI rule/model settings, recommendation operations/items and job-selection revisions without changing existing selections. Source metadata, long JSON, company links/blacklisting, assignment timestamps, pending tracking updates, and encrypted credentials are preserved. Unknown future schemas remain rejected.

Fixture tests cover ownership, cross-profile rejection, duplicates, rename/archive/restore, clearing, re-scraping, migration rollback, shared filters/exports/assignment, sorting, UI errors, keyboard/native controls, and mobile browser workflows. Tests do not authenticate to or update the real job site.
