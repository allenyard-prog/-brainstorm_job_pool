import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { useAction, useResource } from "../data.js";
import { dateLabel } from "../api.js";
import { Icon, PageHead, Loading, ErrorNotice, Modal } from "../components.jsx";

function CreateUser({ onClose }) {
  const action = useAction();
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    try {
      await action.mutateAsync({
        path: "/users",
        body: {
          email: String(data.get("email")),
          password: String(data.get("password")),
          role: String(data.get("role")),
        },
      });
      form.reset();
      onClose();
    } catch {
      form.elements.password.value = "";
    }
  }
  return (
    <Modal title="Create a user" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          New users get a private workspace for their own profiles and jobs.
        </p>
        <label>
          Email address
          <input
            name="email"
            type="email"
            autoComplete="off"
            placeholder="member@example.com"
            required
          />
        </label>
        <label>
          Initial password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength="12"
            maxLength="256"
            placeholder="At least 12 characters"
            required
          />
        </label>
        <label>
          Role
          <select name="role" defaultValue="user">
            <option value="user">Member</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        <ErrorNotice error={action.error} />
        <div className="modal-actions">
          <button type="button" className="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.isPending}>
            {action.isPending ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export default function Users() {
  const { user } = useAuth(),
    [creating, setCreating] = useState(false);
  const query = useResource("users", {}, { enabled: user.role === "admin" });
  if (user.role !== "admin")
    return (
      <>
        <PageHead title="Administrator access required" />
        <div className="notice">
          User management is available to workspace administrators.
        </div>
        <Link className="text-button" to="/dashboard">
          Back to overview
        </Link>
      </>
    );
  return (
    <>
      <PageHead
        title="Workspace users"
        eyebrow="ADMINISTRATION"
        action={
          <button className="button primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            Create user
          </button>
        }
      >
        Manage access. Each user’s profiles and collected data remain private.
      </PageHead>
      <section className="panel">
        <ErrorNotice error={query.error} />
        {query.isPending ? (
          <Loading />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {query.data?.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="table-title">
                        <span className="avatar">
                          {item.email[0].toUpperCase()}
                        </span>
                        <span>
                          {item.email}
                          {item.id === user.id && <small>Your account</small>}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="role-label">
                        {item.role === "admin" ? "Administrator" : "Member"}
                      </span>
                    </td>
                    <td className="secondary">{dateLabel(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && <CreateUser onClose={() => setCreating(false)} />}
    </>
  );
}
