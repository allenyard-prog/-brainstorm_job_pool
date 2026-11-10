import test from "node:test";
import assert from "node:assert/strict";
import { ServiceStore } from "../src/storage/service-store.js";
import { serviceFixture } from "./helpers/service-fixture.js";
import { accountKey } from "../src/core/security.js";

async function fixture() {
  const f = await serviceFixture();
  const cookie = await f.login("alice"),
    bob = await f.login("bob");
  const profiles = [
    await f.connect(cookie, "fixture", "zulu@provider.test"),
    await f.connect(cookie, "fixture", "alpha@provider.test"),
  ];
  const foreign = await f.connect(bob, "fixture", "foreign@provider.test");
  const store = new ServiceStore(f.config.dbPath);
  function save(profile, title, company, index = 0, owner = f.users.alice) {
    const writer = new ServiceStore(f.config.dbPath, {
      connectionId: profile.id,
      userId: owner.id,
    });
    try {
      return writer.saveJob("jobright", accountKey(profile.label), {
        id: `${title}-${index}`,
        title,
        company,
        url: "https://example.test/job",
        details: {
          description: { text: "Full content" },
          applicationUrl: "https://employer.test/apply",
          company: {
            companyName: company,
            companyLocation: index % 2 ? "Austin" : "New York",
            companyIndustry: index % 2 ? "Software" : "Energy",
            companyURL: company
              ? `https://${company.toLowerCase()}.test`
              : null,
          },
        },
      });
    } finally {
      writer.close();
    }
  }
  const ids = ["beta", "Alpha", "alpha", "Zulu", "Omega", "Gamma"].map(
    (title, i) => {
      const id = save(
        profiles[i % 2],
        title,
        ["Cedar", "Acme", "Beta", "Acme", "Delta", null][i],
        i,
      );
      store.db
        .prepare(
          "UPDATE jobs SET posted_date=?,first_seen_at=?,last_scraped_at=?,match_total_score=?,match_skill_score=?,match_industry_score=?,assigned_at=? WHERE id=?",
        )
        .run(
          ["2026-11-01", "2026-11-02", null, "2026-11-01", null, "2026-11-03"][
            i
          ],
          `2026-11-0${1 + (i % 3)}T00:00:00.000Z`,
          `2026-11-0${1 + (i % 2)}T12:00:00.000Z`,
          [0, 10.25, null, 10.25, 100, 7][i],
          [50, null, 0, 50, 90, 10.5][i],
          [null, 80, 0, 80, 40, 3][i],
          i === 0 ? "2026-11-09T00:00:00Z" : null,
          id,
        );
      if (i === 1)
        store.transition(id, accountKey(profiles[i % 2].label), "mark_pending");
      if (i === 2)
        store.transition(
          id,
          accountKey(profiles[i % 2].label),
          "mark_confirmed",
          "applied",
        );
      return id;
    },
  );
  save(foreign, "Aardvark private", "Foreign", 0, f.users.bob);
  const sync = store.enqueueCompanySync(f.users.alice.id);
  store.claimCompanySync();
  while (store.processCompanySyncBatch(sync.id).status === "running") {
    /* Commit batches. */
  }
  const companies = store.listCompanies(f.users.alice.id).items;
  store.setCompanyBlacklist(
    f.users.alice.id,
    companies.find((company) => company.name === "Cedar").id,
    true,
  );
  async function walk(resource, options = {}, session = cookie) {
    const items = [];
    let cursor;
    for (let i = 0; i < 100; i++) {
      const query = new URLSearchParams({
        limit: "2",
        ...options,
        ...(cursor ? { cursor } : {}),
      });
      const response = await f.request(
        "GET",
        `/api/v1/${resource}?${query}`,
        undefined,
        session,
      );
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json();
      items.push(...page.items);
      if (!page.nextCursor) return items;
      cursor = page.nextCursor;
    }
    assert.fail("Pagination did not terminate");
  }
  return {
    ...f,
    cookie,
    bob,
    profiles,
    store,
    ids,
    save,
    walk,
    async close() {
      store.close();
      await f.close();
    },
  };
}

