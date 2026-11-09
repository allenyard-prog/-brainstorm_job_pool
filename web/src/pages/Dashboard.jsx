import { Link, useOutletContext } from "react-router-dom";
import { useFilters, useResource } from "../data.js";
import { dateLabel } from "../api.js";
import {
  Icon,
  PageHead,
  ProfileSelect,
  SectionHead,
  RunTable,
  JobsTable,
  Status,
  Empty,
  Loading,
  ErrorNotice,
  RunActions,
} from "../components.jsx";

export default function Dashboard() {
  const { profiles, live, openCollection } = useOutletContext(),
    filters = useFilters();
  const connectionId = filters.params.get("connectionId") ?? "";
  const runs = useResource(
    "runs",
    { limit: 5, connectionId },
    { interval: 2000 },
  );
  const jobs = useResource(
    "jobs",
    { limit: 5, connectionId },
    { interval: live.data?.items.length ? 5000 : false },
  );
  const active =
    live.data?.items.filter(
      (run) => !connectionId || run.connectionId === connectionId,
    ) ?? [];
  const current =
    active.find((run) =>
      ["running", "starting", "stop_requested"].includes(run.status),
    ) ?? active[0];
  const suffix = connectionId ? `?connectionId=${connectionId}` : "";
  return (
    <>
      <PageHead
        title="Your collection, in motion."
        eyebrow="COLLECTION OVERVIEW"
        action={
          <button className="button primary" onClick={openCollection}>
            <Icon name="plus" size={17} />
            Start collection
          </button>
        }
      >
        A clear view of what’s running and what’s next.
      </PageHead>
      <div className="dashboard-toolbar">
        <div className="page-tabs">
          <span className="active">Overview</span>
          <Link to={`/runs${suffix}`}>Run history</Link>
        </div>
        <ProfileSelect
          value={connectionId}
          profiles={profiles.data ?? []}
          onChange={(value) => filters.change({ connectionId: value })}
        />
      </div>
      <div className="dashboard-grid">
        <section className={`activity-card ${current ? "has-activity" : ""}`}>
          <div className="activity-top">
            <span className="eyebrow">
              <span className={current ? "live-dot" : "quiet-dot"} />
              LIVE ACTIVITY
            </span>
            {current ? (
              <Status value={current.status} />
            ) : (
              <span className="muted small-text">All clear</span>
            )}
          </div>
          {current ? (
            <>
              <h2>
                {current.status === "queued"
                  ? "Your operation is queued"
                  : current.kind === "authentication"
                    ? "Connecting your account"
                    : "Finding your next opportunity"}
              </h2>
              <p>
                {profiles.data?.find(
                  (profile) => profile.id === current.connectionId,
                )?.label ?? current.site}{" "}
                <span className="inline-dot">·</span>{" "}
                {current.transport === "api"
                  ? "API collection"
                  : "Browser collection"}
              </p>
              <div className="run-metrics">
                <div>
                  <strong>{current.counters.saved ?? 0}</strong>
                  <span>Jobs saved</span>
                </div>
                <div>
                  <strong>{current.counters.confirmed ?? 0}</strong>
                  <span>Marked applied</span>
                </div>
                <div>
                  <strong>{current.counters.failed ?? 0}</strong>
                  <span>Issues</span>
                </div>
              </div>
              <div className="activity-footer">
                <span>
                  <Icon name="clock" size={14} />
                  {dateLabel(current.startedAt ?? current.queuedAt)}
                </span>
                <div className="button-row">
                  <RunActions run={current} compact />
                  <Link
                    className="button subtle small"
                    to={`/runs/${current.id}`}
                  >
                    View activity <Icon name="arrow" size={14} />
                  </Link>
                </div>
              </div>
            </>
          ) : (
            <div className="activity-idle">
              <div className="orbit-icon" aria-hidden="true">
                <Icon name="runs" size={30} />
                <span />
              </div>
              <h2>
                {profiles.data?.length
                  ? "Ready when you are."
                  : "Make room for your next move."}
              </h2>
              <p>
                {profiles.data?.length
                  ? "Start a collection and we’ll keep the details organized here."
                  : "Connect a job-site profile to start collecting opportunities."}
              </p>
              <button className="text-button" onClick={openCollection}>
                {profiles.data?.length
                  ? "Start a new collection"
                  : "Connect your first profile"}{" "}
                <Icon name="arrow" size={16} />
              </button>
            </div>
          )}
        </section>
        <section className="panel profile-summary">
          <SectionHead
            title="Your profiles"
            action={
              <Link className="text-button" to="/profiles">
                Manage <Icon name="arrow" size={14} />
              </Link>
            }
          />
          {profiles.isPending ? (
            <Loading text="Loading profiles…" />
          ) : profiles.data?.length ? (
            <div className="profile-mini-list">
              {profiles.data.slice(0, 3).map((profile) => (
                <Link
                  key={profile.id}
                  to={`/runs?connectionId=${profile.id}`}
                  className="profile-mini"
                >
                  <span className="site-avatar">
                    <Icon name="globe" size={19} />
                  </span>
                  <div>
                    <strong title={profile.label}>{profile.label}</strong>
                    <small>
                      {profile.site === "jobright" ? "Jobright" : profile.site}
                    </small>
                  </div>
                  <span
                    className={`mini-status ${profile.authStatus === "ready" ? "ready" : ""}`}
                    title={
                      profile.authStatus === "ready"
                        ? "Connected"
                        : "Sign-in needed"
                    }
                  />
                </Link>
              ))}
              {profiles.data.length > 3 && (
                <Link to="/profiles" className="text-button">
                  View all {profiles.data.length} profiles
                </Link>
              )}
            </div>
          ) : (
            <div className="profile-mini-empty">
              <Icon name="profiles" size={30} />
              <p>
                A connected account is
                <br />
                where every collection begins.
              </p>
              <Link className="button subtle small" to="/profiles">
                <Icon name="plus" size={14} />
                Add a profile
              </Link>
            </div>
          )}
          <div className="profile-summary-foot">
            <Icon name="eye" size={14} />
            Private to your account
          </div>
        </section>
      </div>
      {active.some((run) => run.status === "queued") && (
        <div className="notice queue-note">
          <Icon name="clock" />
          <span>
            A collection is queued and will start when a worker is available.
          </span>
          <Link
            to={`/runs?status=active${connectionId ? `&connectionId=${connectionId}` : ""}`}
          >
            View queue <Icon name="arrow" size={14} />
          </Link>
        </div>
      )}
      <section className="panel">
        <SectionHead
          title="Recent activity"
          subtitle="The latest from your collection runs."
          action={
            <Link className="text-button" to={`/runs${suffix}`}>
              View all runs <Icon name="arrow" size={15} />
            </Link>
          }
        />
        <ErrorNotice error={runs.error} />
        {runs.isPending ? (
          <Loading />
        ) : runs.data?.items.length ? (
          <RunTable runs={runs.data.items} profiles={profiles.data} />
        ) : (
          <Empty icon="runs" title="Your first collection starts here">
            Start a run to see its progress and history.
          </Empty>
        )}
      </section>
      <section className="panel">
        <SectionHead
          title="Recently collected"
          subtitle="Fresh details, ready for a closer look."
          action={
            <Link className="text-button" to={`/jobs${suffix}`}>
              Browse jobs <Icon name="arrow" size={15} />
            </Link>
          }
        />
        <ErrorNotice error={jobs.error} />
        {jobs.isPending ? (
          <Loading />
        ) : jobs.data?.items.length ? (
          <JobsTable jobs={jobs.data.items} profiles={profiles.data} />
        ) : (
          <Empty title="A little empty, for now">
            Collected jobs will appear here as your runs save them.
          </Empty>
        )}
      </section>
    </>
  );
}
