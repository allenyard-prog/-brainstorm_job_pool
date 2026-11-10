# Advanced job filters

Open **Collected jobs → Filters** to refine the list in a right-side drawer. Search stays in the toolbar. Company, posted/registered dates, total/skill/industry scores, profile, website, and tracking are combined with AND.

Edits are drafts until **Apply filters**. Reset clears the draft; Apply commits it. Cancel, Escape, the close button, and the backdrop discard unapplied edits. Applied groups appear as removable chips; Clear filters removes drawer filters while keeping toolbar search. Applying or removing a filter resets pagination. URLs retain filters across reload, browser navigation, and return from job details.

## Dates and scores

The drawer also includes **Exclude blacklisted companies**, off by default. Apply commits it to the URL and Reset turns it off. Only jobs linked to blacklisted companies are excluded; run **Sync companies** to link newly collected jobs. Unlinked jobs remain visible. Manage flags in the [company directory](companies.md#company-blacklist).

- **Company:** literal substring of the stored job company name, using the same SQLite case-insensitive search behavior and wildcard escaping as existing title/company search. It works before company synchronization. `%`, `_`, and backslashes are treated literally.
- **Posted date:** the source's absolute calendar date. Valid date/timestamp strings retain their source calendar day without guessing a timezone. Relative values such as “1 day ago” remain unknown.
- **Registered date:** `first_seen_at`, the first time this profile-specific job was saved. Re-scraping changes `last_scraped_at`, not this registration timestamp. Selected days become inclusive browser-local day bounds converted to UTC, including daylight-saving transitions.
- **Scores:** inclusive minimum/maximum values on a 0–100 scale; either end may be blank. Zero is a real score. Filtering preserves source precision; the table rounds only for display.
- Unknown dates/scores are excluded only when a corresponding range is active. No date estimates or averages of individual skill/industry matches are used.

Total score comes from `details.matching.score`. Skill and industry aggregates come from `matching.recommendations` entries with feature names `q_job_skill_match` and `q_industry_match`; their 0–1 values become percentages. Recognized display labels are supported when a feature name is absent. Browser progress charts qualify only when explicitly labeled as the corresponding match metric. Unrelated charts, invalid values, and conflicting duplicate aggregates remain null.

## API

The shared boolean parameter `excludeBlacklistedCompanies` defaults to false. Send `true` to exclude jobs linked to the current user's blacklisted companies, or omit it to retain all companies. The frontend uses explicit booleans for JSON bulk-assignment bodies and omits the URL parameter when disabled.

These filters are shared by `GET /api/v1/jobs`, `/jobs/export`, `/jobs/clipboard`, and `POST /jobs/assign` under the same prefix. Assignment accepts the filter object as its JSON body; the other operations use query parameters. List-only `cursor` and `limit` do not restrict bulk operations.

| Parameter                              | Meaning                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `company`                              | Company name substring, maximum 200 characters                |
| `postedFrom`, `postedTo`               | Inclusive `YYYY-MM-DD` source calendar bounds                 |
| `registeredFrom`, `registeredTo`       | Inclusive ISO timestamps with timezone, applied to first save |
| `totalMatchMin`, `totalMatchMax`       | Total score bounds, 0–100                                     |
| `skillMatchMin`, `skillMatchMax`       | Aggregate skill score bounds, 0–100                           |
| `industryMatchMin`, `industryMatchMax` | Aggregate industry score bounds, 0–100                        |

Existing `connectionId`, `companyId`, `site`, `q`, `status`, and list pagination continue to work. Existing `collectedFrom`/`collectedTo` timestamps still filter the latest scrape. Legacy links display a removable **Last refreshed** chip; the new drawer does not reinterpret those timestamps as registration dates.

Invalid or reversed ranges return a 400 error before bulk writes begin. Every query remains owner-scoped, including administrator requests. CSV and clipboard formats remain unchanged; the filtered record set changes. Copying and assignment keep their existing tracking semantics and do not submit employer applications.

Job summaries and details add `postedDate` (date or null) and `matchingScores` with nullable `total`, `skill`, and `industry` values. Existing `firstSeenAt` supplies registration time. Large detail/raw JSON is still excluded from list summaries.

## Storage and migration

Schema version 6 adds the separately managed company blacklist flag. Queries inspect linked companies at read time, so flag changes affect filtered lists and bulk actions without rewriting job metadata. Company directory/detail views continue to include blacklisted records.

Schema version **5** adds `jobs.posted_date`, `match_total_score`, `match_skill_score`, and `match_industry_score`, plus owner-scoped indexes for these fields and `first_seen_at`. A shared normalizer backfills existing jobs during migration and updates derived values transactionally on every save. Reads use these columns without repeatedly parsing long metadata. Original details, raw JSON, assignment, companies, and processing states are preserved.

The migration supports version 3 and the recognized version-4 schema left by the reverted AI feature. It preserves dormant chat tables and history without restoring any AI implementation. Unrecognized version-4 layouts and future unsupported schemas are rejected. Migration is transactional and safe to reopen after successful completion.

Tests cover normalization, source precision, missing metadata, versions 3/4, pending updates, combined ranges, ownership, bulk consistency, daylight-saving boundaries, drawer drafts, URL restoration, keyboard handling, and desktop/mobile browsers. They use fixtures without contacting Jobright.
