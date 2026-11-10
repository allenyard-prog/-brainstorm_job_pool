import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useResource, useAction } from "./data.js";
import { dateLabel, canRetry, isActive } from "./api.js";

export function Icon({ name, size = 18, ...props }) {
  const paths = {
    filter: <path d="M3 6h18M6 12h12M10 18h4M7 4v4m10 2v4m-5 2v4" />,
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
      </>
    ),
    runs: (
      <>
        <path d="M4 18V9m5 9V4m6 14v-7m5 7V6" />
      </>
    ),
    jobs: (
      <>
        <rect x="3" y="7" width="18" height="14" rx="2" />
        <path d="M8 7V4h8v3M3 12c6 4 12 4 18 0m-9 1v3" />
      </>
    ),
    profiles: (
      <>
        <rect x="4" y="4" width="16" height="17" rx="3" />
        <circle cx="12" cy="10" r="2.5" />
        <path d="M8 17c1-3 7-3 8 0" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m2 4c2 1 3 2 3 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    copy: (
      <>
        <rect x="8" y="8" width="13" height="13" rx="2" />
        <path d="M16 8V3H3v13h5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    play: <path d="m8 4 12 8-12 8z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    check: <path d="m5 12 4 4L19 6" />,
    alert: (
      <>
        <path d="m12 3 10 18H2zM12 9v4m0 4h.01" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    logout: (
      <>
        <path d="M9 4H4v16h5m4-4 4-4-4-4m-5 4h13" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] ?? paths.jobs}
    </svg>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        g<span />
      </span>
      gather<span className="brand-dot">.</span>
    </span>
  );
}
const labels = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  stop_requested: "Stopping",
  stopped: "Stopped",
  completed: "Completed",
  failed: "Failed",
  attention_required: "Needs attention",
  interrupted: "Interrupted",
  ready: "Connected",
  not_authenticated: "Sign-in needed",
  authenticating: "Signing in",
  saved: "Saved",
  assigned: "Assigned",
  available: "Available",
  mark_pending: "Update unconfirmed",
  mark_confirmed: "Marked applied",
};
export function Status({ value }) {
  return (
    <span className={`status status-${value}`}>
      <span className="status-dot" />
      {labels[value] ?? value ?? "Unknown"}
    </span>
  );
}
export function ErrorNotice({ error }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <Icon name="alert" />
      <span>
        {error.status === 404
          ? "This resource is unavailable or does not belong to your account."
          : error.message}
        {error.details?.runId && (
          <>
            {" "}
            <Link to={`/runs/${error.details.runId}`}>
              Open existing run <Icon name="arrow" size={14} />
            </Link>
          </>
        )}
      </span>
    </div>
  );
}
export function Empty({ icon = "jobs", title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading({ text = "Loading workspace…" }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}
export function SectionHead({ title, subtitle, action }) {
  return (
    <div className="section-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function PageHead({ eyebrow, title, children, action }) {
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">{eyebrow ?? "YOUR WORKSPACE"}</div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {action}
    </header>
  );
}
export function ProfileSelect({
  value = "",
  onChange,
  profiles = [],
  label = "Profile",
}) {
  return (
    <label className="select-label">
      <span className="sr-only">{label}</span>
      <Icon name="profiles" size={16} />
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">All profiles</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.label}
          </option>
        ))}
      </select>
    </label>
  );
}
export function Pagination({ filters, nextCursor, busy }) {
  return (
    <div className="pagination">
      <span>Showing your saved records</span>
      <div>
        <button
          className="button subtle small"
          onClick={filters.back}
          disabled={!filters.params.get("cursor") || busy}
        >
          Previous
        </button>
        <button
          className="button subtle small"
          onClick={() => filters.next(nextCursor)}
          disabled={!nextCursor || busy}
        >
          Next <Icon name="chevron" size={14} />
        </button>
      </div>
    </div>
  );
}
export function Modal({ title, children, onClose }) {
  const ref = useRef(null),
    id = useId();
  useEffect(() => {
    const element = ref.current;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function StartCollection({ profiles, initialProfile = "", onClose }) {
  const [profileId, setProfileId] = useState(
      initialProfile || profiles[0]?.id || "",
    ),
    [transport, setTransport] = useState("browser"),
    [continuous, setContinuous] = useState(true),
    [limit, setLimit] = useState(100),
    [mark, setMark] = useState(true);
  const sites = useResource("sites"),
    action = useAction(),
    navigate = useNavigate();
  const profile = profiles.find((item) => item.id === profileId),
    site = sites.data?.find((item) => item.id === profile?.site);
  const modes = site?.transports ?? [];
  const supportsMark =
    site?.operations?.includes("markAsApplied") &&
    site?.operations?.includes("getApplicationStatus");
  useEffect(() => {
    if (modes.length && !modes.includes(transport)) setTransport(modes[0]);
    if (site && !supportsMark) setMark(false);
  }, [site, supportsMark, transport, modes]);
  async function submit(event) {
    event.preventDefault();
    try {
      const run = await action.mutateAsync({
        path: "/runs",
        body: {
          connectionId: profileId,
          transport,
          readOnly: !mark,
          limit: continuous ? null : Number(limit),
        },
      });
      onClose();
      navigate(`/runs/${run.id}`);
    } catch {
      /* Shown inline; mutations are never retried automatically. */
    }
  }
  return (
    <Modal title="Start collection" onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <p className="muted">
          Choose an account and let Gather collect the details.
        </p>
        <label>
          Profile
          <select
            aria-label="Profile"
            value={profileId}
            required
            onChange={(event) => setProfileId(event.target.value)}
          >
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Collection method
          <select
            aria-label="Collection method"
            value={transport}
            onChange={(event) => setTransport(event.target.value)}
          >
            {modes.map((mode) => (
              <option key={mode} value={mode}>
                {mode === "browser" ? "Browser automation" : "API requests"}
              </option>
            ))}
          </select>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={continuous}
            onChange={(event) => setContinuous(event.target.checked)}
          />
          <span>
            Run until stopped
            <small>Continue collecting as new jobs become available.</small>
          </span>
        </label>
        {!continuous && (
          <label>
            Job limit
            <input
              type="number"
              min="1"
              max="1000000"
              required
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </label>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={mark}
            disabled={!supportsMark}
            onChange={(event) => setMark(event.target.checked)}
          />
          <span>
            Mark saved jobs as Already applied
            <small>
              Updates tracking on the job site. No employer applications are
              submitted.
            </small>
          </span>
        </label>
        <ErrorNotice error={sites.error ?? action.error} />
        <div className="modal-actions">
          <button type="button" className="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!profileId || !modes.length || action.isPending}
          >
            {action.isPending ? (
              "Starting…"
            ) : (
              <>
                <Icon name="play" size={15} />
                Start collection
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function RunActions({ run, compact = false }) {
  const action = useAction(),
    navigate = useNavigate();
  async function perform(kind) {
    try {
      const result = await action.mutateAsync({
        path: `/runs/${run.id}/${kind}`,
      });
      if (kind === "retry") navigate(`/runs/${result.id}`);
    } catch {
      /* Inline error. */
    }
  }
  return (
    <div className="run-actions">
      <div className="button-row">
        {isActive(run.status) && (
          <button
            className={`button ${compact ? "subtle small" : "danger"}`}
            disabled={action.isPending || run.status === "stop_requested"}
            onClick={() => perform("stop")}
          >
            <Icon name="stop" size={14} />
            {run.status === "stop_requested" ? "Stopping…" : "Stop run"}
          </button>
        )}
        {canRetry(run.status) && (
          <button
            className="button subtle"
            disabled={action.isPending}
            onClick={() => perform("retry")}
          >
            <Icon name="refresh" size={14} />
            Retry run
          </button>
        )}
      </div>
      <ErrorNotice error={action.error} />
    </div>
  );
}
export function RunTable({ runs, profiles = [] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Profile</th>
            <th>Status</th>
            <th>Jobs saved</th>
            <th>Started</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <Link className="table-title" to={`/runs/${run.id}`}>
                  <span className="table-icon">
                    <Icon
                      name={run.kind === "authentication" ? "profiles" : "runs"}
                      size={17}
                    />
                  </span>
                  <span>
                    {run.kind === "authentication"
                      ? "Account sign-in"
                      : "Job collection"}
                    <small>
                      {run.transport === "api"
                        ? "API requests"
                        : "Browser automation"}
                    </small>
                  </span>
                </Link>
              </td>
              <td className="secondary">
                {profiles.find((profile) => profile.id === run.connectionId)
                  ?.label ?? "Imported account"}
              </td>
              <td>
                <Status value={run.status} />
              </td>
              <td className="tabular">{run.counters.saved ?? 0}</td>
              <td className="secondary nowrap">
                {dateLabel(run.startedAt ?? run.queuedAt)}
              </td>
              <td>
                <Link
                  className="icon-button"
                  aria-label="View run"
                  to={`/runs/${run.id}`}
                >
                  <Icon name="chevron" size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function SortHeader({ label, sortKey, alternatives = [], sorting }) {
  if (!sorting) return <th scope="col">{label}</th>;
  const fields = [{ key: sortKey, label }, ...alternatives];
  const active = fields.some((field) => field.key === sorting.sortBy);
  return (
    <th
      scope="col"
      aria-sort={
        active
          ? sorting.sortOrder === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <span className="sort-header-options">
        {fields.map((field) => {
          const selected = sorting.sortBy === field.key;
          return (
            <button
              key={field.key}
              type="button"
              className="sort-control"
              aria-label={`Sort by ${field.label}`}
              aria-pressed={selected}
              title={
                selected
                  ? `Sort ${field.label} ${sorting.sortOrder === "asc" ? "descending" : "ascending"}`
                  : `Sort ${field.label} ascending`
              }
              onClick={() => sorting.toggle(field.key)}
            >
              {field.label}
              <span className="sort-direction" aria-hidden="true">
                {selected ? (sorting.sortOrder === "asc" ? "↑" : "↓") : "↕"}
              </span>
            </button>
          );
        })}
      </span>
    </th>
  );
}
export function JobsTable({
  jobs,
  profiles = [],
  showFilterMetrics = false,
  sorting,
}) {
  const location = useLocation();
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <SortHeader
              label="Job"
              sortKey="title"
              alternatives={[{ key: "company", label: "Company" }]}
              sorting={sorting}
            />
            <SortHeader label="Profile" sortKey="profile" sorting={sorting} />
            <SortHeader label="Tracking" sortKey="tracking" sorting={sorting} />
            {showFilterMetrics && (
              <SortHeader
                label="Posted"
                sortKey="postedDate"
                sorting={sorting}
              />
            )}
            <SortHeader
              label={showFilterMetrics ? "Registered" : "Collected"}
              sortKey={showFilterMetrics ? "firstSeenAt" : "lastScrapedAt"}
              sorting={sorting}
            />
            {showFilterMetrics &&
              (sorting ? (
                <SortHeader
                  label="Total match"
                  sortKey="totalMatch"
                  alternatives={[
                    { key: "skillMatch", label: "Skill match" },
                    { key: "industryMatch", label: "Industry match" },
                  ]}
                  sorting={sorting}
                />
              ) : (
                <th>Match</th>
              ))}
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <Link
                  className="table-title"
                  to={`/jobs/${job.id}`}
                  state={{ from: location.pathname + location.search }}
                >
                  <span className="company-avatar">
                    {(job.company ?? job.title).slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    {job.title}
                    <small>{job.company || "Company not provided"}</small>
                  </span>
                </Link>
              </td>
              <td className="secondary">
                {profiles.find((profile) => profile.id === job.connectionId)
                  ?.label ?? job.site}
              </td>
              <td>
                <Status
                  value={job.assignedAt ? "assigned" : job.processingState}
                />
              </td>
              {showFilterMetrics && (
                <td className="secondary nowrap">{job.postedDate ?? "—"}</td>
              )}
              <td className="secondary nowrap">
                {dateLabel(
                  showFilterMetrics ? job.firstSeenAt : job.lastScrapedAt,
                )}
              </td>
              {showFilterMetrics && (
                <td className="job-match-scores">
                  <strong>
                    Total{" "}
                    {job.matchingScores?.total == null
                      ? "—"
                      : `${Number(job.matchingScores.total.toFixed(1))}%`}
                  </strong>
                  <small>
                    Skill{" "}
                    {job.matchingScores?.skill == null
                      ? "—"
                      : `${Number(job.matchingScores.skill.toFixed(1))}%`}{" "}
                    · Industry{" "}
                    {job.matchingScores?.industry == null
                      ? "—"
                      : `${Number(job.matchingScores.industry.toFixed(1))}%`}
                  </small>
                </td>
              )}
              <td>
                <Link
                  className="icon-button"
                  aria-label={`View ${job.title}`}
                  to={`/jobs/${job.id}`}
                  state={{ from: location.pathname + location.search }}
                >
                  <Icon name="chevron" size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
