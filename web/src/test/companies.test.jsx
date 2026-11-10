import { it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockBackend, renderApp, alice, profile, job } from "./helpers.jsx";

const company = {
  id: 1,
  name: "Acme Labs",
  domain: "acme.test",
  websiteUrl: "https://acme.test",
  location: "New York",
  industry: "Software",
  jobCount: 2,
  assignedCount: 1,
  markedAppliedCount: 1,
  lastSyncedAt: "2026-11-09T12:00:00Z",
  details: {
    description: "Company description.",
    size: "100",
    founded: 2010,
    sourceMetadata: { future: "Retained detail" },
  },
};
const sync = {
  id: "sync-1",
  status: "running",
  processed: 100,
  total: 240,
  created: 2,
  updated: 1,
  linked: 100,
  skipped: 0,
  warnings: 0,
};

it("sync is manual, shows persisted progress, and refreshes the directory when polling completes", async () => {
  let latest = null,
    companies = [];
  const backend = mockBackend(alice, {
    "/companies": ({ json }) => json({ items: companies, nextCursor: null }),
    "/company-syncs/latest": ({ json }) => json(latest),
    "/company-syncs": ({ json }) => {
      latest = { ...sync, status: "queued", processed: 0 };
      return json(latest, 202);
    },
  });
  renderApp("/companies");
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "Your company directory" });
  await screen.findByText("Your company directory starts here");
  expect(
    backend.fetch.mock.calls.some(
      ([url, options]) =>
        url === "/api/v1/company-syncs" && options.method === "POST",
    ),
  ).toBe(false);
  await user.click(
    screen.getByRole("button", { name: "Sync companies", exact: true }),
  );
  await screen.findByText("0 / 240 jobs processed");
  expect(
    screen.getByRole("button", { name: "Sync in progress" }),
  ).toBeDisabled();
  latest = sync;
  await screen.findByText("100 / 240 jobs processed", {}, { timeout: 4000 });
  expect(
    screen.getByRole("progressbar", { name: "Company sync progress" }),
  ).toHaveAttribute("value", "42");
  companies = [company];
  latest = {
    ...sync,
    status: "completed",
    processed: 240,
    linked: 240,
    endedAt: "2026-11-09T12:01:00Z",
  };
  await screen.findByText("240 / 240 jobs processed", {}, { timeout: 4000 });
  await screen.findByRole("link", { name: "View Acme Labs", exact: true });
  expect(
    screen.getByRole("button", { name: "Sync companies", exact: true }),
  ).toBeEnabled();
});

it("renders company metadata safely and shows assignment independently of tracking", async () => {
  const malicious = '<img src=x onerror="window.compromised=true">';
  mockBackend(alice, {
    "/company-syncs/latest": ({ json }) => json(null),
    "/companies/1": ({ json }) =>
      json({
        ...company,
        websiteUrl: "javascript:alert(1)",
        details: {
          ...company.details,
          description: malicious,
          links: [{ url: "data:text/html,evil", text: "Unsafe link" }],
        },
      }),
    "/jobs": ({ json }) =>
      json({
        items: [
          {
            ...job,
            assignedAt: "2026-11-09T12:00:00Z",
            processingState: "mark_confirmed",
            companyId: 1,
          },
        ],
        nextCursor: null,
      }),
    "/jobs/1": ({ json }) =>
      json({ ...job, companyId: 1, companyName: "Acme Labs" }),
  });
  renderApp("/companies/1");
  const user = userEvent.setup();
  await screen.findByText(malicious);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.queryByRole("link", { name: "Company website" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Unsafe link" })).toBeNull();
  await screen.findByText("Assigned", { exact: true });
  expect(
    screen.getByText("Marked applied", { exact: true }),
  ).toBeInTheDocument();
  await user.click(screen.getByText("All company metadata"));
  expect(screen.getByText(/Retained detail/)).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: job.title, exact: true }));
  await screen.findByRole("heading", { name: job.title });
  expect(screen.getByRole("link", { name: /Company jobs/ })).toHaveAttribute(
    "href",
    "/companies/1",
  );
  expect(screen.getByRole("link", { name: /Acme Labs/ })).toHaveAttribute(
    "href",
    "/companies/1",
  );
});

it("preserves company search, profile and page numbers in API requests", async () => {
  const backend = mockBackend(alice, {
    "/companies": ({ url, json }) =>
      json({
        items: [
          {
            ...company,
            name: url.searchParams.get("page") === '2' ? "Next company" : "Acme Labs",
          },
        ],
        nextCursor: null, total: 21, page: Number(url.searchParams.get('page') ?? 1), pageSize: 20, totalPages: 2,
      }),
  });
  renderApp("/companies");
  const user = userEvent.setup();
  await screen.findByRole("link", { name: "View Acme Labs", exact: true });
  await user.type(
    screen.getByRole("searchbox", { name: "Search companies" }),
    "Acme",
  );
  await user.click(screen.getByRole("button", { name: "Search companies" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Profile" }),
    profile.id,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("link", { name: "View Next company", exact: true });
  expect(
    backend.fetch.mock.calls.some(
      ([url]) =>
        url.includes("q=Acme") &&
        url.includes("connectionId=profile-a") &&
        url.includes("page=2"),
    ),
  ).toBe(true);
});

it("attaches to a duplicate sync and restores an existing operation without retrying start", async () => {
  const backend = mockBackend(alice, {
    "/companies": ({ json }) => json({ items: [], nextCursor: null }),
    "/company-syncs": ({ json }) =>
      json(
        {
          error: {
            code: "COMPANY_SYNC_EXISTS",
            message: "Already running",
            details: { syncId: "sync-1" },
          },
        },
        409,
      ),
    "/company-syncs/sync-1": ({ json }) => json(sync),
  });
  renderApp("/companies");
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Sync companies", exact: true });
  await user.click(
    screen.getByRole("button", { name: "Sync companies", exact: true }),
  );
  await screen.findByText("100 / 240 jobs processed");
  expect(
    screen.getByRole("button", { name: "Sync in progress" }),
  ).toBeDisabled();
  expect(
    backend.fetch.mock.calls.filter(
      ([url, options]) =>
        url === "/api/v1/company-syncs" && options.method === "POST",
    ),
  ).toHaveLength(1);
});

it("restores failed progress after navigation and allows a fresh manual sync", async () => {
  mockBackend(alice, {
    "/companies": ({ json }) => json({ items: [], nextCursor: null }),
    "/company-syncs/latest": ({ json }) =>
      json({
        ...sync,
        status: "interrupted",
        error: { message: "Committed progress was preserved." },
      }),
  });
  renderApp("/companies");
  await screen.findByText("100 / 240 jobs processed");
  expect(
    screen.getByText(/Committed progress was preserved/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Sync companies", exact: true }),
  ).toBeEnabled();
});
