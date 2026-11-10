import test from "node:test";
import assert from "node:assert/strict";
import { ServiceStore } from "../src/storage/service-store.js";
import { readListPage } from "../src/storage/list-pagination.js";
import { serviceFixture } from "./helpers/service-fixture.js";
import { accountKey } from "../src/core/security.js";

async function fixture() {
  const f = await serviceFixture();
  const cookie = await f.login("alice"),
    bob = await f.login("bob");
  const profiles = [
    await f.connect(cookie, "fixture", "one@provider.test"),
    await f.connect(cookie, "fixture", "two@provider.test"),
  ];
  const foreign = await f.connect(bob, "fixture", "other@provider.test");
  const store = new ServiceStore(f.config.dbPath);
  function save(profile, index, owner = f.users.alice) {
    const writer = new ServiceStore(f.config.dbPath, {
      userId: owner.id,
      connectionId: profile.id,
    });
    const name = `Company ${String(index % 23).padStart(2, "0")}`;
    try {
      return writer.saveJob("jobright", accountKey(profile.label), {
        id: `job-${index}`,
        title: `Role ${String(100 - index).padStart(3, "0")}`,
        company: name,
        url: "https://example.test/job",
        details: {
          description: { text: "Complete content" },
          applicationUrl: "https://employer.test/apply",
          company: { companyName: name },
          matching: { score: index % 5 ? index % 3 : null },
        },
      });
    } finally {
      writer.close();
    }
  }
  for (let i = 0; i < 65; i++) save(profiles[i % 2], i);
  save(foreign, 0, f.users.bob);
  const sync = store.enqueueCompanySync(f.users.alice.id);
  store.claimCompanySync();
  while (store.processCompanySyncBatch(sync.id).status === "running") {
    /* Commit sync batches. */
  }
  async function get(resource, params = {}, session = cookie) {
    const response = await f.request(
      "GET",
      `/api/v1/${resource}?${new URLSearchParams(params)}`,
      undefined,
      session,
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  return {
    ...f,
    store,
    cookie,
    bob,
    profiles,
    save,
    get,
    async close() {
      store.close();
      await f.close();
    },
  };
}

test("numbered job pages expose exact totals, arbitrary jumps, sizes and the final partial page", async () => {
  const f = await fixture();
  try {
    const all = (await f.get("jobs", { limit: 100 })).items;
    for (const limit of [10, 20, 50, 100]) {
      const first = await f.get("jobs", { page: 1, limit });
      assert.equal(first.total, 65);
      assert.equal(first.pageSize, limit);
      assert.equal(first.totalPages, Math.ceil(65 / limit));
      assert.deepEqual(
        first.items.map((job) => job.id),
        all.slice(0, limit).map((job) => job.id),
      );
      const last = await f.get("jobs", { page: first.totalPages, limit });
      assert.deepEqual(
        last.items.map((job) => job.id),
        all.slice((last.page - 1) * limit).map((job) => job.id),
      );
      assert.equal(last.nextCursor, null);
    }
    const third = await f.get("jobs", { page: 3 });
    assert.equal(third.items.length, 20);
    assert.deepEqual(
      third.items.map((job) => job.id),
      all.slice(40, 60).map((job) => job.id),
    );
  } finally {
    await f.close();
  }
});

test("numbered sorting traverses every matching job/company and totals remain owner and profile scoped", async () => {
  const f = await fixture();
  try {
    for (const [resource, fields] of [
      ["jobs", ["title", "totalMatch"]],
      ["companies", ["name", "jobCount", "assignedCount"]],
    ]) {
      for (const sortBy of fields)
        for (const sortOrder of ["asc", "desc"]) {
          const options = {
            connectionId: f.profiles[0].id,
            sortBy,
            sortOrder,
            q: resource === "jobs" ? "Role" : "Company",
          };
          const expected = await f.get(resource, { ...options, limit: 100 });
          const actual = [];
          let pages = 1;
          for (let page = 1; page <= pages; page++) {
            const result = await f.get(resource, {
              ...options,
              page,
              limit: 10,
            });
            assert.equal(result.total, expected.items.length);
            assert.equal(result.page, page);
            pages = result.totalPages;
            actual.push(...result.items);
          }
          assert.deepEqual(
            actual.map((row) => row.id),
            expected.items.map((row) => row.id),
          );
        }
    }
    assert.equal((await f.get("jobs", { page: 1 }, f.bob)).total, 1);
    assert.equal((await f.get("companies", { page: 1 }, f.bob)).total, 0);
    const blocked = f.store.listCompanies(f.users.alice.id).items[0];
    f.store.setCompanyBlacklist(f.users.alice.id, blocked.id, true);
    const expected = f.store.listJobs(f.users.alice.id, {
      excludeBlacklistedCompanies: true,
      limit: 100,
    }).items;
    const result = await f.get("jobs", {
      page: 1,
      excludeBlacklistedCompanies: true,
    });
    assert.equal(result.total, expected.length);
  } finally {
    await f.close();
  }
});

test("empty lists and out-of-range pages have usable metadata and clamp after deletions", async () => {
  const f = await fixture();
  try {
    for (const resource of ["jobs", "companies"]) {
      const empty = await f.get(resource, { page: 99, q: "no-such-record" });
      assert.deepEqual(empty, {
        items: [],
        nextCursor: null,
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      });
      const last = await f.get(resource, { page: 999999, limit: 10 });
      assert.equal(last.page, last.totalPages);
      assert.equal(last.total, resource === "jobs" ? 65 : 23);
    }
    const last = await f.get("jobs", { page: 4 });
    for (const row of last.items) {
      f.store.db
        .prepare("DELETE FROM job_processing WHERE job_id=?")
        .run(row.id);
      f.store.db.prepare("DELETE FROM jobs WHERE id=?").run(row.id);
    }
    const clamped = await f.get("jobs", { page: 4 });
    assert.equal(clamped.page, 3);
    assert.equal(clamped.total, 60);
    assert.equal(clamped.totalPages, 3);
    assert.equal(clamped.items.length, 20);
  } finally {
    await f.close();
  }
});

test("page validation rejects invalid and mixed requests while cursor clients and whole-list actions remain compatible", async () => {
  const f = await fixture();
  try {
    for (const resource of ["jobs", "companies"]) {
      for (const query of [
        "page=0",
        "page=-1",
        "page=1.5",
        "page=abc",
        "page=1000001",
        "page=1&limit=0",
        "page=1&limit=101",
        "page=1&cursor=MQ",
      ]) {
        const response = await f.request(
          "GET",
          `/api/v1/${resource}?${query}`,
          undefined,
          f.cookie,
        );
        assert.equal(response.statusCode, 400, query);
      }
      const old = await f.get(resource, { limit: 10 });
      assert.ok(!Object.hasOwn(old, "total"));
      const next = await f.get(resource, { cursor: old.nextCursor, limit: 10 });
      assert.equal(next.items.length, 10);
      assert.ok(
        next.items.every(
          (row) => !old.items.some((previous) => previous.id === row.id),
        ),
      );
    }
    const query = new URLSearchParams({
      q: "Role",
      sortBy: "title",
      sortOrder: "asc",
    });
    const csv = await f.request(
      "GET",
      `/api/v1/jobs/export?${query}`,
      undefined,
      f.cookie,
    );
    const copied = await f.request(
      "GET",
      `/api/v1/jobs/clipboard?${query}`,
      undefined,
      f.cookie,
    );
    assert.equal(csv.body.trim().split("\r\n").length, 66);
    assert.equal(copied.body.trim().split("\n").length, 66);
    const assigned = await f.request(
      "POST",
      "/api/v1/jobs/assign",
      { q: "Role" },
      f.cookie,
    );
    assert.equal(assigned.json().assignedCount, 65);
    assert.equal(
      (await f.get("jobs", { page: 3, status: "available" })).total,
      0,
    );
  } finally {
    await f.close();
  }
});

test("numbered counts and rows share a read snapshot while another connection saves a job", async () => {
  const f = await fixture();
  try {
    const result = readListPage(
      f.store.db,
      { page: 1, limit: 100 },
      () => {
        const count = f.store.db
          .prepare("SELECT count(*) AS total FROM jobs WHERE user_id=?")
          .get(f.users.alice.id).total;
        f.save(f.profiles[0], 99);
        return count;
      },
      (limit, offset) =>
        f.store.db
          .prepare(
            "SELECT id FROM jobs WHERE user_id=? ORDER BY id LIMIT ? OFFSET ?",
          )
          .all(f.users.alice.id, limit, offset),
    );
    assert.equal(result.metadata.total, 65);
    assert.equal(result.rows.length, 65);
    assert.equal((await f.get("jobs", { page: 1, limit: 100 })).total, 66);
  } finally {
    await f.close();
  }
});
