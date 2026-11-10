import { useState } from "react";
import {
  Link,
  useLocation,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth.jsx";
import {
  useAction,
  useFilters,
  useResource,
  isCompanySyncActive,
  invalidateJobs,
} from "../data.js";
import { api, safeLink, dateLabel } from "../api.js";
import {
  Icon,
  PageHead,
  ProfileSelect,
  ErrorNotice,
  Loading,
  Empty,
  Pagination,
  Status,
  SectionHead,
} from "../components.jsx";

const print = (value) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value);
function External({ href, children }) {
  const link = safeLink(href);
  return link ? (
    <a
      className="text-button"
      href={link}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <Icon name="external" size={14} />
    </a>
  ) : null;
}
function CompanyBlacklistStatus({ isBlacklisted }) {
  return (
    <span
      className={`company-blacklist-status ${isBlacklisted ? "is-blacklisted" : ""}`}
    >
      <Icon name={isBlacklisted ? "alert" : "check"} size={13} />
      {isBlacklisted ? "Blacklisted" : "Not blacklisted"}
    </span>
  );
}
function CompanyBlacklistControl({ company }) {
  const { user } = useAuth(),
    cache = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await api(`/companies/${company.id}`, {
        method: "PATCH",
        body: { isBlacklisted: !company.isBlacklisted },
      });
      cache.setQueriesData(
        {
          predicate: (query) =>
            query.queryKey[0] === "user" &&
            query.queryKey[1] === user.id &&
            (query.queryKey[2] === "companies" ||
              query.queryKey[2] === `companies/${company.id}`),
        },
        (data) => {
          if (!data) return data;
          if (data.items)
            return {
              ...data,
              items: data.items.map((item) =>
                item.id === company.id
                  ? { ...item, isBlacklisted: confirmed.isBlacklisted }
                  : item,
              ),
            };
          return { ...data, isBlacklisted: confirmed.isBlacklisted };
        },
      );
      await invalidateJobs(cache, user.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="company-blacklist-control">
      <CompanyBlacklistStatus isBlacklisted={company.isBlacklisted} />
      <button
        type="button"
        className="button subtle small"
        disabled={busy}
        aria-label={
          company.isBlacklisted
            ? `Remove ${company.name} from blacklist`
            : `Blacklist company ${company.name}`
        }
        onClick={toggle}
      >
        {busy
          ? "Saving…"
          : company.isBlacklisted
            ? "Remove from blacklist"
            : "Blacklist company"}
      </button>
      <ErrorNotice error={error} />
    </div>
  );
}
function SyncControls() {
  const { companySync } = useOutletContext(),
    action = useAction();
  const { user } = useAuth(),
    cache = useQueryClient();
  const [error, setError] = useState(null);
  const sync = companySync.data,
    active = isCompanySyncActive(sync?.status);
  async function start() {
    setError(null);
    try {
      const next = await action.mutateAsync({ path: "/company-syncs" });
      cache.setQueryData(["user", user.id, "company-syncs/latest", {}], next);
    } catch (failure) {
      if (failure.code === "COMPANY_SYNC_EXISTS" && failure.details?.syncId) {
        try {
          const existing = await api(
            `/company-syncs/${failure.details.syncId}`,
          );
          cache.setQueryData(
            ["user", user.id, "company-syncs/latest", {}],
            existing,
          );
        } catch (lookupError) {
          setError(lookupError);
        }
      } else setError(failure);
    }
  }
  const percent = sync
    ? sync.total
      ? Math.min(100, Math.round((sync.processed / sync.total) * 100))
      : sync.status === "completed"
        ? 100
        : 0
    : 0;
  return (
    <section
      className="panel company-sync-panel"
      aria-label="Company synchronization"
    >
      <div className="company-sync-heading">
        <div>
          <h2>Company synchronization</h2>
          <p>
            Build your directory from all your stored jobs. Sync again to
            include new collections.
          </p>
        </div>
        <button
          className="button primary"
          disabled={action.isPending || active || companySync.isPending}
          onClick={start}
        >
          <Icon name="refresh" size={16} />
          {active
            ? "Sync in progress"
            : action.isPending
              ? "Queueing sync…"
              : "Sync companies"}
        </button>
      </div>
      <ErrorNotice error={error ?? companySync.error} />
      {sync && (
        <div className="company-sync-progress" role="status" aria-live="polite">
          <div>
            <Status value={sync.status} />
            <strong>
              {sync.processed} / {sync.total} jobs processed
            </strong>
            <span>{percent}%</span>
          </div>
          <progress
            aria-label="Company sync progress"
            max="100"
            value={percent}
          />
          <p>
            {sync.created} created <span>·</span> {sync.updated} refreshed{" "}
            <span>·</span> {sync.linked} linked <span>·</span> {sync.skipped}{" "}
            skipped <span>·</span> {sync.warnings} identity warnings
          </p>
          {sync.status === "completed" && (
            <p className="sync-complete">
              {sync.total
                ? "Company directory is up to date for this sync."
                : "No stored jobs were available to sync."}{" "}
              Finished {dateLabel(sync.endedAt)}.
            </p>
          )}
          {sync.warnings > 0 && (
            <p>
              Some identities conflict. They were kept separate or skipped
              instead of guessing a company match.
            </p>
          )}
          {sync.error && (
            <div className="notice error">
              {sync.error.message} You can start another sync to reconcile your
              stored jobs.
            </div>
          )}
        </div>
      )}
      {!sync && !companySync.isPending && (
        <p className="company-sync-hint">
          Company data is updated only when you start a sync. New jobs appear
          after the next sync.
        </p>
      )}
    </section>
  );
}