function expected(rows, value, order) {
  const normalize = (entry) =>
    typeof entry === "string"
      ? entry.trim().toLowerCase() || null
      : (entry ?? null);
  return [...rows]
    .sort((a, b) => {
      const x = normalize(value(a)),
        y = normalize(value(b));
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      return (
        ((x < y ? -1 : x > y ? 1 : 0) || a.id - b.id) *
        (order === "asc" ? 1 : -1)
      );
    })
    .map((row) => row.id);
}

test("every job sort is global, owner-scoped and stable across ties and unknown values in both directions", async () => {
  const f = await fixture();
  try {
    const rows = f.store.listJobs(f.users.alice.id).items;
    const values = {
      id: (row) => row.id,
      title: (row) => row.title,
      company: (row) => row.company,
      profile: (row) =>
        f.profiles.find((profile) => profile.id === row.connectionId).label,
      tracking: (row) =>
        row.assignedAt
          ? "Assigned"
          : {
              saved: "Saved",
              mark_pending: "Update unconfirmed",
              mark_confirmed: "Marked applied",
            }[row.processingState],
      postedDate: (row) => row.postedDate,
      firstSeenAt: (row) => row.firstSeenAt,
      lastScrapedAt: (row) => row.lastScrapedAt,
      totalMatch: (row) => row.matchingScores.total,
      skillMatch: (row) => row.matchingScores.skill,
      industryMatch: (row) => row.matchingScores.industry,
    };
    for (const [sortBy, value] of Object.entries(values))
      for (const sortOrder of ["asc", "desc"]) {
        const result = await f.walk("jobs", { sortBy, sortOrder });
        assert.deepEqual(
          result.map((row) => row.id),
          expected(rows, value, sortOrder),
          `${sortBy} ${sortOrder}`,
        );
        assert.ok(result.every((row) => !row.title.includes("private")));
        assert.ok(result.every((row) => !Object.hasOwn(row, "sort_value")));
      }
    const other = await f.walk(
      "jobs",
      { sortBy: "title", sortOrder: "asc" },
      f.bob,
    );
    assert.deepEqual(
      other.map((row) => row.title),
      ["Aardvark private"],
    );
  } finally {
    await f.close();
  }
});

test("all company columns sort across pages with current counts, blacklist and profile filtering", async () => {
  const f = await fixture();
  try {
    for (const connectionId of ["", f.profiles[0].id]) {
      const rows = f.store.listCompanies(f.users.alice.id, {
        connectionId,
      }).items;
      for (const sortBy of [
        "id",
        "name",
        "domain",
        "location",
        "industry",
        "jobCount",
        "assignedCount",
        "markedAppliedCount",
        "isBlacklisted",
      ]) {
        for (const sortOrder of ["asc", "desc"]) {
          const result = await f.walk("companies", {
            connectionId,
            sortBy,
            sortOrder,
          });
          assert.deepEqual(
            result.map((row) => row.id),
            expected(
              rows,
              (row) =>
                typeof row[sortBy] === "boolean"
                  ? Number(row[sortBy])
                  : row[sortBy],
              sortOrder,
            ),
            `${sortBy} ${sortOrder}`,
          );
          assert.ok(result.every((row) => row.name !== "Foreign"));
        }
      }
    }
  } finally {
    await f.close();
  }
});

