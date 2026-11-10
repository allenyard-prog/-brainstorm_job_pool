import { it, expect } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockBackend, renderApp, profile, alice, job } from "./helpers.jsx";
import { localDayBound } from "../job-filters.js";

const jobRequests = (backend) =>
  backend.fetch.mock.calls.filter(
    ([path]) =>
      new URL(path, "http://fixture.test").pathname === "/api/v1/jobs",
  );
it("keeps edits as a draft, applies combined ranges atomically, and resets pagination", async () => {
  const backend = mockBackend();
  renderApp("/jobs?q=Engineer&cursor=second&stack=%5B%22%22%5D");
  await screen.findByText("Alice’s private job");
  const user = userEvent.setup();
  const before = jobRequests(backend).length;
  await user.click(screen.getByRole("button", { name: "Filters" }));
  const dialog = screen.getByRole("dialog", { name: "Job filters" });
  expect(within(dialog).getByLabelText("Company name")).toHaveFocus();
  await user.type(screen.getByLabelText("Company name"), "Acme");
  for (const [label, value] of [
    ["Posted from", "2026-11-01"],
    ["Posted to", "2026-11-08"],
    ["Registered from", "2026-11-02"],
    ["Registered to", "2026-11-09"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  for (const [label, value] of [
    ["Total match minimum", "0"],
    ["Total match maximum", "90.125"],
    ["Skill match minimum", "75"],
    ["Industry match maximum", "95"],
  ])
    await user.type(screen.getByLabelText(label), value);
  await user.selectOptions(screen.getByLabelText("Profile"), profile.id);
  await user.selectOptions(screen.getByLabelText("Job site"), "jobright");
  await user.selectOptions(screen.getByLabelText("Tracking status"), "saved");
  expect(jobRequests(backend)).toHaveLength(before);
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(jobRequests(backend).length).toBeGreaterThan(before),
  );
  const url = new URL(jobRequests(backend).at(-1)[0], "http://fixture.test");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    q: "Engineer",
    company: "Acme",
    postedFrom: "2026-11-01",
    postedTo: "2026-11-08",
    registeredFrom: localDayBound("2026-11-02"),
    registeredTo: localDayBound("2026-11-09", true),
    totalMatchMin: "0",
    totalMatchMax: "90.125",
    skillMatchMin: "75",
    industryMatchMax: "95",
    connectionId: profile.id,
    site: "jobright",
    status: "saved",
  });
  expect(url.searchParams.has("cursor")).toBe(false);
  expect(url.searchParams.has("stack")).toBe(false);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Remove Total match filter" }),
  ).toHaveTextContent("0 – 90.125");
  await user.click(
    screen.getByRole("button", { name: "Remove Skill match filter" }),
  );
  await waitFor(() =>
    expect(
      new URL(
        jobRequests(backend).at(-1)[0],
        "http://fixture.test",
      ).searchParams.has("skillMatchMin"),
    ).toBe(false),
  );
});

it("cancel, Escape and reset discard or retain drafts without silently changing applied filters", async () => {
  const backend = mockBackend();
  renderApp("/jobs?company=Acme&totalMatchMin=0");
  await screen.findByText("Alice’s private job");
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: /^Filters/ });
  await user.click(trigger);
  await user.type(screen.getByLabelText("Company name"), " changed");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(screen.getByLabelText("Company name")).toHaveValue("Acme");
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.getByLabelText("Company name")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Remove Company filter" }),
  ).toBeInTheDocument();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: false, cancelable: true }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(jobRequests(backend)).toHaveLength(1);
  await user.click(trigger);
  expect(screen.getByLabelText("Total match minimum")).toHaveValue(0);
  await user.click(screen.getByRole("button", { name: "Reset" }));
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove Company filter" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    new URL(
      jobRequests(backend).at(-1)[0],
      "http://fixture.test",
    ).searchParams.has("totalMatchMin"),
  ).toBe(false);
});

it("reports invalid ranges and does not send them to the backend", async () => {
  const backend = mockBackend();
  renderApp("/jobs");
  await screen.findByText("Alice’s private job");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.change(screen.getByLabelText("Posted from"), {
    target: { value: "2026-11-09" },
  });
  fireEvent.change(screen.getByLabelText("Posted to"), {
    target: { value: "2026-11-08" },
  });
  await user.type(screen.getByLabelText("Total match minimum"), "101");
  await user.type(screen.getByLabelText("Skill match minimum"), "90");
  await user.type(screen.getByLabelText("Skill match maximum"), "80");
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  expect(screen.getAllByRole("alert")).toHaveLength(3);
  expect(screen.getByLabelText("Posted from")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(jobRequests(backend)).toHaveLength(1);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("passes every applied advanced filter to bulk actions and displays normalized metrics", async () => {
  const backend = mockBackend(alice, {
    "/jobs": ({ json }) =>
      json({
        items: [
          {
            ...job,
            firstSeenAt: "2026-11-08T12:00:00Z",
            postedDate: "2026-11-01",
            matchingScores: { total: 84.4677, skill: 0, industry: null },
          },
        ],
        nextCursor: null,
      }),
    "/jobs/assign": ({ json }) => json({ assignedCount: 1 }),
  });
  renderApp(
    "/jobs?company=Acme&postedFrom=2026-11-01&registeredTo=2026-11-09T23%3A59%3A59.999Z&totalMatchMin=0&skillMatchMax=80.125&industryMatchMin=50&connectionId=profile-a&cursor=page-two",
  );
  await screen.findByText("Total 84.5%");
  expect(screen.getByText("Skill 0% · Industry —")).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Assign all Jobs" }),
  );
  await screen.findByText("1 job assigned.");
  const request = backend.fetch.mock.calls.find(
    ([path]) => path === "/api/v1/jobs/assign",
  );
  expect(JSON.parse(request[1].body)).toEqual({
    company: "Acme",
    postedFrom: "2026-11-01",
    registeredTo: "2026-11-09T23:59:59.999Z",
    totalMatchMin: 0,
    skillMatchMax: 80.125,
    industryMatchMin: 50,
    connectionId: profile.id,
  });
});
