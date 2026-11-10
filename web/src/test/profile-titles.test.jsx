import { it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { alice, job, profile, mockBackend, renderApp } from "./helpers.jsx";

const sreId = "11111111-1111-4111-8111-111111111111";
const devopsId = "22222222-2222-4222-8222-222222222222";
const foreignId = "33333333-3333-4333-8333-333333333333";
const titles = [
  { id: sreId, title: "SRE", isArchived: false },
  { id: devopsId, title: "DevOps Engineer", isArchived: false },
];
function fixture({
  archived = false,
  selected = false,
  failure = false,
  busy = false,
} = {}) {
  let current = {
    ...profile,
    personName: "Daniel Zhang",
    titles: structuredClone(titles),
  };
  if (archived) current.titles[0].isArchived = true;
  let record = {
    ...job,
    preferredTitleId: selected ? sreId : null,
    preferredTitle: selected ? "SRE" : null,
    preferredTitleArchived: archived && selected,
  };
  const backend = mockBackend(alice, {
    "/connections": ({ json }) => json([current]),
    "/connections/profile-a": ({ options, json }) => {
      current = { ...current, ...JSON.parse(options.body) };
      return json(current);
    },
    "/connections/profile-a/titles": ({ options, json }) => {
      const title = JSON.parse(options.body).title;
      const created = { id: foreignId, title, isArchived: false };
      current = { ...current, titles: [...current.titles, created] };
      return json(created, 201);
    },
    ...Object.fromEntries(
      [...titles, { id: foreignId }].map((title) => [
        `/connections/profile-a/titles/${title.id}`,
        ({ options, json }) => {
          const changes = JSON.parse(options.body);
          current = {
            ...current,
            titles: current.titles.map((item) =>
              item.id === title.id ? { ...item, ...changes } : item,
            ),
          };
          if (record.preferredTitleId === title.id)
            record = {
              ...record,
              preferredTitle: changes.title ?? record.preferredTitle,
              preferredTitleArchived:
                changes.isArchived ?? record.preferredTitleArchived,
            };
          return json(current.titles.find((item) => item.id === title.id));
        },
      ]),
    ),
    "/jobs": ({ json }) =>
      json({
        items: [record],
        nextCursor: null,
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
    "/jobs/1": ({ options, json }) => {
      if (options.method === "PATCH") {
        if (failure)
          return json(
            {
              error: {
                code: "TITLE_ARCHIVED",
                message: "This specialization was archived.",
              },
            },
            409,
          );
        const id = JSON.parse(options.body).preferredTitleId;
        const title = current.titles.find((item) => item.id === id);
        record = {
          ...record,
          preferredTitleId: id,
          preferredTitle: title?.title ?? null,
          preferredTitleArchived: !!title?.isArchived,
        };
      }
      return json(record);
    },
    "/runs": ({ json }) =>
      json({
        items: busy
          ? [
              {
                id: "busy",
                connectionId: profile.id,
                status: "queued",
                counters: {},
              },
            ]
          : [],
        nextCursor: null,
      }),
  });
  return { ...backend, current: () => current, record: () => record };
}

it("manages person names and specialization creation, rename, archive and restore while collection is busy", async () => {
  const f = fixture({ busy: true });
  renderApp("/profiles");
  const user = userEvent.setup();
  expect(
    await screen.findByRole("heading", { name: "Daniel Zhang" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: `Update credentials for ${profile.label}`,
    }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("button", {
      name: "Manage specializations for Daniel Zhang",
    }),
  );
  const dialog = screen.getByRole("dialog", { name: "Manage specializations" });
  await user.clear(
    within(dialog).getByLabelText("Person name", { exact: true }),
  );
  await user.type(
    within(dialog).getByLabelText("Person name", { exact: true }),
    "Daniel Z",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save name" }));
  await screen.findByRole("heading", { name: "Daniel Z" });
  expect(f.current().label).toBe(profile.label);
  await user.type(
    within(dialog).getByLabelText("New specialization"),
    "Platform Engineer",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Add specialization" }),
  );
  await within(dialog).findByText("Platform Engineer", { exact: true });
  await user.click(within(dialog).getByRole("button", { name: "Rename SRE" }));
  await user.clear(within(dialog).getByRole("textbox", { name: "Rename SRE" }));
  await user.type(
    within(dialog).getByRole("textbox", { name: "Rename SRE" }),
    "Site Reliability Engineer",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save title" }));
  await within(dialog).findByRole("button", {
    name: "Archive Site Reliability Engineer",
  });
  await user.click(
    within(dialog).getByRole("button", {
      name: "Archive Site Reliability Engineer",
    }),
  );
  await user.click(
    await within(dialog).findByRole("button", {
      name: "Restore Site Reliability Engineer",
    }),
  );
  await within(dialog).findByRole("button", {
    name: "Archive Site Reliability Engineer",
  });
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    f.fetch.mock.calls.filter(
      ([path, options]) =>
        path.endsWith("/credentials") && options.method === "PATCH",
    ),
  ).toHaveLength(0);
});

it("saves and clears one preferred title without replacing the scraped title or assignment/tracking", async () => {
  const f = fixture();
  renderApp("/jobs");
  const user = userEvent.setup();
  const select = await screen.findByRole("combobox", {
    name: `Preferred title for ${job.title}`,
  });
  await user.selectOptions(select, sreId);
  await waitFor(() => expect(select).toHaveValue(sreId));
  expect(f.record().title).toBe(job.title);
  expect(f.record().processingState).toBe("saved");
  expect(f.record().assignedAt).toBeUndefined();
  await user.click(screen.getByRole("link", { name: `View ${job.title}` }));
  const term = await screen.findByText("Preferred title", { selector: "dt" });
  expect(term.nextElementSibling).toHaveTextContent("SRE");
  await user.click(
    screen.getByRole("link", { name: /^\u2190 Collected jobs$/ }),
  );
  const again = await screen.findByRole("combobox", {
    name: `Preferred title for ${job.title}`,
  });
  await user.selectOptions(again, "");
  await waitFor(() => expect(again).toHaveValue(""));
  expect(f.record().preferredTitleId).toBeNull();
  const calls = f.fetch.mock.calls.filter(
    ([path, options]) =>
      path === "/api/v1/jobs/1" && options.method === "PATCH",
  );
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[1][1].body)).toEqual({ preferredTitleId: null });
});

it("retains archived selections visibly, offers active replacements and excludes archived titles from new choices", async () => {
  fixture({ archived: true, selected: true });
  renderApp("/jobs");
  const select = await screen.findByRole("combobox", {
    name: `Preferred title for ${job.title}`,
  });
  expect(select).toHaveValue(sreId);
  expect(
    within(select).getByRole("option", { name: "SRE (archived)" }),
  ).toBeDisabled();
  expect(
    within(select).getByRole("option", { name: "DevOps Engineer" }),
  ).toBeEnabled();
  const user = userEvent.setup();
  await user.selectOptions(select, devopsId);
  await waitFor(() => expect(select).toHaveValue(devopsId));
  expect(
    within(select).queryByRole("option", { name: "SRE (archived)" }),
  ).not.toBeInTheDocument();
});

it("shows selection failures inline and retains the confirmed value without retrying mutations", async () => {
  const f = fixture({ failure: true });
  renderApp("/jobs");
  const user = userEvent.setup();
  const select = await screen.findByRole("combobox", {
    name: `Preferred title for ${job.title}`,
  });
  await user.selectOptions(select, sreId);
  await screen.findByText("This specialization was archived.");
  expect(select).toHaveValue("");
  expect(select).toBeEnabled();
  expect(
    f.fetch.mock.calls.filter(
      ([path, options]) =>
        path === "/api/v1/jobs/1" && options.method === "PATCH",
    ),
  ).toHaveLength(1);
});

it("preferred-title filters support drafts, grouped profiles, archived titles, reset and profile changes", async () => {
  const first = {
    ...profile,
    personName: "Daniel Zhang",
    titles: [{ ...titles[0], isArchived: true }],
  };
  const second = {
    ...profile,
    id: "profile-b",
    label: "second@provider.test",
    personName: "Other Person",
    titles: [{ id: foreignId, title: "SRE", isArchived: false }],
  };
  const f = mockBackend(alice, {
    "/connections": ({ json }) => json([first, second]),
  });
  renderApp(`/jobs?preferredTitleId=${sreId}&page=3`);
  const user = userEvent.setup();
  const filterButton = await screen.findByRole("button", { name: /^Filters/ });
  await user.click(filterButton);
  const dialog = screen.getByRole("dialog");
  const field = within(dialog).getByRole("combobox", {
    name: "Preferred title",
    exact: true,
  });
  expect(field).toHaveValue(sreId);
  expect(
    within(field).getByRole("option", { name: "SRE (archived)" }),
  ).toBeInTheDocument();
  expect(
    within(field).getByRole("group", { name: /Daniel Zhang/ }),
  ).toBeInTheDocument();
  await user.selectOptions(field, "unselected");
  await user.click(
    within(dialog).getByRole("button", { name: "Cancel", exact: true }),
  );
  expect(
    screen.getByRole("button", { name: "Remove Preferred title filter" }),
  ).toHaveTextContent("SRE");
  await user.click(filterButton);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Profile", exact: true }),
    "profile-b",
  );
  expect(
    screen.getByRole("combobox", { name: "Preferred title", exact: true }),
  ).toHaveValue("");
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Preferred title", exact: true }),
    "unselected",
  );
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(
      f.fetch.mock.calls.some(
        ([path]) =>
          path.includes("preferredTitleId=unselected") &&
          path.includes("connectionId=profile-b") &&
          path.includes("page=1"),
      ),
    ).toBe(true),
  );
  await user.click(
    screen.getByRole("button", { name: "Remove Preferred title filter" }),
  );
  expect(
    screen.queryByRole("button", { name: "Remove Preferred title filter" }),
  ).not.toBeInTheDocument();
});

it("sorts the new column and renders profile/title text safely", async () => {
  const unsafe = '<img src=x onerror="window.compromised=true">';
  const f = mockBackend(alice, {
    "/connections": ({ json }) =>
      json([
        {
          ...profile,
          personName: unsafe,
          titles: [{ ...titles[0], title: unsafe }],
        },
      ]),
    "/jobs": ({ json }) =>
      json({
        items: [{ ...job, preferredTitleId: sreId, preferredTitle: unsafe }],
        nextCursor: null,
      }),
  });
  renderApp("/jobs");
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Sort by Preferred title" }),
  );
  await waitFor(() =>
    expect(
      f.fetch.mock.calls.some(
        ([path]) =>
          path.includes("sortBy=preferredTitle") &&
          path.includes("sortOrder=asc"),
      ),
    ).toBe(true),
  );
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("option", { name: unsafe })).toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: `Preferred title for ${job.title}` }),
  ).toHaveValue(sreId);
});