export function Companies() {
  const { profiles } = useOutletContext(),
    filters = useFilters();
  const q = filters.params.get("q") ?? "",
    connectionId = filters.params.get("connectionId") ?? "";
  const query = useResource("companies", {
    q,
    connectionId,
    cursor: filters.params.get("cursor"),
    limit: 20,
  });
  const location = useLocation();
  return (
    <>
      <PageHead
        title="Your company directory"
        eyebrow="COMPANIES & OPPORTUNITIES"
      >
        One company, all its roles. Keep assignment and job-site tracking in
        view.
      </PageHead>
      <SyncControls />
      <section className="panel">
        <div className="filter-bar">
          <form
            className="search-field"
            key={q}
            onSubmit={(event) => {
              event.preventDefault();
              filters.change({
                q: new FormData(event.currentTarget).get("q").trim(),
              });
            }}
          >
            <Icon name="search" size={17} />
            <input
              type="search"
              name="q"
              aria-label="Search companies"
              defaultValue={q}
              placeholder="Search company name…"
            />
            <button className="icon-button" aria-label="Search companies">
              <Icon name="arrow" size={15} />
            </button>
          </form>
          <ProfileSelect
            profiles={profiles.data ?? []}
            value={connectionId}
            onChange={(value) => filters.change({ connectionId: value })}
          />
        </div>
        <ErrorNotice error={query.error} />
        {query.isPending ? (
          <Loading text="Loading companies…" />
        ) : query.data?.items.length ? (
          <>
            <div className="table-scroll">
              <table className="company-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Location / industry</th>
                    <th>Collected jobs</th>
                    <th>Assigned</th>
                    <th>Marked applied</th>
                    <th>Blacklist</th>
                    <th>
                      <span className="sr-only">Company details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((company) => (
                    <tr key={company.id}>
                      <td>
                        <Link
                          className="table-title"
                          to={`/companies/${company.id}${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`}
                          state={{ from: location.pathname + location.search }}
                        >
                          <span className="company-avatar">
                            {company.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            {company.name}
                            <small>
                              {company.domain ?? "Website not provided"}
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td className="secondary">
                        <span>{company.location ?? "Not provided"}</span>
                        {company.industry && (
                          <small className="company-industry">
                            {company.industry}
                          </small>
                        )}
                      </td>
                      <td>{company.jobCount}</td>
                      <td>{company.assignedCount}</td>
                      <td>{company.markedAppliedCount}</td>
                      <td>
                        <CompanyBlacklistControl company={company} />
                      </td>
                      <td>
                        <Link
                          className="icon-button"
                          aria-label={`View ${company.name}`}
                          to={`/companies/${company.id}`}
                        >
                          <Icon name="chevron" size={16} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              filters={filters}
              nextCursor={query.data.nextCursor}
              busy={query.isFetching}
            />
          </>
        ) : (
          !query.error && (
            <Empty
              icon="globe"
              title={
                q || connectionId
                  ? "No matching companies"
                  : "Your company directory starts here"
              }
            >
              {q || connectionId
                ? "Try a different name or profile."
                : "Collect jobs, then click Sync companies to organize their company information."}
            </Empty>
          )
        )}
      </section>
      <p className="company-count-note">
        Counts reflect stored job records and the selected profile. Marked
        applied means confirmed Jobright tracking, not an employer application
        submission.
      </p>
    </>
  );
}

export function CompanyDetail() {
  const { id } = useParams(),
    { profiles } = useOutletContext(),
    filters = useFilters(),
    location = useLocation();
  const connectionId = filters.params.get("connectionId") ?? "";
  const query = useResource(`companies/${id}`);
  const jobs = useResource(
    "jobs",
    {
      companyId: id,
      connectionId,
      cursor: filters.params.get("cursor"),
      limit: 20,
    },
    { enabled: !!query.data },
  );
  if (query.isPending) return <Loading text="Opening company details…" />;
  if (query.error)
    return (
      <>
        <PageHead title="Company unavailable" />
        <ErrorNotice error={query.error} />
        <Link className="text-button" to="/companies">
          Back to companies
        </Link>
      </>
    );
  const company = query.data,
    details = company.details ?? {};
  const from = location.state?.from;
  const back =
    typeof from === "string" && /^\/companies(?:\?|$)/.test(from)
      ? from
      : "/companies";
  return (
    <>
      <Link className="back-link" to={back}>
        ← Companies
      </Link>
      <PageHead title={company.name} eyebrow="COMPANY DETAILS">
        Collected information from your job-site profiles.
      </PageHead>
      <div className="company-detail-blacklist">
        <CompanyBlacklistStatus isBlacklisted={company.isBlacklisted} />
      </div>
      <div className="metric-grid">
        {[
          ["Collected jobs", company.jobCount],
          ["Assigned locally", company.assignedCount],
          ["Marked applied in Jobright", company.markedAppliedCount],
        ].map(([label, value]) => (
          <section className="metric-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>Across all your profiles</small>
          </section>
        ))}
      </div>
      <div className="job-detail-grid">
        <section className="panel detail-section">
          <SectionHead title="About the company" />
          <p className="description-text">
            {details.description || "No company description was provided."}
          </p>
          <div className="company-detail-links">
            <External href={company.websiteUrl}>Company website</External>
            {Array.isArray(details.links) &&
              details.links.map((link, index) =>
                typeof link === "object" && link ? (
                  <External key={index} href={link.url}>
                    {link.title || link.text || "Company link"}
                  </External>
                ) : null,
              )}
          </div>
          <details className="metadata">
            <summary>
              All company metadata
              <Icon name="chevron" size={16} />
            </summary>
            <pre>{JSON.stringify(details, null, 2)}</pre>
          </details>
        </section>
        <section className="panel detail-section">
          <SectionHead title="Company information" />
          <dl className="definition-list">
            {[
              ["Location", details.location],
              ["Industry", details.industry],
              ["Team size", details.size],
              ["Founded", details.founded],
              ["Funding / stage", details.funding],
              ["Last synced", dateLabel(company.lastSyncedAt)],
            ].map(([label, value]) => (
              <div className="definition-pair" key={label}>
                <dt>{label}</dt>
                <dd>
                  {value == null || value === ""
                    ? "Not provided"
                    : print(value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <section className="panel">
        <SectionHead
          title="Jobs at this company"
          subtitle="Assignment and job-site tracking are independent statuses."
        />
        <div className="filter-bar">
          <ProfileSelect
            profiles={profiles.data ?? []}
            value={connectionId}
            onChange={(value) => filters.change({ connectionId: value })}
          />
        </div>
        <ErrorNotice error={jobs.error} />
        {jobs.isPending ? (
          <Loading text="Loading company jobs…" />
        ) : jobs.data?.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Profile</th>
                    <th>Local assignment</th>
                    <th>Jobright tracking</th>
                    <th>Collected</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.items.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <Link
                          className="table-title"
                          to={`/jobs/${job.id}`}
                          state={{ from: location.pathname + location.search }}
                        >
                          {job.title}
                        </Link>
                      </td>
                      <td className="secondary">
                        {profiles.data?.find(
                          (profile) => profile.id === job.connectionId,
                        )?.label ?? job.site}
                      </td>
                      <td>
                        <Status
                          value={job.assignedAt ? "assigned" : "available"}
                        />
                      </td>
                      <td>
                        <Status value={job.processingState} />
                      </td>
                      <td className="secondary nowrap">
                        {dateLabel(job.lastScrapedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              filters={filters}
              nextCursor={jobs.data.nextCursor}
              busy={jobs.isFetching}
            />
          </>
        ) : (
          !jobs.error && (
            <Empty title="No linked jobs">
              Try another profile, or sync again from the company directory.
            </Empty>
          )
        )}
      </section>
      <p className="company-count-note">
        These are collected job records. Local assignment and Jobright tracking
        do not confirm an application was submitted to an employer.
      </p>
    </>
  );
}
