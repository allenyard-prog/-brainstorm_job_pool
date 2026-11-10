import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useAction, useResource } from "../data.js";
import ProfileSpecializations from "../ProfileSpecializations.jsx";
import {
  Icon,
  PageHead,
  Status,
  Loading,
  Empty,
  Modal,
  ErrorNotice,
} from "../components.jsx";

function ProfileForm({ profile, onClose }) {
  const sites = useResource("sites"),
    action = useAction();
  const [site, setSite] = useState(profile?.site ?? "jobright");
  useEffect(() => {
    if (sites.data?.length && !sites.data.some((item) => item.id === site))
      setSite(sites.data[0].id);
  }, [sites.data, site]);
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    try {
      await action.mutateAsync({
        path: profile
          ? `/connections/${profile.id}/credentials`
          : "/connections",
        method: profile ? "PATCH" : "POST",
        body: {
          ...(profile ? {} : { site }),
          ...(!profile && String(data.get("personName") ?? "").trim()
            ? { personName: String(data.get("personName")).trim() }
            : {}),
          email: String(data.get("email")),
          password: String(data.get("password")),
        },
      });
      form.reset();
      onClose();
    } catch {
      form.elements.password.value = "";
    }
  }
  return (
    <Modal
      title={profile ? "Update profile credentials" : "Add a profile"}
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          A profile connects a job-site account to your private workspace.
        </p>
        <label>
          Job site
          <select
            disabled={!!profile}
            value={site}
            onChange={(event) => setSite(event.target.value)}
          >
            {sites.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Account email
          <input
            type="email"
            name="email"
            required
            defaultValue={profile?.label ?? ""}
            readOnly={!!profile}
            autoComplete="off"
            placeholder="Your job-site email"
          />
        </label>
        {!profile && (
          <label>
            Person name (optional)
            <input
              name="personName"
              maxLength="200"
              autoComplete="off"
              placeholder="For example, Daniel Zhang"
            />
          </label>
        )}
        {profile && (
          <small className="muted">
            To use a different email, add a new profile.
          </small>
        )}
        <label>
          {profile ? "New job-site password" : "Job-site password"}
          <input
            type="password"
            name="password"
            required
            maxLength="1000"
            autoComplete="new-password"
            placeholder="Enter the job-site password"
          />
        </label>
        <ErrorNotice error={action.error ?? sites.error} />
        <div className="modal-actions">
          <button type="button" className="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={action.isPending || !sites.data?.length}
          >
            {action.isPending
              ? "Saving…"
              : profile
                ? "Update credentials"
                : "Add profile"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Authenticate({ profile, onClose }) {
  const [headed, setHeaded] = useState(false),
    action = useAction(),
    navigate = useNavigate();
  async function submit(event) {
    event.preventDefault();
    try {
      const run = await action.mutateAsync({
        path: `/connections/${profile.id}/authenticate`,
        body: { headed },
      });
      onClose();
      navigate(`/runs/${run.id}`);
    } catch {
      /* Inline feedback. */
    }
  }
  return (
    <Modal title="Connect your account" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          Sign in to {profile.label} using the credentials saved for this
          profile.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={headed}
            onChange={(event) => setHeaded(event.target.checked)}
          />
          <span>
            Open a visible browser
            <small>
              Use this computer to complete any interactive verification.
            </small>
          </span>
        </label>
        <ErrorNotice error={action.error} />
        <div className="modal-actions">
          <button type="button" className="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.isPending}>
            {action.isPending ? "Queueing sign-in…" : "Sign in to job site"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export default function Profiles() {
  const { profiles, live, openCollection } = useOutletContext();
  const [editing, setEditing] = useState(null),
    [authentication, setAuthentication] = useState(null);
  const [managingId, setManagingId] = useState(null);
  const managed = profiles.data?.find((profile) => profile.id === managingId);
  return (
    <>
      <PageHead
        title="Your connected profiles"
        eyebrow="ACCOUNTS & CONNECTIONS"
        action={
          <button className="button primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            Add profile
          </button>
        }
      >
        One place for every job-site account. Private to you.
      </PageHead>
      {profiles.isPending ? (
        <Loading />
      ) : profiles.data?.length ? (
        <div className="profile-grid">
          {profiles.data.map((profile) => {
            const busy = live.data?.items?.find(
              (run) => run.connectionId === profile.id,
            );
            return (
              <section className="panel profile-card" key={profile.id}>
                <div className="profile-card-top">
                  <span className="site-avatar large">
                    <Icon name="globe" size={25} />
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`Update credentials for ${profile.label}`}
                    title={
                      busy
                        ? "Stop the current operation before updating credentials."
                        : "Update credentials"
                    }
                    disabled={!!busy}
                    onClick={() => setEditing(profile)}
                  >
                    <Icon name="refresh" size={17} />
                  </button>
                </div>
                <span className="eyebrow">{profile.site.toUpperCase()}</span>
                <h2>{profile.personName || profile.label}</h2>
                {profile.personName && (
                  <p className="profile-account-email">{profile.label}</p>
                )}
                <div className="profile-title-chips">
                  {(profile.titles ?? [])
                    .filter((title) => !title.isArchived)
                    .map((title) => (
                      <span key={title.id}>{title.title}</span>
                    ))}
                </div>
                <button
                  className="button subtle small manage-specializations"
                  aria-label={`Manage specializations for ${profile.personName || profile.label}`}
                  onClick={() => setManagingId(profile.id)}
                >
                  Manage specializations
                </button>
                <Status value={profile.authStatus} />
                {busy ? (
                  <div className="profile-busy">
                    <Icon name="runs" size={16} />
                    <span>
                      An operation is{" "}
                      {busy.status === "queued" ? "queued" : "in progress"}.
                    </span>
                    <Link to={`/runs/${busy.id}`}>
                      View run <Icon name="arrow" size={13} />
                    </Link>
                  </div>
                ) : (
                  <div className="profile-hint">
                    {profile.authStatus === "ready"
                      ? "Ready for your next collection."
                      : "Sign in to connect this job-site account."}
                  </div>
                )}
                <div className="profile-card-actions">
                  <button
                    className="button subtle small"
                    disabled={!!busy}
                    onClick={() => setAuthentication(profile)}
                  >
                    {profile.authStatus === "ready" ? "Reconnect" : "Sign in"}
                    <Icon name="arrow" size={14} />
                  </button>
                  <Link
                    className="text-button"
                    to={`/jobs?connectionId=${profile.id}`}
                  >
                    View jobs <Icon name="chevron" size={14} />
                  </Link>
                </div>
                <Link
                  className="profile-run-link"
                  to={`/runs?connectionId=${profile.id}`}
                >
                  View collection history
                </Link>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon="profiles"
            title="Connect your first profile"
            action={
              <button
                className="button primary"
                onClick={() => setEditing("new")}
              >
                <Icon name="plus" />
                Add a profile
              </button>
            }
          >
            Add your Jobright account to authenticate, start collections, and
            organize the results.
          </Empty>
        </section>
      )}
      <div className="notice profile-privacy">
        <Icon name="eye" />
        <span>
          Profile passwords are stored securely by the backend. They’re never
          shown here or shared with other users.
        </span>
      </div>
      {editing && (
        <ProfileForm
          profile={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}{" "}
      {authentication && (
        <Authenticate
          profile={authentication}
          onClose={() => setAuthentication(null)}
        />
      )}
      {managed && (
        <ProfileSpecializations
          profile={managed}
          onClose={() => setManagingId(null)}
        />
      )}
    </>
  );
}
