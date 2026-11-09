import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "./auth.jsx";
import { useResource, useLiveRuns } from "./data.js";
import {
  Brand,
  ErrorNotice,
  Icon,
  Loading,
  StartCollection,
} from "./components.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import { Runs, RunDetail } from "./pages/Runs.jsx";
import Profiles from "./pages/Profiles.jsx";
import { Jobs, JobDetail } from "./pages/Jobs.jsx";
import Users from "./pages/Users.jsx";

function PrivateRoute() {
  const auth = useAuth(),
    location = useLocation();
  if (auth.loading)
    return (
      <div className="boot">
        <Brand />
        <Loading text="Opening your workspace…" />
      </div>
    );
  if (!auth.user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  return <Outlet />;
}
function Login() {
  const auth = useAuth(),
    location = useLocation(),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const from = location.state?.from;
  const destination =
    !auth.signedOut &&
    typeof from === "string" &&
    from.startsWith("/") &&
    !from.startsWith("//") &&
    from !== "/login"
      ? from
      : "/dashboard";
  if (auth.loading)
    return (
      <div className="boot">
        <Brand />
        <Loading />
      </div>
    );
  if (auth.user) return <Navigate to={destination} replace />;
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await auth.login(String(data.get("email")), String(data.get("password")));
      form.reset();
      navigate(destination, { replace: true });
    } catch (failure) {
      setError(failure);
      form.elements.password.value = "";
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">A LITTLE LESS SEARCHING.</span>
          <h1>
            Your next opportunity.
            <br />
            <span>All in one place.</span>
          </h1>
          <p>
            Connect your job accounts, collect the details, and keep your search
            moving.
          </p>
          <div className="login-lines" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <small>A private workspace for your job search.</small>
      </div>
      <div className="login-main">
        <div className="login-card">
          <span className="mobile-brand">
            <Brand />
          </span>
          <div className="eyebrow">WELCOME BACK</div>
          <h2>Sign in to your workspace</h2>
          <p className="muted">
            Your profiles, collections, and opportunities.
          </p>
          {auth.expired && (
            <div className="notice">
              Your session expired. Sign in to continue where you left off.
            </div>
          )}
          <ErrorNotice error={error ?? auth.error} />
          <form onSubmit={submit} className="form-stack">
            <label>
              Email address
              <input
                type="email"
                name="email"
                autoComplete="username"
                required
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                placeholder="Enter your password"
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? (
                "Signing in…"
              ) : (
                <>
                  Sign in <Icon name="arrow" size={16} />
                </>
              )}
            </button>
          </form>
          <p className="login-help">
            Need an account? Ask your workspace administrator.
          </p>
          {auth.error && (
            <button className="text-button" onClick={() => auth.refresh()}>
              Check connection again
            </button>
          )}
        </div>
        <small className="login-foot">
          Your workspace. Your data. Always private.
        </small>
      </div>
    </main>
  );
}
function Layout() {
  const auth = useAuth(),
    location = useLocation(),
    navigate = useNavigate();
  const profiles = useResource("connections"),
    live = useLiveRuns();
  const [collection, setCollection] = useState(false),
    [menu, setMenu] = useState(false),
    [logoutError, setLogoutError] = useState(null),
    [loggingOut, setLoggingOut] = useState(false);
  useEffect(() => {
    setCollection(false);
    setMenu(false);
  }, [location.pathname]);
  const selected =
    new URLSearchParams(location.search).get("connectionId") ?? "";
  const profileSuffix = selected
    ? `?connectionId=${encodeURIComponent(selected)}`
    : "";
  const links = [
    ["/dashboard", "dashboard", "Overview"],
    ["/profiles", "profiles", "Profiles"],
    ["/runs", "runs", "Collection runs"],
    ["/jobs", "jobs", "Collected jobs"],
  ];
  const active = links.find(([path]) => location.pathname.startsWith(path));
  function openCollection() {
    if (!profiles.data?.length) navigate("/profiles");
    else setCollection(true);
  }
  async function logout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await auth.logout();
      navigate("/login", { replace: true, state: { from: "/dashboard" } });
    } catch (failure) {
      setLogoutError(failure);
    } finally {
      setLoggingOut(false);
    }
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "is-open" : ""}`}>
        <Link to="/dashboard" className="brand-link" aria-label="Gather home">
          <Brand />
        </Link>
        <div className="workspace-chip">
          <span className="workspace-icon">
            <Icon name="jobs" size={17} />
          </span>
          <div>
            My workspace<small>Personal collection</small>
          </div>
          <span className="workspace-initial">
            {auth.user.email[0].toUpperCase()}
          </span>
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {links.map(([path, icon, title]) => (
            <NavLink
              key={path}
              to={path + (path === "/profiles" ? "" : profileSuffix)}
              onClick={() => setMenu(false)}
              className={({ isActive }) =>
                `nav-item ${isActive ? "selected" : ""}`
              }
            >
              <Icon name={icon} />
              <span>{title}</span>
              {path === "/runs" &&
                live.data?.items?.some((run) => run.status === "running") && (
                  <span className="nav-live" />
                )}
            </NavLink>
          ))}
        </nav>
        {auth.user.role === "admin" && (
          <>
            <div className="nav-caption admin-caption">ADMINISTRATION</div>
            <nav aria-label="Administration">
              <NavLink
                to="/users"
                onClick={() => setMenu(false)}
                className={({ isActive }) =>
                  `nav-item ${isActive ? "selected" : ""}`
                }
              >
                <Icon name="users" />
                <span>Users</span>
              </NavLink>
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <Icon name="eye" size={17} />
            <span>
              Only you can see your
              <br />
              profiles and collected jobs.
            </span>
          </div>
          <div className="account">
            <span className="avatar">{auth.user.email[0].toUpperCase()}</span>
            <div>
              <strong title={auth.user.email}>{auth.user.email}</strong>
              <small>
                {auth.user.role === "admin" ? "Administrator" : "Member"}
              </small>
            </div>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              disabled={loggingOut}
              onClick={logout}
            >
              <Icon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <Icon name="chevron" size={12} />
            <strong>{active?.[2] ?? "Users"}</strong>
          </div>
          <div className="topbar-right">
            <span
              className={`connection-indicator ${live.error ? "offline" : ""}`}
            >
              <span />
              {live.error
                ? "Connection interrupted"
                : live.isPending
                  ? "Connecting"
                  : "Workspace connected"}
            </span>
            <span className="topbar-divider" />
            <span className="top-avatar" title={auth.user.email}>
              {auth.user.email[0].toUpperCase()}
            </span>
          </div>
        </header>
        <main id="main-content" className="content">
          <ErrorNotice error={logoutError ?? profiles.error ?? live.error} />
          <Outlet context={{ profiles, live, openCollection }} />
        </main>
        <footer className="app-footer">
          <span>GATHER WORKSPACE</span>
          <span>Built for a more intentional job search.</span>
        </footer>
      </div>
      {collection && (
        <StartCollection
          profiles={profiles.data ?? []}
          initialProfile={selected}
          onClose={() => setCollection(false)}
        />
      )}
    </div>
  );
}
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<PrivateRoute />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="profiles" element={<Profiles />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:id" element={<RunDetail />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="jobs/:id" element={<JobDetail />} />
          <Route path="users" element={<Users />} />
          <Route
            path="*"
            element={
              <div className="not-found">
                <h1>Page not found</h1>
                <p>This page isn’t part of your workspace.</p>
                <Link className="button primary" to="/dashboard">
                  Back to overview
                </Link>
              </div>
            }
          />
        </Route>
      </Route>
    </Routes>
  );
}
