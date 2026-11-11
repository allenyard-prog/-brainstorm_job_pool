import { useState } from "react";
import { useAction } from "./data.js";
import { Modal, ErrorNotice } from "./components.jsx";
import { useAuth } from './auth.jsx';
import ProfileAiSettings from './ProfileAiSettings.jsx';

function TitleRow({ title, profileId, action }) {
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(title.title);
  async function save(body) {
    try {
      const result = await action.mutateAsync({
        path: `/connections/${profileId}/titles/${title.id}`,
        method: "PATCH",
        body,
      });
      setName(result.title);
      setEditing(false);
    } catch {
      /* Shown in the management dialog. */
    }
  }
  return (
    <li className="specialization-row">
      {editing ? (
        <form
          className="specialization-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ title: name });
          }}
        >
          <label>
            Specialization title
            <input
              aria-label={`Rename ${title.title}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength="100"
              required
              autoFocus
            />
          </label>
          <button className="button subtle small" disabled={action.isPending}>
            Save title
          </button>
          <button
            type="button"
            className="button subtle small"
            disabled={action.isPending}
            onClick={() => setEditing(false)}
          >
            Cancel rename
          </button>
        </form>
      ) : (
        <>
          <span>
            {title.title}
            {title.isArchived && <small>Archived</small>}
          </span>
          <div className="button-row">
            <button
              type="button"
              className="button subtle small"
              disabled={action.isPending}
              aria-label={`Rename ${title.title}`}
              onClick={() => {
                setName(title.title);
                setEditing(true);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="button subtle small"
              disabled={action.isPending}
              aria-label={`${title.isArchived ? "Restore" : "Archive"} ${title.title}`}
              onClick={() => void save({ isArchived: !title.isArchived })}
            >
              {title.isArchived ? "Restore" : "Archive"}
            </button>
          </div>
        </>
      )}
    </li>
  );
}

export default function ProfileSpecializations({ profile, onClose }) {
  const {user}=useAuth();
  const action = useAction();
  const [name, setName] = useState(profile.personName ?? ""),
    [title, setTitle] = useState("");
  const titles = profile.titles ?? [];
  async function saveName(event) {
    event.preventDefault();
    try {
      await action.mutateAsync({
        path: `/connections/${profile.id}`,
        method: "PATCH",
        body: { personName: name.trim() || null },
      });
    } catch {
      /* Inline error. */
    }
  }
  async function add(event) {
    event.preventDefault();
    try {
      await action.mutateAsync({
        path: `/connections/${profile.id}/titles`,
        body: { title },
      });
      setTitle("");
    } catch {
      /* Inline error. */
    }
  }
  return (
    <Modal title="Manage specializations" onClose={onClose}>
      <div className="form-stack profile-specializations">
        <p className="muted">{profile.label}</p>
        <form className="form-stack" onSubmit={saveName}>
          <label>
            Person name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength="200"
              placeholder="For example, Daniel Zhang"
            />
          </label>
          <button className="button subtle" disabled={action.isPending}>
            Save name
          </button>
        </form>
        <form className="form-stack" onSubmit={add}>
          <label>
            New specialization
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength="100"
              required
              placeholder="For example, SRE"
            />
          </label>
          <button
            className="button primary"
            disabled={action.isPending || !title.trim()}
          >
            Add specialization
          </button>
        </form>
        <p className="muted">
          These are role labels for your resumes. Resume files stay outside the
          app. Archiving preserves existing job selections.
        </p>
        {["Active", "Archived"].map((group) => (
          <section key={group}>
            <h3>{group} specializations</h3>
            <ul className="specialization-list">
              {titles
                .filter((item) => item.isArchived === (group === "Archived"))
                .map((item) => (
                  <TitleRow
                    key={item.id}
                    title={item}
                    profileId={profile.id}
                    action={action}
                  />
                ))}
            </ul>
            {!titles.some(
              (item) => item.isArchived === (group === "Archived"),
            ) && (
              <p className="muted">No {group.toLowerCase()} specializations.</p>
            )}
          </section>
        ))}
        {user.role==='admin' && <ProfileAiSettings key={profile.id} profile={profile}/>}
        <ErrorNotice error={action.error} />
        <div className="modal-actions">
          <button type="button" className="button subtle" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
