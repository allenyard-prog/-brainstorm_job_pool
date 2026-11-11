import { it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  mockBackend,
  renderApp,
  alice,
  bob,
  job,
  profile,
} from "./helpers.jsx";

const company = {
  id: 1,
  name: "Acme Labs",
  domain: "acme.test",
  isBlacklisted: false,
  jobCount: 2,
  assignedCount: 1,
  markedAppliedCount: 0,
  details: { description: "Company description" },
};
it("company actions wait for confirmation, affect only their row, and invalidate owner-scoped jobs", async () => {
  let current = { ...company },
    complete;
  mockBackend(alice, {
    "/companies": ({ json }) =>
      json({
        items: [current, { ...company, id: 2, name: "Other Labs" }],
        nextCursor: null,
      }),
    "/companies/1": async ({ json, options }) => {
      const body = JSON.parse(options.body);
      await new Promise((resolve) => {
        complete = resolve;
      });
      current = { ...current, ...body };
      return json(current);
    },
  });
  const { cache } = renderApp("/companies?connectionId=profile-a");
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Blacklist company Acme Labs" });
  cache.setQueryDefaults(["user"], { gcTime: Infinity });
  cache.setQueryData(
    ["user", alice.id, "jobs", { excludeBlacklistedCompanies: true }],
    { items: [job] },
  );
  cache.setQueryData(["user", bob.id, "jobs", {}], { items: [] });
  const button = screen.getByRole("button", {
    name: "Blacklist company Acme Labs",
  });
  await user.click(button);
  expect(button).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Blacklist company Other Labs" }),
  ).toBeEnabled();
  expect(
    screen.queryByText("Blacklisted", { exact: true }),
  ).not.toBeInTheDocument();
  complete();
  await screen.findByRole("button", {
    name: "Remove Acme Labs from blacklist",
  });
  expect(screen.getByText("Blacklisted", { exact: true })).toBeInTheDocument();
  await waitFor(() =>
    expect(
      cache.getQueryState([
        "user",
        alice.id,
        "jobs",
        { excludeBlacklistedCompanies: true },
      ]).isInvalidated,
    ).toBe(true),
  );
  expect(cache.getQueryState(["user", bob.id, "jobs", {}]).isInvalidated).toBe(
    false,
  );
  const restore = screen.getByRole("button", {
    name: "Remove Acme Labs from blacklist",
  });
  await waitFor(() => expect(restore).toBeEnabled());
  complete = null;
  await user.click(restore);
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  complete();
  await screen.findByRole("button", { name: "Blacklist company Acme Labs" });
});

it("company mutation failures remain inline without optimistic changes or automatic retries", async () => {
  const backend = mockBackend(alice, {
    "/companies": ({ json }) => json({ items: [company], nextCursor: null }),
    "/companies/1": ({ json }) =>
      json(
        {
          error: {
            code: "SAVE_FAILED",
            message: "Blacklist could not be saved.",
          },
        },
        500,
      ),
  });
  renderApp("/companies");
  const user = userEvent.setup();
  const button = await screen.findByRole("button", {
    name: "Blacklist company Acme Labs",
  });
  await user.click(button);
  await screen.findByText("Blacklist could not be saved.");
  expect(button).toBeEnabled();
  expect(
    screen.getByText("Not blacklisted", { exact: true }),
  ).toBeInTheDocument();
  expect(
    backend.fetch.mock.calls.filter(
      ([, options]) => options.method === "PATCH",
    ),
  ).toHaveLength(1);
});

it("company details show blacklist status while keeping related jobs visible", async () => {
  mockBackend(alice, {
    "/companies/1": ({ json }) => json({ ...company, isBlacklisted: true }),
    "/jobs": ({ json }) =>
      json({ items: [{ ...job, companyId: 1 }], nextCursor: null }),
  });
  renderApp("/companies/1");
  await screen.findByText("Blacklisted", { exact: true });
  expect(
    await screen.findByRole("link", { name: new RegExp(job.title) }),
  ).toHaveAttribute("href", "/jobs/1");
});

it("blacklist exclusion follows drawer drafts, URL state, reset and typed bulk requests", async () => {
  const backend = mockBackend(alice, {
    "/jobs/assign": ({ json }) => json({ assignedCount: 1 }),
  });
  renderApp("/jobs?q=Engineer&cursor=page-two");
  const user = userEvent.setup();
  await screen.findByText("Alice’s private job");
  const jobs = () =>
    backend.fetch.mock.calls.filter(
      ([path]) =>
        new URL(path, "http://fixture.test").pathname === "/api/v1/jobs",
    );
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
  let checkbox = screen.getByLabelText("Exclude blacklisted companies");
  expect(checkbox).not.toBeChecked();
  await user.click(checkbox);
  expect(jobs()).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
  checkbox = screen.getByLabelText("Exclude blacklisted companies");
  expect(checkbox).not.toBeChecked();
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  await screen.findByRole("button", { name: "Remove Blacklist filter" });
  const url = new URL(jobs().at(-1)[0], "http://fixture.test");
  expect(url.searchParams.get("excludeBlacklistedCompanies")).toBe("true");
  expect(url.searchParams.has("cursor")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Assign all Jobs" }));
  await user.click(await screen.findByRole('button', { name: 'Confirm assignment' }));
  await screen.findByText("1 job assigned.");
  const request = backend.fetch.mock.calls.find(
    ([path]) => path === "/api/v1/jobs/assign",
  );
  expect(JSON.parse(request[1].body)).toEqual({
    q: "Engineer",
    excludeBlacklistedCompanies: true,
    previewFingerprint: 'a'.repeat(64),
  });
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
  expect(screen.getByLabelText("Exclude blacklisted companies")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(
    screen.getByLabelText("Exclude blacklisted companies"),
  ).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Remove Blacklist filter" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove Blacklist filter" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    new URL(jobs().at(-1)[0], "http://fixture.test").searchParams.has(
      "excludeBlacklistedCompanies",
    ),
  ).toBe(false);
});

it("an explicit false URL does not activate the exclusion or produce a truthy filter", async () => {
  const backend = mockBackend();
  renderApp("/jobs?excludeBlacklistedCompanies=false");
  await screen.findByText("Alice’s private job");
  expect(
    screen.queryByRole("button", { name: "Remove Blacklist filter" }),
  ).not.toBeInTheDocument();
  const request = backend.fetch.mock.calls.find(
    ([path]) =>
      new URL(path, "http://fixture.test").pathname === "/api/v1/jobs",
  );
  expect(
    new URL(request[0], "http://fixture.test").searchParams.has(
      "excludeBlacklistedCompanies",
    ),
  ).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  expect(
    screen.getByLabelText("Exclude blacklisted companies"),
  ).not.toBeChecked();
});
