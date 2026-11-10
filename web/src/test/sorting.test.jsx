import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { alice, job, profile, mockBackend, renderApp } from "./helpers.jsx";

const company = {
  id: 1,
  name: "Example Company",
  domain: "example.test",
  location: "Austin",
  industry: "Software",
  jobCount: 5,
  assignedCount: 2,
  markedAppliedCount: 1,
  isBlacklisted: false,
  details: {},
};
const requests = (backend, path) =>
  backend.fetch.mock.calls
    .map(([url]) => new URL(url, "http://127.0.0.1"))
    .filter((url) => url.pathname === `/api/v1/${path}`);

describe("sortable list headers", () => {
  it("restores job sorting, resets pagination, preserves filters and retains keyboard focus", async () => {
    const backend = mockBackend(alice, {
      "/jobs": ({ json, url }) => json({ items: [job], nextCursor: "next", total: 40, page: Number(url.searchParams.get('page') ?? 1), pageSize: 20, totalPages: 2 }),
    });
    renderApp(
      `/jobs?company=Example&connectionId=${profile.id}&sortBy=skillMatch&sortOrder=desc&cursor=old&stack=%5B%22%22%5D`,
    );
    const user = userEvent.setup();
    const skill = await screen.findByRole("button", {
      name: "Sort by Skill match",
    });
    expect(skill).toHaveAttribute("aria-pressed", "true");
    expect(skill.closest("th")).toHaveAttribute("aria-sort", "descending");
    const registered = screen.getByRole("button", {
      name: "Sort by Registered",
    });
    registered.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(requests(backend, "jobs").at(-1).searchParams.get("sortBy")).toBe(
        "firstSeenAt",
      ),
    );
    const query = requests(backend, "jobs").at(-1).searchParams;
    expect(query.get("sortOrder")).toBe("asc");
    expect(query.has("cursor")).toBe(false);
    expect(query.get("company")).toBe("Example");
    expect(query.get("connectionId")).toBe(profile.id);
    expect(
      screen.getByRole("button", { name: "Sort by Registered" }),
    ).toHaveFocus();
    expect(registered.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        requests(backend, "jobs").at(-1).searchParams.get("sortOrder"),
      ).toBe("desc"),
    );
    expect(registered.closest("th")).toHaveAttribute("aria-sort", "descending");
    await user.click(screen.getByRole("button", { name: "Next", exact: true }));
    await waitFor(() =>
      expect(requests(backend, "jobs").at(-1).searchParams.get("page")).toBe(
        "2",
      ),
    );
    expect(requests(backend, "jobs").at(-1).searchParams.get("sortBy")).toBe(
      "firstSeenAt",
    );
  });

  it("provides controls for each job value and keeps sorting out of the filter count", async () => {
    mockBackend(alice);
    renderApp("/jobs?sortBy=company&sortOrder=asc");
    await screen.findByRole("button", { name: "Sort by Company" });
    for (const label of [
      "Job",
      "Company",
      "Profile",
      "Tracking",
      "Posted",
      "Registered",
      "Total match",
      "Skill match",
      "Industry match",
    ]) {
      expect(
        screen.getByRole("button", { name: `Sort by ${label}`, exact: true }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Filters", exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Applied filters")).not.toBeInTheDocument();
  });

  it("preserves job sorting when opening details and returning to the list", async () => {
    const backend = mockBackend(alice, {
      "/jobs": ({ json }) => json({ items: [job], nextCursor: null }),
    });
    renderApp("/jobs?sortBy=totalMatch&sortOrder=desc&q=Engineer");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("link", {
        name: `View ${job.title}`,
        exact: true,
      }),
    );
    const back = await screen.findByRole("link", {
      name: /^\u2190 Collected jobs$/,
    });
    expect(back).toHaveAttribute(
      "href",
      "/jobs?sortBy=totalMatch&sortOrder=desc&q=Engineer",
    );
    await user.click(back);
    await screen.findByRole("button", {
      name: "Sort by Total match",
      pressed: true,
    });
    expect(requests(backend, "jobs").at(-1).searchParams.get("q")).toBe(
      "Engineer",
    );
  });

  it("sorts company values with search/profile filters and restores state after detail navigation", async () => {
    const backend = mockBackend(alice, {
      "/companies": ({ json }) =>
        json({ items: [company], nextCursor: "companies-next" }),
      "/companies/1": ({ json }) => json(company),
    });
    renderApp(
      `/companies?q=Example&connectionId=${profile.id}&sortBy=jobCount&sortOrder=desc&cursor=old`,
    );
    const user = userEvent.setup();
    const collected = await screen.findByRole("button", {
      name: "Sort by Collected jobs",
      pressed: true,
    });
    expect(collected.closest("th")).toHaveAttribute("aria-sort", "descending");
    for (const label of [
      "Company",
      "Website",
      "Location",
      "Industry",
      "Collected jobs",
      "Assigned",
      "Marked applied",
      "Blacklist",
    ]) {
      expect(
        screen.getByRole("button", { name: `Sort by ${label}`, exact: true }),
      ).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Sort by Assigned" }));
    await waitFor(() =>
      expect(
        requests(backend, "companies").at(-1).searchParams.get("sortBy"),
      ).toBe("assignedCount"),
    );
    const params = requests(backend, "companies").at(-1).searchParams;
    expect(params.get("sortOrder")).toBe("asc");
    expect(params.get("q")).toBe("Example");
    expect(params.get("connectionId")).toBe(profile.id);
    expect(params.has("cursor")).toBe(false);
    await user.click(
      screen.getByRole("link", { name: "View Example Company", exact: true }),
    );
    const back = await screen.findByRole("link", {
      name: /^\u2190 Companies$/,
    });
    expect(back.getAttribute("href")).toContain("sortBy=assignedCount");
    await user.click(back);
    await screen.findByRole("button", {
      name: "Sort by Assigned",
      pressed: true,
    });
  });

  it("sends ordering to copy/export but sends only filters to bulk assignment", async () => {
    const backend = mockBackend(alice, {
      "/jobs": ({ json }) => json({ items: [job], nextCursor: null }),
      "/jobs/clipboard": () =>
        new Response(
          "Company Name\tJob Title\tLink\nExample\tEngineer\thttps://employer.test\n",
        ),
      "/jobs/assign": ({ json }) => json({ assignedCount: 1 }),
    });
    renderApp("/jobs?company=Example&sortBy=totalMatch&sortOrder=desc");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Copy Available Jobs",
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(requests(backend, "jobs/clipboard")).toHaveLength(1),
    );
    expect(
      requests(backend, "jobs/clipboard")[0].searchParams.get("sortBy"),
    ).toBe("totalMatch");
    await user.click(
      screen.getByRole("button", { name: "Assign all Jobs", exact: true }),
    );
    await waitFor(() =>
      expect(requests(backend, "jobs/assign")).toHaveLength(1),
    );
    const [, options] = backend.fetch.mock.calls.find(
      ([url]) => url === "/api/v1/jobs/assign",
    );
    expect(JSON.parse(options.body)).toEqual({ company: "Example" });
  });
});
