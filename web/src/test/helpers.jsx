import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { AuthProvider, useAuth } from "../auth.jsx";
import App from "../App.jsx";

export const alice = {
  id: "alice",
  email: "alice@example.test",
  role: "user",
  createdAt: "2026-11-08T12:00:00Z",
};
export const bob = { ...alice, id: "bob", email: "bob@example.test" };
export const profile = {
  id: "profile-a",
  site: "jobright",
  label: "myaccount@provider.test",
  authStatus: "ready",
};
export const site = {
  id: "jobright",
  name: "Jobright",
  transports: ["browser", "api"],
  operations: [
    "listJobs",
    "getJobDetails",
    "markAsApplied",
    "getApplicationStatus",
  ],
};
export const job = {
  id: 1,
  connectionId: profile.id,
  site: "jobright",
  sourceJobId: "source",
  title: "Senior Data Engineer",
  company: "Example Company",
  lastScrapedAt: "2026-11-08T12:00:00Z",
  processingState: "saved",
  details: {
    description: { text: "A complete job description." },
    locations: ["New York, NY"],
    skills: ["SQL"],
    qualifications: { required: ["SQL experience"], preferred: ["Python"] },
    company: { companyName: "Example Company" },
    matching: { score: 84, label: "Good match" },
    extra: {},
  },
};
export function mockBackend(initial = alice, overrides = {}) {
  let current = initial;
  const fetch = vi.fn(async (path, options = {}) => {
    const url = new URL(path, "http://127.0.0.1");
    const route = url.pathname.replace("/api/v1", "");
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (overrides[route])
      return overrides[route]({ url, options, current, json });
    if (route === "/auth/me")
      return current
        ? json(current)
        : json({ error: { message: "Sign in", code: "UNAUTHENTICATED" } }, 401);
    if (route === "/auth/login") {
      current = JSON.parse(options.body).email.startsWith("bob") ? bob : alice;
      return json(current);
    }
    if (route === "/auth/logout") {
      current = null;
      return json({ ok: true });
    }
    if (route === "/connections") return json([profile]);
    if (route === "/company-syncs/latest") return json(null);
    if (route === "/sites") return json([site]);
    if (route === "/runs" && options.method === "POST")
      return json({ id: "new-run", status: "queued" }, 202);
    if (route === "/runs") return json({ items: [], nextCursor: null });
    if (route === "/jobs")
      return json({
        items: [
          {
            ...job,
            title:
              current?.id === "bob"
                ? "Bob’s private job"
                : "Alice’s private job",
          },
        ],
        nextCursor: null,
      });
    if (route === "/jobs/1") return json(job);
    if (route === "/users") return json([alice, bob]);
    return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("BroadcastChannel", undefined);
  return {
    fetch,
    expire: () => {
      current = null;
      window.dispatchEvent(new Event("gather:session-expired"));
    },
  };
}
function Ready({ children }) {
  const auth = useAuth();
  return auth.user ? children : <p>Loading account</p>;
}
export function renderApp(path = "/dashboard", children) {
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return {
    cache,
    ...render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            {children ? <Ready>{children}</Ready> : <App />}
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
