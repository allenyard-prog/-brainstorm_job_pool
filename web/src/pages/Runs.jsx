import { Link, useOutletContext, useParams } from "react-router-dom";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth.jsx";
import {
  useFilters,
  useResource,
  useRunEvents,
  invalidateJobs,
} from "../data.js";
import { dateLabel, isActive } from "../api.js";
import {
  Icon,
  PageHead,
  ProfileSelect,
  RunTable,
  Pagination,
  ErrorNotice,
  Loading,
  Empty,
  Status,
  RunActions,
  SectionHead,
} from "../components.jsx";

export function Runs() {
  const { profiles, openCollection } = useOutletContext(),
    filters = useFilters();
  const connectionId = filters.params.get("connectionId") ?? "",
    status = filters.params.get("status") ?? "";
  const query = useResource(
    "runs",
    { connectionId, status, cursor: filters.params.get("cursor"), limit: 20 },
    { interval: 2000 },
  );
  return (
    <>
      <PageHead
        title="Collection runs"
        eyebrow="ACTIVITY & HISTORY"
        action={
          <button className="button primary" onClick={openCollection}>
            <Icon name="plus" />
            Start collection
          </button>
        }
      >
        Every collection, from the first request to the last saved job.
      </PageHead>
      <section className="panel">
        <div className="filter-bar">
          <ProfileSelect
            value={connectionId}
            profiles={profiles.data ?? []}
            onChange={(value) => filters.change({ connectionId: value })}
          />
          <label className="select-label">
            <span className="sr-only">Run status</span>
            <select
              aria-label="Run status"
              value={status}
              onChange={(event) =>
                filters.change({ status: event.target.value })
              }
            >
              <option value="">All statuses</option>
              {[
                ["active", "Active & queued"],
                ["queued", "Queued"],
                ["starting", "Starting"],
                ["running", "Running"],
                ["stop_requested", "Stopping"],
                ["completed", "Completed"],
                ["stopped", "Stopped"],
                ["attention_required", "Needs attention"],
                ["failed", "Failed"],
                ["interrupted", "Interrupted"],
              ].map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <span className="filter-caption">
            <span className="live-dot" />
            Updates automatically
          </span>
        </div>
        <ErrorNotice error={query.error} />
        {query.isPending ? (
          <Loading />
        ) : query.data?.items.length ? (
          <>
            <RunTable runs={query.data.items} profiles={profiles.data} />
            <Pagination
              filters={filters}
              nextCursor={query.data.nextCursor}
              busy={query.isFetching}
            />
          </>
        ) : (
          <Empty icon="runs" title="No runs found">
            Try another profile or status, or start a new collection.
          </Empty>
        )}
      </section>
    </>
  );
}
const phaseLabels = {
  authenticating: "Signing in to the job site",
  listing_jobs: "Finding available jobs",
  extracting_job: "Reading job details",
  marking_applied: "Updating job-site tracking",
  verifying_applied: "Confirming tracking status",
  job_saved: "Job details saved",
  waiting_for_jobs: "Waiting for new recommendations",
  job_marked_applied: "Tracking update confirmed",
  starting: "Preparing a worker",
};
export function RunDetail() {
  const { id } = useParams(),
    { profiles } = useOutletContext();
  const query = useResource(
    `runs/${id}`,
    {},
    {
      interval: (state) => (isActive(state.state.data?.status) ? 2000 : false),
    },
  );
  const run = query.data,
    { events, error } = useRunEvents(run);
  const cache = useQueryClient(),
    { user } = useAuth();
  useEffect(() => {
    if (run && !isActive(run.status)) {
      cache.invalidateQueries({ queryKey: ["user", user.id, "connections"] });
      invalidateJobs(cache, user.id);
    }
  }, [run?.id, run?.status, cache, user.id]);
  if (query.isPending) return <Loading text="Loading run…" />;
  if (query.error)
    return (
      <>
        <PageHead title="Run unavailable" />
        <ErrorNotice error={query.error} />
        <Link className="text-button" to="/runs">
          Back to runs
        </Link>
      </>
    );
  const profile = profiles.data?.find((item) => item.id === run.connectionId);
  return (
    <>
      <Link
        className="back-link"
        to={`/runs${run.connectionId ? `?connectionId=${run.connectionId}` : ""}`}
      >
        ← All collection runs
      </Link>
      <PageHead
        title={
          run.kind === "authentication" ? "Account sign-in" : "Job collection"
        }
        eyebrow="RUN DETAILS"
        action={<RunActions run={run} />}
      >
        {profile?.label ?? run.site} <span className="inline-dot">·</span>{" "}
        {dateLabel(run.queuedAt)}
      </PageHead>
      <div className="run-status-bar">
        <Status value={run.status} />
        <span>
          {phaseLabels[run.phase] ??
            (isActive(run.status)
              ? "Your operation is in progress."
              : "This operation has finished.")}
        </span>
      </div>
      {run.error && (
        <div className="notice error" role="alert">
          <Icon name="alert" />
          <div>
            <strong>
              {run.status === "attention_required"
                ? "This run needs your attention"
                : "This run could not finish"}
            </strong>
            <p>{run.error.message}</p>
            {run.status === "attention_required" && (
              <p>
                Review the account sign-in or unconfirmed tracking change before
                retrying.
              </p>
            )}
          </div>
        </div>
      )}
      {run.forced && (
        <div className="notice">
          The worker exceeded its stop allowance. Unconfirmed tracking changes
          will be checked before a retry.
        </div>
      )}
      <div className="metric-grid">
        {[
          ["Jobs saved", run.counters.saved, "jobs"],
          ["Marked applied", run.counters.confirmed, "check"],
          ["Extraction issues", run.counters.failed, "alert"],
        ].map(([label, value, icon]) => (
          <section className="metric-card" key={label}>
            <span>
              <Icon name={icon} />
              {label}
            </span>
            <strong>{value ?? 0}</strong>
            <small>In this run</small>
          </section>
        ))}
      </div>
      <div className="detail-grid">
        <section className="panel event-panel">
          <SectionHead
            title="Activity log"
            subtitle={
              isActive(run.status)
                ? "Live updates from your worker."
                : "Recorded events from this run."
            }
            action={
              isActive(run.status) && (
                <span className="live-label">
                  <span className="live-dot" />
                  LIVE
                </span>
              )
            }
          />
          <ErrorNotice error={error} />
          <div className="event-list" role="log" aria-label="Run activity">
            {events.length ? (
              events.map((event) => (
                <div className="event-row" key={event.id}>
                  <span className="event-dot" />
                  <time dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleTimeString(undefined, {
                      hour12: false,
                    })}
                  </time>
                  <div>
                    <strong>
                      {phaseLabels[event.type] ??
                        event.type.replaceAll("_", " ")}
                    </strong>
                    {(event.payload.message ||
                      event.payload.title ||
                      event.payload.jobId) && (
                      <p>
                        {event.payload.message ??
                          event.payload.title ??
                          `Job ${event.payload.jobId}`}
                      </p>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="muted event-empty">Waiting for the first event…</p>
            )}
          </div>
          {events.length === 500 && (
            <p className="event-foot">
              Showing the latest 500 events. Full history remains on the server.
            </p>
          )}
        </section>
        <section className="panel settings-panel">
          <SectionHead title="Run configuration" />
          <dl className="definition-list">
            <dt>Profile</dt>
            <dd>{profile?.label ?? "Imported account"}</dd>
            <dt>Method</dt>
            <dd>
              {run.transport === "api" ? "API requests" : "Browser automation"}
            </dd>
            <dt>Tracking</dt>
            <dd>
              {run.kind === "authentication"
                ? "Sign-in only"
                : run.options.readOnly
                  ? "Save only"
                  : "Save & mark Already applied"}
            </dd>
            <dt>Job limit</dt>
            <dd>
              {run.kind === "authentication"
                ? "—"
                : (run.options.limit ?? "Until stopped")}
            </dd>
            <dt>Queued</dt>
            <dd>{dateLabel(run.queuedAt)}</dd>
            <dt>Started</dt>
            <dd>{dateLabel(run.startedAt)}</dd>
            <dt>Finished</dt>
            <dd>{dateLabel(run.endedAt)}</dd>
            <dt>Last heartbeat</dt>
            <dd>{dateLabel(run.heartbeatAt)}</dd>
          </dl>
          {run.parentRunId && (
            <Link className="text-button" to={`/runs/${run.parentRunId}`}>
              View original run <Icon name="arrow" size={14} />
            </Link>
          )}
          <Link
            className="button subtle full"
            to={`/jobs?connectionId=${run.connectionId}`}
          >
            Browse collected jobs <Icon name="arrow" size={15} />
          </Link>
        </section>
      </div>
    </>
  );
}
