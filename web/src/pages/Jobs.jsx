import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useOutletContext,
  useParams,
} from "react-router-dom";
import {
  invalidateJobs,
  useFilters,
  useResource,
  useSorting,
  useListPagination,
} from "../data.js";
import { useAuth } from "../auth.jsx";
import { api, queryString, dateLabel, safeLink } from "../api.js";
import JobFilterDrawer from "../JobFilterDrawer.jsx";
import NumberedPagination from "../NumberedPagination.jsx";
import AiRecommendation from '../AiRecommendation.jsx';
import AssignmentConfirmation from '../AssignmentConfirmation.jsx';
import { profileLabel } from "../profiles.js";
import {
  readJobFilters,
  filterChips,
  drawerKeys,
  jobFilterBody,
} from "../job-filters.js";
import {
  Icon,
  PageHead,
  ErrorNotice,
  Loading,
  Empty,
  JobsTable,
  Status,
  SectionHead,
} from "../components.jsx";

export function Jobs() {
  const { profiles, live, openCollection } = useOutletContext(),
    filters = useFilters(),
    sites = useResource("sites");
  const jobFilters = readJobFilters(filters.params),
    q = jobFilters.q;
  const sorting = useSorting(filters),
    listParameters = { ...jobFilters, ...sorting.params };
  const chips = filterChips(jobFilters, profiles.data ?? [], sites.data ?? []);
  const [drawer, setDrawer] = useState(false);
  const [assignment, setAssignment] = useState(null);
  const [downloading, setDownloading] = useState(false),
    [downloadError, setDownloadError] = useState(null),
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
  const pagination = useListPagination(filters);
  const query = useResource(
    "jobs",
    { ...listParameters, ...pagination.request },
    { interval: live.data?.items.length ? 5000 : false, keepPrevious: true },
  );
  const actionsDisabled =
    downloading ||
    !!bulkAction ||
    !!assignment ||
    query.isPending ||
    query.isPlaceholderData ||
    !!query.error ||
    !query.data?.items.length;
  async function copyJobs() {
    if (bulkController.current) return;
    const controller = new AbortController();
    bulkController.current = controller;
    setBulkAction('copy');
    setBulkError(null);
    setDownloadError(null);
    setFeedback("");
    try {
      const text = await api(
        `/jobs/clipboard${queryString(listParameters)}`,
        {
          responseType: "text",
          signal: controller.signal,
        },
      );
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
    } catch (error) {
      if (!controller.signal.aborted) setBulkError(error);
    } finally {
      if (bulkController.current === controller) {
        bulkController.current = null;
        setBulkAction(null);
      }
    }
  }
  function openAssignment(action) {
    setBulkError(null);
    setDownloadError(null);
    setFeedback('');
    setAssignment({ action, filters: jobFilterBody(jobFilters) });
  }
  async function download() {
    if (downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await api(`/jobs/export${queryString(listParameters)}`, {
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
      {user.role==='admin' && <AiRecommendation filters={jobFilterBody(jobFilters)} disabled={query.isPending || query.isPlaceholderData || !!query.error || !query.data?.items.length}/>}
      <section className="panel" aria-busy={query.isFetching}>
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
          <button
            className="button subtle"
            aria-label={`Filters${chips.length ? `, ${chips.length} active` : ""}`}
            aria-haspopup="dialog"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Icon name="filter" size={16} />
            Filters
            {chips.length > 0 && (
              <span className="filter-count">{chips.length}</span>
            )}
          </button>
          <div className="job-bulk-actions">
            <button
              type="button"
              className="button subtle"
              disabled={actionsDisabled}
              onClick={() => openAssignment('assign')}
              title="Mark all jobs matching the applied filters across every page as Assigned"
            >
              <Icon name="check" size={16} />
              Assign all Jobs
            </button>
            <button
              type="button"
              className="button subtle"
              disabled={actionsDisabled}
              onClick={() => openAssignment('unassign')}
              title="Unassign all assigned jobs matching the applied filters across every page"
            >
              <Icon name="close" size={16} />
              Unassign jobs
            </button>
            <button
              type="button"
              className="button subtle"
              disabled={actionsDisabled}
              onClick={copyJobs}
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
        {chips.length > 0 && (
          <div className="job-filter-chips" aria-label="Applied filters">
            {chips.map((chip) => (
              <button
                className="filter-chip"
                key={chip.label}
                aria-label={`Remove ${chip.label} filter`}
                title={`${chip.label}: ${chip.value}`}
                onClick={() =>
                  filters.change(
                    Object.fromEntries(chip.keys.map((key) => [key, ""])),
                  )
                }
              >
                <span>
                  {chip.label}: {chip.value}
                </span>
                <Icon name="close" size={12} />
              </button>
            ))}
            <button
              className="text-button"
              onClick={() =>
                filters.change(
                  Object.fromEntries(drawerKeys.map((key) => [key, ""])),
                )
              }
            >
              Clear filters
            </button>
          </div>
        )}
        {feedback && (
          <div className="notice job-action-feedback" role="status">
            {feedback}
          </div>
        )}
        <ErrorNotice error={bulkError ?? downloadError} />
        <ErrorNotice error={query.error} />
        {query.isPending ? (
          <Loading text="Loading collected jobs…" />
        ) : query.data?.items.length ? (
          <>
            <JobsTable
              jobs={query.data.items}
              profiles={profiles.data}
              showFilterMetrics
              sorting={sorting}
              allowPreferredTitleSelection
            />
          </>
        ) : (
          <Empty
            title={
              Object.values(jobFilters).some((value) => value !== "")
                ? "No matching opportunities"
                : "Your job library starts here"
            }
          >
            Try a different filter or start a collection to bring new jobs into
            your workspace.
          </Empty>
        )}
        {!query.error && (
          <NumberedPagination
            data={query.data}
            pagination={pagination}
            filters={filters}
            busy={query.isFetching}
            placeholder={query.isPlaceholderData}
            label="Jobs"
          />
        )}
      </section>
      {assignment && <AssignmentConfirmation
        action={assignment.action}
        filters={assignment.filters}
        onClose={() => setAssignment(null)}
        onSuccess={(result) => {
          const count = assignment.action === 'assign' ? result.assignedCount : result.unassignedCount;
          const verb = assignment.action === 'assign' ? 'assigned' : 'unassigned';
          setAssignment(null);
          filters.change({});
          void invalidateJobs(cache, user.id);
          setFeedback(`${count} ${count === 1 ? 'job' : 'jobs'} ${verb}.`);
        }}
      />}
      {drawer && (
        <JobFilterDrawer
          filters={jobFilters}
          profiles={profiles.data ?? []}
          sites={sites.data ?? []}
          onClose={() => setDrawer(false)}
          onApply={(values) => {
            filters.change(values);
            setDrawer(false);
          }}
        />
      )}
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
                <dd>{profileLabel(profile)}</dd>
                <dt>Preferred title</dt>
                <dd>
                  {job.preferredTitle
                    ? `${job.preferredTitle}${job.preferredTitleArchived ? " (archived)" : ""}`
                    : "No title selected"}
                </dd>
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
