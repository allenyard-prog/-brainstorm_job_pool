import { it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { alice, job, mockBackend, renderApp } from "./helpers.jsx";

function fixture(resource, { url, json }) {
  const total = url.searchParams.get("q") === "none" ? 0 : 105;
  const size = Number(url.searchParams.get("limit") ?? 20);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Number(url.searchParams.get("page") ?? 1), totalPages);
  const items = Array.from(
    { length: Math.min(size, Math.max(0, total - (page - 1) * size)) },
    (_, i) => {
      const id = (page - 1) * size + i + 1;
      return resource === "jobs"
        ? { ...job, id, title: `Opportunity ${id}` }
        : {
            id,
            name: `Company ${id}`,
            jobCount: id,
            assignedCount: 0,
            markedAppliedCount: 0,
            isBlacklisted: false,
          };
    },
  );
  return json({
    items,
    nextCursor: null,
    total,
    page,
    pageSize: size,
    totalPages,
  });
}
function backend() {
  return mockBackend(alice, {
    "/jobs": (args) => fixture("jobs", args),
    "/companies": (args) => fixture("companies", args),
  });
}
function lastQuery(mock, resource) {
  return mock.fetch.mock.calls
    .map(([path]) => new URL(path, "http://local"))
    .filter((url) => url.pathname === `/api/v1/${resource}`)
    .at(-1).searchParams;
}

for (const [resource, label] of [
  ["jobs", "Jobs"],
  ["companies", "Companies"],
]) {
  it(`${resource}: shows totals and ranges, jumps to arbitrary pages and changes rows per page`, async () => {
    const mock = backend();
    renderApp(
      `/${resource}?q=Tech&page=3&pageSize=10&sortBy=${resource === "jobs" ? "title" : "name"}&sortOrder=desc`,
    );
    const user = userEvent.setup();
    const pager = await screen.findByRole("navigation", {
      name: `${label} pagination`,
    });
    expect(
      within(pager).getByText(`Showing 21–30 of 105 ${resource}`),
    ).toBeInTheDocument();
    expect(within(pager).getByText("Page 3 of 11")).toBeInTheDocument();
    expect(
      within(pager).getByRole("button", { name: "Page 3", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(pager).getByRole("combobox", { name: "Rows per page" }),
    ).toHaveValue("10");
    await user.clear(
      within(pager).getByRole("spinbutton", { name: "Go to page" }),
    );
    await user.type(
      within(pager).getByRole("spinbutton", { name: "Go to page" }),
      "7",
    );
    await user.click(
      within(pager).getByRole("button", { name: "Go", exact: true }),
    );
    await screen.findByText(`Showing 61–70 of 105 ${resource}`);
    expect(lastQuery(mock, resource).get("q")).toBe("Tech");
    expect(lastQuery(mock, resource).get("sortOrder")).toBe("desc");
    await user.click(
      screen.getByRole("button", { name: "Page 11", exact: true }),
    );
    await screen.findByText(`Showing 101–105 of 105 ${resource}`);
    expect(
      screen.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Rows per page" }),
      "50",
    );
    await screen.findByText(`Showing 1–50 of 105 ${resource}`);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(lastQuery(mock, resource).get("page")).toBe("1");
    expect(lastQuery(mock, resource).get("limit")).toBe("50");
    expect(
      screen.getByRole("button", { name: "Previous", exact: true }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Page 3", exact: true }),
    );
    await screen.findByText(`Showing 101–105 of 105 ${resource}`);
  });

  it(`${resource}: filters and sorting reset page numbers while empty lists retain accurate controls`, async () => {
    const mock = backend();
    renderApp(`/${resource}?page=4&pageSize=10`);
    const user = userEvent.setup();
    await screen.findByText(`Showing 31–40 of 105 ${resource}`);
    await user.click(
      screen.getByRole("button", {
        name: resource === "jobs" ? "Sort by Job" : "Sort by Company",
        exact: true,
      }),
    );
    await screen.findByText(`Showing 1–10 of 105 ${resource}`);
    expect(lastQuery(mock, resource).get("limit")).toBe("10");
    await user.click(
      screen.getByRole("button", { name: "Page 3", exact: true }),
    );
    await screen.findByText(`Showing 21–30 of 105 ${resource}`);
    await user.type(
      screen.getByRole("searchbox", {
        name: resource === "jobs" ? "Search jobs" : "Search companies",
        exact: true,
      }),
      "none",
    );
    await user.click(
      screen.getByRole("button", {
        name: resource === "jobs" ? "Search" : "Search companies",
        exact: true,
      }),
    );
    await screen.findByText(`Showing 0–0 of 0 ${resource}`);
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous", exact: true }),
    ).toBeDisabled();
    expect(
      screen.getByRole("spinbutton", { name: "Go to page" }),
    ).toBeDisabled();
    expect(lastQuery(mock, resource).get("page")).toBe("1");
    expect(lastQuery(mock, resource).get("sortOrder")).toBe("asc");
  });
}

it("clamps an obsolete page from the server and repairs the URL without discarding filters", async () => {
  const mock = backend();
  renderApp("/jobs?page=999&pageSize=50&q=Tech");
  await screen.findByText("Showing 101–105 of 105 jobs");
  await waitFor(() => expect(lastQuery(mock, "jobs").get("page")).toBe("3"));
  expect(lastQuery(mock, "jobs").get("q")).toBe("Tech");
  expect(lastQuery(mock, "jobs").get("limit")).toBe("50");
});

it("disables pagination while fetching another page and keeps the visible table stable", async () => {
  let release;
  mockBackend(alice, {
    "/jobs": (args) =>
      args.url.searchParams.get("page") === "2"
        ? new Promise((resolve) => {
            release = () => resolve(fixture("jobs", args));
          })
        : fixture("jobs", args),
  });
  renderApp("/jobs");
  const user = userEvent.setup();
  await screen.findByText("Showing 1–20 of 105 jobs");
  await user.click(screen.getByRole("button", { name: "Page 2", exact: true }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(
    screen.getByRole("navigation", { name: "Jobs pagination" }),
  ).toHaveAttribute("aria-busy", "true");
  expect(
    screen.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  expect(
    screen.getByRole("combobox", { name: "Rows per page" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("link", { name: "View Opportunity 1", exact: true }),
  ).toBeInTheDocument();
  release();
  await screen.findByText("Showing 21–40 of 105 jobs");
});

it("normalizes invalid page parameters and legacy UI cursor links", async () => {
  const mock = backend();
  renderApp(
    "/companies?page=bad&pageSize=13&cursor=old&stack=%5B%22%22%5D&q=Tech",
  );
  await screen.findByText("Showing 1–20 of 105 companies");
  expect(lastQuery(mock, "companies").get("page")).toBe("1");
  expect(lastQuery(mock, "companies").get("limit")).toBe("20");
  expect(lastQuery(mock, "companies").has("cursor")).toBe(false);
  expect(lastQuery(mock, "companies").get("q")).toBe("Tech");
});
