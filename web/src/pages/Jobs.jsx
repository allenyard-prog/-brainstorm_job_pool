import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { invalidateJobs, useFilters, useResource } from "../data.js";
import { useAuth } from "../auth.jsx";
import { api, queryString, dateLabel, safeLink } from "../api.js";
import {
  Icon,
  PageHead,
  ProfileSelect,
  ErrorNotice,
  Loading,
  Empty,
  JobsTable,
  Pagination,
  Status,
  SectionHead,
} from "../components.jsx";

function localDateTime(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.valueOf())) return "";
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}

export function Jobs() {
  const { profiles, live, openCollection } = useOutletContext(),
    filters = useFilters(),
    sites = useResource("sites");
  const connectionId = filters.params.get("connectionId") ?? "",
    site = filters.params.get("site") ?? "",
    status = filters.params.get("status") ?? "",
    q = filters.params.get("q") ?? "",
    collectedFrom = filters.params.get("collectedFrom") ?? "",
    collectedTo = filters.params.get("collectedTo") ?? "";
  const jobFilters = {
    connectionId,
    site,
    status,
    q,
    collectedFrom,
    collectedTo,
  };
  const [downloading, setDownloading] = useState(false),
    [downloadError, setDownloadError] = useState(null),
    [timeError, setTimeError] = useState(null),
    [bulkAction, setBulkAction] = useState(null),
    [bulkError, setBulkError] = useState(null),
    [feedback, setFeedback] = useState("");
  const cache = useQueryClient(),
    { user } = useAuth();
  const downloadController = useRef(null),
    bulkController = useRef(null);
  useEffect(
    () => () => {
      downloadController.current?.abort();
      downloadController.current = null;
      bulkController.current?.abort();
      bulkController.current = null;
    },
    [],
  );
  const query = useResource(
    "jobs",
    { ...jobFilters, cursor: filters.params.get("cursor"), limit: 20 },
    { interval: live.data?.items.length ? 5000 : false },
  );
  const actionsDisabled =
    downloading ||
    !!bulkAction ||
    query.isPending ||
    !!query.error ||
    !query.data?.items.length;
  async function performBulk(kind) {
    if (bulkController.current) return;
    const controller = new AbortController();
    bulkController.current = controller;
    setBulkAction(kind);
    setBulkError(null);
    setDownloadError(null);
    setFeedback("");
    try {
      if (kind === "assign") {
        const body = Object.fromEntries(
          Object.entries(jobFilters).filter(([, value]) => value !== ""),
        );
        const result = await api("/jobs/assign", {
          method: "POST",
          body,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        filters.change({});
        void invalidateJobs(cache, user.id);
        setFeedback(
          `${result.assignedCount} ${result.assignedCount === 1 ? "job" : "jobs"} assigned.`,
        );
      } else {
        const text = await api(`/jobs/clipboard${queryString(jobFilters)}`, {
          responseType: "text",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const count = Math.max(0, text.trimEnd().split("\n").length - 1);
        if (!count) {
          setFeedback("No jobs match the current filters.");
          return;
        }
        if (!navigator.clipboard?.writeText)
          throw new Error(
            "Clipboard access is unavailable. Allow clipboard access and try again.",
          );
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          throw new Error(
            "Clipboard access was blocked. Allow clipboard access and try again.",
          );
        }
        if (!controller.signal.aborted)
          setFeedback(
            `${count} ${count === 1 ? "job" : "jobs"} copied. Paste into Google Sheets with Ctrl+V.`,
          );
      }
    } catch (error) {
      if (!controller.signal.aborted) setBulkError(error);
    } finally {
      if (bulkController.current === controller) {
        bulkController.current = null;
        setBulkAction(null);
      }
    }
  }
  function applyTime(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fromValue = data.get("collectedFrom"),
      toValue = data.get("collectedTo");
    const from = fromValue ? new Date(fromValue) : null,
      to = toValue ? new Date(toValue) : null;
    if (
      (from && !Number.isFinite(from.valueOf())) ||
      (to && !Number.isFinite(to.valueOf())) ||
      (from && to && from > to)
    ) {
      setTimeError(
        new Error("Collected from must be before or equal to collected to."),
      );
      return;
    }
    setTimeError(null);
    filters.change({
      collectedFrom: from?.toISOString() ?? "",
      collectedTo: to?.toISOString() ?? "",
    });
  }
  async function download() {
    if (downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await api(`/jobs/export${queryString(jobFilters)}`, {
        responseType: "blob",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "gather-jobs.csv";
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (!controller.signal.aborted) setDownloadError(error);
    } finally {
      if (downloadController.current === controller) {
        downloadController.current = null;
        setDownloading(false);
      }
    }
  }
  return (
    <>
      <PageHead
        title="Collected opportunities"
        eyebrow="YOUR JOB LIBRARY"
        action={
          <button className="button primary" onClick={openCollection}>
            <Icon name="plus" />
            Start collection
          </button>
        }
      >
        The details are gathered. Find the opportunities worth your attention.
      </PageHead>
      <section className="panel">
        <div className="filter-bar jobs-filters">
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
              name="q"
              type="search"
              aria-label="Search jobs"
              placeholder="Search title or company…"
              defaultValue={q}
            />
            <button className="icon-button" aria-label="Search">
              <Icon name="arrow" size={15} />
            </button>
          </form>
          <ProfileSelect
            value={connectionId}
            profiles={profiles.data ?? []}
            onChange={(value) => filters.change({ connectionId: value })}
          />
          <label className="select-label">
            <span className="sr-only">Job site</span>
            <select
              aria-label="Job site"
              value={site}
              onChange={(event) => filters.change({ site: event.target.value })}
            >
              <option value="">All sites</option>
              {sites.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="select-label">
            <span className="sr-only">Tracking status</span>
            <select
              aria-label="Tracking status"
              value={status}
              onChange={(event) =>
                filters.change({ status: event.target.value })
              }
            >
              <option value="">All tracking</option>
              <option value="available">Available (unassigned)</option>
              <option value="assigned">Assigned</option>
              <option value="saved">Saved</option>
              <option value="mark_pending">Update unconfirmed</option>
              <option value="mark_confirmed">Marked applied</option>
            </select>
          </label>
          <div className="job-bulk-actions">
            <button
              type="button"
              className="button subtle"
              disabled={actionsDisabled}
              onClick={() => performBulk("assign")}
              title="Mark all jobs matching the applied filters across every page as Assigned"
            >
              <Icon name="check" size={16} />
              {bulkAction === "assign" ? "Assigning…" : "Assign all Jobs"}
            </button>
            <button
              type="button"
              className="button subtle"
              disabled={actionsDisabled}
              onClick={() => performBulk("copy")}
              title="Copy all matches across every page as Company Name, Job Title, and Link for Google Sheets"
            >
              <Icon name="copy" size={16} />
              {bulkAction === "copy" ? "Copying…" : "Copy Available Jobs"}
            </button>
            <button
              type="button"
              className="button subtle download-jobs"
              disabled={actionsDisabled}
              onClick={download}
              title="Download all jobs matching the applied filters, across every page"
            >
              <Icon name="download" size={16} />
              {downloading ? "Downloading…" : "Download CSV"}
            </button>
          </div>
        </div>
        <form
          className="time-filters"
          key={`${collectedFrom}:${collectedTo}`}
          onSubmit={applyTime}
          onChange={() => setTimeError(null)}
        >
          <label>
            Collected from
            <input
              type="datetime-local"
              name="collectedFrom"
              step="1"
              defaultValue={localDateTime(collectedFrom)}
            />
          </label>
          <label>
            Collected to
            <input
              type="datetime-local"
              name="collectedTo"
              step="1"
              defaultValue={localDateTime(collectedTo)}
            />
          </label>
          <button type="submit" className="button subtle small">
            Apply time filter
          </button>
          {(collectedFrom || collectedTo) && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setTimeError(null);
                filters.change({ collectedFrom: "", collectedTo: "" });
              }}
            >
              Clear time filter
            </button>
          )}
          <span className="time-filter-help">
            Times are in your local time zone.
          </span>
        </form>
        {feedback && (
          <div className="notice job-action-feedback" role="status">
            {feedback}
          </div>
        )}
        <ErrorNotice error={timeError ?? bulkError ?? downloadError} />
        <ErrorNotice error={query.error} />
        {query.isPending ? (
          <Loading text="Loading collected jobs…" />
        ) : query.data?.items.length ? (
          <>
            <JobsTable jobs={query.data.items} profiles={profiles.data} />
            <Pagination
              filters={filters}
              nextCursor={query.data.nextCursor}
              busy={query.isFetching}
            />
          </>
        ) : (
          <Empty
            title={
              q ||
              connectionId ||
              status ||
              site ||
              collectedFrom ||
              collectedTo
                ? "No matching opportunities"
                : "Your job library starts here"
            }
          >
            Try a different filter or start a collection to bring new jobs into
            your workspace.
          </Empty>
        )}
      </section>
    </>
  );
}
const printable = (value) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value, null, 2);
function SafeExternal({ href, children, className = "text-button" }) {
  const link = safeLink(href);
  return link ? (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
      <Icon name="external" size={14} />
    </a>
  ) : null;
}
function Items({ values, empty = "Not provided" }) {
  return values?.length ? (
    <ul className="detail-list">
      {values.map((value, index) => (
        <li key={index}>{printable(value)}</li>
      ))}
    </ul>
  ) : (
    <p className="muted">{empty}</p>
  );
}
function Metadata({ value, title = "Additional metadata" }) {
  return value && Object.keys(value).length ? (
    <details className="metadata">
      <summary>
        {title}
        <Icon name="chevron" size={16} />
      </summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  ) : null;
}
function RawSource({ id }) {
  const [open, setOpen] = useState(false);
  const query = useResource(
    `jobs/${id}`,
    { includeRaw: true },
    { enabled: open },
  );
  return (
    <details
      className="metadata"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Raw source data
        <Icon name="chevron" size={16} />
      </summary>
      {open && (
        <>
          <ErrorNotice error={query.error} />
          {query.isPending ? (
            <Loading text="Loading source data…" />
          ) : (
            <pre>{JSON.stringify(query.data?.raw ?? null, null, 2)}</pre>
          )}
        </>
      )}
    </details>
  );
}
export function JobDetail() {
  const { id } = useParams(),
    location = useLocation(),
    { profiles } = useOutletContext();
  const query = useResource(`jobs/${id}`);
  const [tab, setTab] = useState("overview");
  if (query.isPending) return <Loading text="Opening job details…" />;
  if (query.error)
    return (
      <>
        <PageHead title="Job unavailable" />
        <ErrorNotice error={query.error} />
        <Link className="text-button" to="/jobs">
          Back to collected jobs
        </Link>
      </>
    );
  const job = query.data,
    details = job.details ?? {},
    company = details.company ?? {},
    compensation = details.compensation ?? {},
    matching = details.matching ?? {};
  const profile = profiles.data?.find((item) => item.id === job.connectionId);
  const tabs = [
    ["overview", "Overview"],
    ["qualifications", "Qualifications"],
    ["company", "Company"],
    ["metadata", "Source & metadata"],
  ];
  const from = location.state?.from;
  const back =
    typeof from === "string" &&
    (/^\/jobs(?:\?|$)/.test(from) || /^\/companies\/\d+(?:\?|$)/.test(from))
      ? from
      : `/jobs${job.connectionId ? `?connectionId=${job.connectionId}` : ""}`;
  const salary =
    compensation.display ||
    [compensation.minimum, compensation.maximum]
      .filter((value) => value != null)
      .map((value) => Number(value).toLocaleString())
      .join(" – ");
  const charts = matching.recommendations?.length
    ? matching.recommendations
    : (matching.charts ?? []);
  const companyName = company.companyName ?? company.name ?? job.company;
  return (
    <>
      <Link className="back-link" to={back}>
        ← {back.startsWith("/companies/") ? "Company jobs" : "Collected jobs"}
      </Link>
      <section className="job-heading">
        <div className="company-avatar hero-avatar">
          {(job.company ?? job.title)[0].toUpperCase()}
        </div>
        <div className="job-heading-main">
          <div className="eyebrow">
            {job.company ?? "COLLECTED OPPORTUNITY"}
          </div>
          <h1>{job.title}</h1>
          <div className="job-tags">
            {(details.locations ?? []).map((value) => (
              <span key={printable(value)}>
                <Icon name="globe" size={13} />
                {printable(value)}
              </span>
            ))}
            {details.workArrangement && <span>{details.workArrangement}</span>}
            {details.employmentType && <span>{details.employmentType}</span>}
            {details.seniority && <span>{details.seniority}</span>}
          </div>
        </div>
        <div className="job-heading-actions">
          <Status value={job.assignedAt ? "assigned" : job.processingState} />
          <SafeExternal
            className="button primary"
            href={details.applicationUrl ?? job.url}
          >
            Original posting
          </SafeExternal>
        </div>
      </section>
      <div className="detail-tabs" role="tablist" aria-label="Job sections">
        {tabs.map(([value, title], index) => (
          <button
            key={value}
            id={`tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (
                !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
              setTab(tabs[next][0]);
              document.getElementById(`tab-${tabs[next][0]}`)?.focus();
            }}
          >
            {title}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex="0"
      >
        <div className="job-detail-grid">
          <div className="job-main-column">
            {tab === "overview" && (
              <>
                <section className="panel detail-section">
                  <SectionHead title="Job description" />
                  <p className="description-text">
                    {details.description?.text ||
                      "No description was provided."}
                  </p>
                </section>
                {details.responsibilities?.length > 0 && (
                  <section className="panel detail-section">
                    <SectionHead title="Responsibilities" />
                    <Items values={details.responsibilities} />
                  </section>
                )}
                {details.benefits?.length > 0 && (
                  <section className="panel detail-section">
                    <SectionHead title="Benefits" />
                    <Items values={details.benefits} />
                  </section>
                )}
              </>
            )}
            {tab === "qualifications" && (
              <>
                <section className="panel detail-section">
                  <SectionHead title="Required qualifications" />
                  <Items values={details.qualifications?.required} />
                </section>
                <section className="panel detail-section">
                  <SectionHead title="Preferred qualifications" />
                  <Items values={details.qualifications?.preferred} />
                </section>
                <section className="panel detail-section">
                  <SectionHead title="Skills" />
                  <div className="skill-tags">
                    {details.skills?.length ? (
                      details.skills.map((skill, index) => (
                        <span key={index}>
                          {typeof skill === "string"
                            ? skill
                            : (skill.skill ?? skill.name ?? printable(skill))}
                        </span>
                      ))
                    ) : (
                      <p className="muted">Not provided</p>
                    )}
                  </div>
                </section>
                {details.education?.length > 0 && (
                  <section className="panel detail-section">
                    <SectionHead title="Education" />
                    <Items values={details.education} />
                  </section>
                )}
                <section className="panel detail-section">
                  <SectionHead title="Experience & sponsorship" />
                  <dl className="definition-list">
                    {Object.entries(details.experience ?? {})
                      .filter(
                        ([, value]) =>
                          value != null &&
                          (!Array.isArray(value) || value.length),
                      )
                      .map(([key, value]) => (
                        <div className="definition-pair" key={key}>
                          <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                          <dd>
                            {Array.isArray(value) ? (
                              <Items values={value} />
                            ) : (
                              printable(value)
                            )}
                          </dd>
                        </div>
                      ))}
                    {Object.entries(details.sponsorship ?? {})
                      .filter(
                        ([, value]) =>
                          value != null &&
                          (!Array.isArray(value) || value.length),
                      )
                      .map(([key, value]) => (
                        <div className="definition-pair" key={key}>
                          <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                          <dd>
                            {typeof value === "boolean"
                              ? value
                                ? "Yes"
                                : "No"
                              : printable(value)}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </section>
              </>
            )}
            {tab === "company" && (
              <section className="panel detail-section">
                <SectionHead title={companyName ?? "Company information"} />
                <p className="description-text">
                  {company.companyDesc ??
                    company.text ??
                    "No company description was provided."}
                </p>
                <dl className="definition-list company-facts">
                  {[
                    ["Location", company.companyLocation],
                    ["Team size", company.companySize],
                    ["Founded", company.companyFoundYear],
                    ["Stage", company.fundraisingCurrentStage],
                  ]
                    .filter(([, value]) => value)
                    .map(([key, value]) => (
                      <div className="definition-pair" key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
                <SafeExternal href={company.companyURL}>
                  Company website
                </SafeExternal>
                <div className="company-links">
                  {(company.links ?? company.pressReferences ?? []).map(
                    (item, index) => (
                      <SafeExternal key={index} href={item.url}>
                        {item.title || item.text || "Company link"}
                      </SafeExternal>
                    ),
                  )}
                </div>
                <Metadata value={company} title="All company information" />
              </section>
            )}
            {tab === "metadata" && (
              <section className="panel detail-section">
                <SectionHead
                  title="Source & additional information"
                  subtitle="Original fields are preserved, including information that varies by collection method."
                />
                <dl className="definition-list">
                  <dt>Website</dt>
                  <dd>{job.site}</dd>
                  <dt>Source job ID</dt>
                  <dd className="mono">{job.sourceJobId}</dd>
                  <dt>First collected</dt>
                  <dd>{dateLabel(job.firstSeenAt)}</dd>
                  <dt>Last collected</dt>
                  <dd>{dateLabel(job.lastScrapedAt)}</dd>
                </dl>
                <Metadata value={details.extra} />
                <Metadata value={matching} title="Matching details" />
                <Metadata
                  value={details}
                  title="All structured job information"
                />
                <RawSource id={id} />
              </section>
            )}
          </div>
          <aside className="job-side-column">
            <section className="panel detail-section">
              <SectionHead title="At a glance" />
              <dl className="definition-list">
                <dt>Compensation</dt>
                <dd className="compensation">
                  {salary || "Not provided"}
                  {compensation.currency && !compensation.display
                    ? ` ${compensation.currency}`
                    : ""}
                </dd>
                <dt>Profile</dt>
                <dd>{profile?.label ?? "Imported account"}</dd>
                {job.companyId && (
                  <>
                    <dt>Company directory</dt>
                    <dd>
                      <Link
                        className="text-button"
                        to={`/companies/${job.companyId}`}
                      >
                        {job.companyName ?? job.company}{" "}
                        <Icon name="arrow" size={14} />
                      </Link>
                    </dd>
                  </>
                )}
                <dt>Posted</dt>
                <dd>{dateLabel(details.postedAt)}</dd>
                <dt>Collected</dt>
                <dd>{dateLabel(job.lastScrapedAt)}</dd>
              </dl>
              <SafeExternal href={job.url}>
                View on {job.site === "jobright" ? "Jobright" : job.site}
              </SafeExternal>
              {job.websiteStatus === "applied" && (
                <p className="tracking-note">
                  <Icon name="check" size={15} />
                  Marked applied on {job.site}. This is a tracking update, not
                  an employer application.
                </p>
              )}
            </section>
            {(matching.score != null || charts.length > 0) && (
              <section className="panel detail-section">
                <SectionHead title="Your match" />
                {matching.score != null && (
                  <div className="match-score">
                    <strong>
                      {Math.round(matching.score)}
                      <small>%</small>
                    </strong>
                    <span>{matching.label ?? "Match score"}</span>
                  </div>
                )}
                <div className="match-bars">
                  {charts.map((chart, index) => {
                    const score = Math.max(
                      0,
                      Math.min(
                        100,
                        chart.score != null
                          ? chart.score * 100
                          : Number(chart.value),
                      ),
                    );
                    return Number.isFinite(score) ? (
                      <div className="match-bar" key={index}>
                        <div>
                          <span>
                            {chart.displayName ??
                              chart.featureName ??
                              chart.text ??
                              "Match"}
                          </span>
                          <strong>{Math.round(score)}%</strong>
                        </div>
                        <progress
                          max="100"
                          value={score}
                          aria-label={chart.displayName ?? "Match score"}
                        />
                      </div>
                    ) : null;
                  })}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}