test("sorting validates columns, directions and cursor compatibility while preserving legacy cursors", async () => {
  const f = await fixture();
  try {
    for (const resource of ["jobs", "companies"]) {
      for (const query of [
        "sortBy=__proto__",
        "sortBy=title%20DESC%3BDROP%20TABLE%20jobs",
        "sortOrder=sideways",
        "cursor=malformed",
      ]) {
        assert.equal(
          (
            await f.request(
              "GET",
              `/api/v1/${resource}?${query}`,
              undefined,
              f.cookie,
            )
          ).statusCode,
          400,
        );
      }
      const sortBy = resource === "jobs" ? "title" : "name";
      const page = (
        await f.request(
          "GET",
          `/api/v1/${resource}?sortBy=${sortBy}&sortOrder=asc&limit=2`,
          undefined,
          f.cookie,
        )
      ).json();
      const cursor = encodeURIComponent(page.nextCursor);
      assert.equal(
        (
          await f.request(
            "GET",
            `/api/v1/${resource}?sortBy=${sortBy}&sortOrder=desc&cursor=${cursor}`,
            undefined,
            f.cookie,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await f.request(
            "GET",
            `/api/v1/${resource}?sortBy=id&cursor=${cursor}`,
            undefined,
            f.cookie,
          )
        ).statusCode,
        400,
      );
      const legacy = (
        await f.request(
          "GET",
          `/api/v1/${resource}?limit=2`,
          undefined,
          f.cookie,
        )
      ).json();
      assert.match(
        Buffer.from(legacy.nextCursor, "base64url").toString(),
        /^\d+$/,
      );
      assert.equal(
        (
          await f.request(
            "GET",
            `/api/v1/${resource}?cursor=${legacy.nextCursor}`,
            undefined,
            f.cookie,
          )
        ).statusCode,
        200,
      );
      const owned = await f.walk(
        resource,
        { sortBy, sortOrder: "asc", cursor: page.nextCursor },
        f.bob,
      );
      assert.ok(
        owned.every((row) =>
          resource === "jobs"
            ? row.title.includes("private")
            : row.name === "Foreign",
        ),
      );
    }
  } finally {
    await f.close();
  }
});

test("sorted pagination does not shift when an earlier job is inserted, and long sort keys round trip", async () => {
  const f = await fixture();
  try {
    const page = (
      await f.request(
        "GET",
        "/api/v1/jobs?sortBy=title&sortOrder=asc&limit=2",
        undefined,
        f.cookie,
      )
    ).json();
    f.save(f.profiles[0], "Aardvark new", "New");
    const remaining = await f.walk("jobs", {
      sortBy: "title",
      sortOrder: "asc",
      cursor: page.nextCursor,
    });
    assert.ok(
      !remaining.some((row) => page.items.some((first) => first.id === row.id)),
    );
    assert.ok(!remaining.some((row) => row.title === "Aardvark new"));
    assert.equal(remaining.length, 4);
    const title = "L".repeat(800);
    f.save(f.profiles[0], title, "Long");
    f.save(f.profiles[0], title + "Z", "Long", 1);
    const long = await f.walk("jobs", {
      q: "LLLL",
      sortBy: "title",
      sortOrder: "asc",
      limit: "1",
    });
    assert.deepEqual(
      long.map((row) => row.title),
      [title, title + "Z"],
    );
  } finally {
    await f.close();
  }
});

test("sorted job exports and clipboard span pages and keep filters and bulk assignment unchanged", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 105; i++)
      f.save(
        f.profiles[i % 2],
        `Export ${String(104 - i).padStart(3, "0")}`,
        "Export",
        i,
      );
    const filters = { q: "Export", sortBy: "title", sortOrder: "asc" };
    const rows = await f.walk("jobs", filters);
    const query = new URLSearchParams(filters);
    const csv = await f.request(
      "GET",
      `/api/v1/jobs/export?${query}`,
      undefined,
      f.cookie,
    );
    assert.equal(csv.statusCode, 200);
    const exported = csv.body
      .trim()
      .split("\r\n")
      .slice(1)
      .map((line) => Number(line.match(/^"(\d+)"/)[1]));
    assert.deepEqual(
      exported,
      rows.map((row) => row.id),
    );
    const clipboard = await f.request(
      "GET",
      `/api/v1/jobs/clipboard?${query}`,
      undefined,
      f.cookie,
    );
    assert.equal(clipboard.statusCode, 200);
    assert.deepEqual(
      clipboard.body
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.split("\t")[1]),
      rows.map((row) => row.title),
    );
    const assignment = await f.request(
      "POST",
      "/api/v1/jobs/assign",
      { q: "Export" },
      f.cookie,
    );
    assert.equal(assignment.json().assignedCount, 105);
    assert.equal(
      (await f.walk("jobs", { ...filters, status: "assigned" })).length,
      105,
    );
    const blocked = await f.walk("jobs", {
      sortBy: "company",
      sortOrder: "asc",
      excludeBlacklistedCompanies: "true",
      totalMatchMin: "0",
    });
    assert.ok(
      blocked.every(
        (row) => row.company !== "Cedar" && row.matchingScores.total !== null,
      ),
    );
  } finally {
    await f.close();
  }
});
