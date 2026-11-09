import { it, expect, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockBackend, renderApp, alice, profile, job } from "./helpers.jsx";
import { StartCollection } from "../components.jsx";

it("restores login, logs out, and clears the old user’s cached jobs before switching accounts", async () => {
  mockBackend();
  const { cache } = renderApp("/jobs");
  const user = userEvent.setup();
  expect(await screen.findByText("Alice’s private job")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    await screen.findByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Alice’s private job")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Email address"), "bob@example.test");
  await user.type(screen.getByLabelText("Password"), "A-test-password!");
  await user.click(
    screen.getByRole("button", { name: "Sign in", exact: true }),
  );
  await screen.findByRole("heading", { name: "Your collection, in motion." });
  await user.click(screen.getByRole("link", { name: "Collected jobs" }));
  expect(await screen.findByText("Bob’s private job")).toBeInTheDocument();
  expect(screen.queryByText("Alice’s private job")).not.toBeInTheDocument();
  expect(
    cache
      .getQueryCache()
      .getAll()
      .some((query) => query.queryKey[1] === "alice"),
  ).toBe(false);
});
it("session expiry returns to the requested detail route after login", async () => {
  const backend = mockBackend();
  renderApp("/jobs/1");
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: job.title });
  backend.expire();
  await screen.findByRole("heading", { name: "Sign in to your workspace" });
  expect(screen.getByText(/Your session expired/)).toBeInTheDocument();
  await user.type(screen.getByLabelText("Email address"), alice.email);
  await user.type(screen.getByLabelText("Password"), "password");
  await user.click(
    screen.getByRole("button", { name: "Sign in", exact: true }),
  );
  expect(
    await screen.findByRole("heading", { name: job.title }),
  ).toBeInTheDocument();
});
it("maps collection controls to API options without automatically retrying", async () => {
  const backend = mockBackend();
  const onClose = vi.fn();
  renderApp(
    "/dashboard",
    <StartCollection profiles={[profile]} onClose={onClose} />,
  );
  const user = userEvent.setup();
  await screen.findByRole("option", { name: "API requests" });
  expect(
    screen.getByLabelText(/Mark saved jobs as Already applied/),
  ).toBeChecked();
  await user.selectOptions(screen.getByLabelText("Collection method"), "api");
  await user.click(screen.getByLabelText(/Run until stopped/));
  await user.clear(screen.getByLabelText("Job limit"));
  await user.type(screen.getByLabelText("Job limit"), "10");
  await user.click(screen.getByLabelText(/Mark saved jobs as Already applied/));
  await user.click(screen.getByRole("button", { name: "Start collection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  const posts = backend.fetch.mock.calls.filter(
    ([path, options]) => path === "/api/v1/runs" && options.method === "POST",
  );
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0][1].body)).toEqual({
    connectionId: profile.id,
    transport: "api",
    readOnly: true,
    limit: 10,
  });
});
it("renders untrusted descriptions as text, rejects unsafe links and fetches raw JSON only on demand", async () => {
  const malicious = '<img src=x onerror="window.compromised=true">';
  const backend = mockBackend(alice, {
    "/jobs/1": ({ url, json }) =>
      json({
        ...job,
        details: {
          ...job.details,
          applicationUrl: "javascript:alert(1)",
          description: { text: malicious },
          company: {
            name: "Browser company",
            text: "Full browser company text.",
          },
          matching: { charts: [{ value: "80", text: "Skill match" }] },
        },
        ...(url.searchParams.has("includeRaw")
          ? { raw: { futureField: "Retained source metadata" } }
          : {}),
      }),
  });
  renderApp("/jobs/1");
  const user = userEvent.setup();
  expect(await screen.findByText(malicious)).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  expect(screen.queryByRole("link", { name: "Original posting" })).toBeNull();
  expect(
    backend.fetch.mock.calls.some(([url]) => url.includes("includeRaw=true")),
  ).toBe(false);
  await user.click(screen.getByRole("tab", { name: "Company", exact: true }));
  expect(screen.getByText("Full browser company text.")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Source & metadata" }));
  await user.click(screen.getByText("Raw source data"));
  expect(
    await screen.findByText(/Retained source metadata/),
  ).toBeInTheDocument();
  expect(
    backend.fetch.mock.calls.some(([url]) => url.includes("includeRaw=true")),
  ).toBe(true);
});
it("hides administrator navigation and never requests user data for a member", async () => {
  const backend = mockBackend();
  renderApp("/users");
  expect(
    await screen.findByRole("heading", {
      name: "Administrator access required",
    }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Users", exact: true })).toBeNull();
  expect(
    backend.fetch.mock.calls.some(([path]) => path === "/api/v1/users"),
  ).toBe(false);
});
it("searches and filters job lists through API query parameters", async () => {
  const backend = mockBackend();
  renderApp("/jobs");
  const user = userEvent.setup();
  await screen.findByText("Alice’s private job");
  await user.type(
    screen.getByRole("searchbox", { name: "Search jobs" }),
    "Data engineer",
  );
  await user.click(screen.getByRole("button", { name: "Search", exact: true }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Profile", exact: true }),
    profile.id,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Tracking status" }),
    "saved",
  );
  await waitFor(() =>
    expect(
      backend.fetch.mock.calls.some(([path]) => {
        const url = new URL(path, "http://example.test");
        return (
          url.pathname.endsWith("/jobs") &&
          url.searchParams.get("q") === "Data engineer" &&
          url.searchParams.get("connectionId") === profile.id &&
          url.searchParams.get("status") === "saved"
        );
      }),
    ).toBe(true),
  );
});

it("applies local collected times, resets pagination, rejects reversed ranges, and clears only time filters", async () => {
  const backend = mockBackend();
  renderApp(
    `/jobs?connectionId=${profile.id}&q=Engineer&status=saved&cursor=page-two&stack=%5B%22%22%5D`,
  );
  const user = userEvent.setup();
  await screen.findByText("Alice’s private job");
  fireEvent.change(screen.getByLabelText("Collected from"), {
    target: { value: "2026-11-08T08:30" },
  });
  fireEvent.change(screen.getByLabelText("Collected to"), {
    target: { value: "2026-11-08T09:45" },
  });
  await user.click(screen.getByRole("button", { name: "Apply time filter" }));
  const expectedFrom = new Date("2026-11-08T08:30").toISOString();
  const expectedTo = new Date("2026-11-08T09:45").toISOString();
  await waitFor(() =>
    expect(
      backend.fetch.mock.calls.some(([path]) => {
        const url = new URL(path, "http://example.test");
        return (
          url.pathname.endsWith("/jobs") &&
          url.searchParams.get("collectedFrom") === expectedFrom &&
          url.searchParams.get("collectedTo") === expectedTo &&
          !url.searchParams.has("cursor") &&
          url.searchParams.get("connectionId") === profile.id &&
          url.searchParams.get("q") === "Engineer" &&
          url.searchParams.get("status") === "saved"
        );
      }),
    ).toBe(true),
  );
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Collected from"), {
    target: { value: "2026-11-09T08:30" },
  });
  await user.click(screen.getByRole("button", { name: "Apply time filter" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Collected from must be before or equal to collected to.",
  );
  expect(
    backend.fetch.mock.calls.some(([path]) =>
      path.includes(
        encodeURIComponent(new Date("2026-11-09T08:30").toISOString()),
      ),
    ),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Clear time filter" }));
  expect(screen.getByLabelText("Collected from")).toHaveValue("");
  expect(screen.getByLabelText("Collected to")).toHaveValue("");
  expect(
    screen.getByRole("combobox", { name: "Profile", exact: true }),
  ).toHaveValue(profile.id);
  expect(screen.getByRole("searchbox", { name: "Search jobs" })).toHaveValue(
    "Engineer",
  );
});

it("shows export failures inline and keeps the download available for a manual retry", async () => {
  const backend = mockBackend(alice, {
    "/jobs/export": ({ json }) =>
      json(
        {
          error: {
            code: "EXPORT_FAILED",
            message: "Download unavailable. Try again.",
          },
        },
        500,
      ),
  });
  renderApp(
    `/jobs?connectionId=${profile.id}&q=Engineer&status=saved&cursor=page-two`,
  );
  const user = userEvent.setup();
  await screen.findByText("Alice’s private job");
  await user.click(screen.getByRole("button", { name: "Download CSV" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Download unavailable. Try again.",
  );
  expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
  const calls = backend.fetch.mock.calls.filter(([path]) =>
    path.startsWith("/api/v1/jobs/export"),
  );
  expect(calls).toHaveLength(1);
  const url = new URL(calls[0][0], "http://example.test");
  expect(url.searchParams.get("q")).toBe("Engineer");
  expect(url.searchParams.get("connectionId")).toBe(profile.id);
  expect(url.searchParams.get("status")).toBe("saved");
  expect(url.searchParams.has("cursor")).toBe(false);
});

it("assigns all filtered jobs without pagination and refreshes their Tracking status", async () => {
  let assignedAt = null;
  const backend = mockBackend(alice, {
    "/jobs": ({ json }) =>
      json({ items: [{ ...job, assignedAt }], nextCursor: null }),
    "/jobs/assign": ({ json }) => {
      assignedAt = "2026-11-08T15:00:00Z";
      return json({ assignedCount: 103 });
    },
  });
  renderApp(
    `/jobs?connectionId=${profile.id}&q=Engineer&site=jobright&status=saved&collectedFrom=2026-11-08T12%3A00%3A00Z&cursor=page-two&stack=%5B%22%22%5D`,
  );
  const user = userEvent.setup();
  await screen.findByText(job.title);
  await user.click(
    screen.getByRole("button", { name: "Assign all Jobs", exact: true }),
  );
  await screen.findByText("103 jobs assigned.");
  await waitFor(() =>
    expect(document.querySelector(".status-assigned")).toHaveTextContent(
      "Assigned",
    ),
  );
  const posts = backend.fetch.mock.calls.filter(
    ([path]) => path === "/api/v1/jobs/assign",
  );
  expect(posts).toHaveLength(1);
  expect(posts[0][1].method).toBe("POST");
  expect(JSON.parse(posts[0][1].body)).toEqual({
    connectionId: profile.id,
    q: "Engineer",
    site: "jobright",
    status: "saved",
    collectedFrom: "2026-11-08T12:00:00Z",
  });
  expect(
    screen.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();
  expect(
    screen.getByRole("option", { name: "Assigned", exact: true }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "Available (unassigned)", exact: true }),
  ).toBeInTheDocument();
});

it("copies the filtered Sheets table and preserves the clipboard when no jobs are available", async () => {
  let empty = false;
  const text =
    "Company Name\tJob Title\tLink\nExample Company\tEngineer\thttps://example.test/job\n";
  const backend = mockBackend(alice, {
    "/jobs/clipboard": () =>
      new Response(empty ? "Company Name\tJob Title\tLink\n" : text),
  });
  renderApp(`/jobs?connectionId=${profile.id}&q=Engineer&cursor=page-two`);
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await screen.findByText("Alice’s private job");
  await user.click(
    screen.getByRole("button", { name: "Copy Available Jobs", exact: true }),
  );
  await screen.findByText(
    "1 job copied. Paste into Google Sheets with Ctrl+V.",
  );
  expect(write).toHaveBeenCalledWith(text);
  const call = backend.fetch.mock.calls.find(([path]) =>
    path.startsWith("/api/v1/jobs/clipboard"),
  );
  const url = new URL(call[0], "http://example.test");
  expect(url.searchParams.get("connectionId")).toBe(profile.id);
  expect(url.searchParams.get("q")).toBe("Engineer");
  expect(url.searchParams.has("cursor")).toBe(false);
  expect(
    backend.fetch.mock.calls.some(([path]) => path === "/api/v1/jobs/assign"),
  ).toBe(false);
  empty = true;
  await user.click(
    screen.getByRole("button", { name: "Copy Available Jobs", exact: true }),
  );
  await screen.findByText("No jobs match the current filters.");
  expect(write).toHaveBeenCalledTimes(1);
});

it("shows clipboard permission failures and allows a manual retry without assigning jobs", async () => {
  const backend = mockBackend(alice, {
    "/jobs/clipboard": () =>
      new Response(
        "Company Name\tJob Title\tLink\nExample\tEngineer\thttps://example.test/job\n",
      ),
  });
  renderApp("/jobs");
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Denied", "NotAllowedError"),
  );
  await screen.findByText("Alice’s private job");
  await user.click(
    screen.getByRole("button", { name: "Copy Available Jobs", exact: true }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Clipboard access was blocked.",
  );
  expect(
    screen.getByRole("button", { name: "Copy Available Jobs", exact: true }),
  ).toBeEnabled();
  expect(
    backend.fetch.mock.calls.some(([path]) => path === "/api/v1/jobs/assign"),
  ).toBe(false);
});

it("preserves filters through cursor navigation and back navigation", async () => {
  const backend = mockBackend(alice, {
    "/jobs": ({ url, json }) =>
      json({
        items: [
          {
            ...job,
            title: url.searchParams.has("cursor")
              ? "Second page opportunity"
              : "First page opportunity",
          },
        ],
        nextCursor: url.searchParams.has("cursor") ? null : "page-two",
      }),
  });
  renderApp(`/jobs?connectionId=${profile.id}&q=Engineer&status=saved`);
  const user = userEvent.setup();
  await screen.findByText("First page opportunity");
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Second page opportunity");
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("First page opportunity");
  expect(
    backend.fetch.mock.calls
      .filter(([path]) => path.includes("/jobs?"))
      .every(
        ([path]) =>
          path.includes("connectionId=profile-a") &&
          path.includes("status=saved") &&
          path.includes("q=Engineer"),
      ),
  ).toBe(true);
});

it("loads event pages incrementally, caps rendered history and stops polling a completed run", async () => {
  const run = {
    id: "history",
    status: "completed",
    kind: "collection",
    site: "jobright",
    transport: "browser",
    connectionId: profile.id,
    options: { readOnly: true, limit: 1 },
    counters: { saved: 1, confirmed: 0, failed: 0 },
  };
  const events = Array.from({ length: 620 }, (_, index) => ({
    id: index + 1,
    type: "job_saved",
    payload: { title: `Saved opportunity ${index + 1}` },
    createdAt: "2026-11-08T12:00:00Z",
  }));
  const backend = mockBackend(alice, {
    "/runs/history": ({ json }) => json(run),
    "/runs/history/events": ({ url, json }) => {
      const after = Number(url.searchParams.get("after"));
      const items = events.filter((event) => event.id > after).slice(0, 100);
      return json({ items, nextCursor: items.at(-1)?.id ?? after });
    },
  });
  renderApp("/runs/history");
  await screen.findByText("Saved opportunity 620");
  expect(document.querySelectorAll(".event-row")).toHaveLength(500);
  expect(screen.queryByText("Saved opportunity 120")).not.toBeInTheDocument();
  expect(screen.getByText("Saved opportunity 121")).toBeInTheDocument();
  expect(
    backend.fetch.mock.calls.some(([path]) =>
      path.includes("/events?after=600"),
    ),
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry run" })).toBeNull();
});

it("retains a long description and tolerates absent optional job fields", async () => {
  const text = "Complete original description. ".repeat(10000);
  mockBackend(alice, {
    "/jobs/1": ({ json }) =>
      json({ ...job, details: { description: { text } } }),
  });
  renderApp("/jobs/1");
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: job.title });
  expect(document.querySelector(".description-text").textContent).toBe(text);
  await user.click(
    screen.getByRole("tab", { name: "Qualifications", exact: true }),
  );
  expect(screen.getAllByText("Not provided").length).toBeGreaterThan(0);
});

it("shows rejected login feedback and clears the password without retrying", async () => {
  const backend = mockBackend(null, {
    "/auth/login": ({ json }) =>
      json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password.",
          },
        },
        401,
      ),
  });
  renderApp("/login");
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "Sign in to your workspace" });
  await user.type(screen.getByLabelText("Email address"), alice.email);
  await user.type(screen.getByLabelText("Password"), "bad-password");
  await user.click(
    screen.getByRole("button", { name: "Sign in", exact: true }),
  );
  await screen.findByRole("alert");
  expect(screen.getByText("Invalid email or password.")).toBeInTheDocument();
  expect(screen.getByLabelText("Password")).toHaveValue("");
  expect(
    backend.fetch.mock.calls.filter(([path]) => path.endsWith("/auth/login")),
  ).toHaveLength(1);
});
