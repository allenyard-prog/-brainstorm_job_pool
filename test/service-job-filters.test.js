import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./helpers/service-fixture.js";
import { ServiceStore } from "../src/storage/service-store.js";
import { accountKey } from "../src/core/security.js";

async function setup() {
  const f = await serviceFixture(),
    cookie = await f.login("alice"),
    profile = await f.connect(cookie);
  const store = new ServiceStore(f.config.dbPath, {
    userId: f.users.alice.id,
    connectionId: profile.id,
  });
  const ids = [];
  const account = accountKey(profile.label);
  try {
    for (let i = 0; i < 31; i++) {
      const id = store.saveJob("jobright", account, {
        id: String(i),
        title: `Filter Engineer ${i}`,
        company: i === 25 ? "AcmeX100 Lab" : "Acme_100% Labs",
        url: `https://fixture.test/jobs/${i}`,
        details: {
          description: { text: "Preserved job description" },
          applicationUrl: `https://employer.test/apply/${i}`,
          postedAt:
            i === 26
              ? "2026-11-07"
              : i === 27
                ? "1 day ago"
                : "2026-11-08 23:30:00",
          matching:
            i === 28
              ? {}
              : {
                  score: i === 29 ? 80.124999 : i === 30 ? 0 : 80.125,
                  recommendations: [
                    { featureName: "q_job_skill_match", score: 0.9 },
                    { featureName: "q_industry_match", score: 0.75 },
                  ],
                },
        },
      });
      store.db
        .prepare("UPDATE jobs SET first_seen_at=?,last_scraped_at=? WHERE id=?")
        .run(
          i === 24 ? "2026-11-09T00:00:00.000Z" : "2026-11-08T12:00:00.000Z",
          "2026-12-01T00:00:00.000Z",
          id,
        );
      ids.push(id);
    }
  } finally {
    store.close();
  }
  const filters = {
    company: "acme_100%",
    postedFrom: "2026-11-08",
    postedTo: "2026-11-08",
    registeredFrom: "2026-11-08T00:00:00Z",
    registeredTo: "2026-11-08T23:59:59.999Z",
    totalMatchMin: 80.125,
    totalMatchMax: 80.125,
    skillMatchMin: 90,
    skillMatchMax: 90,
    industryMatchMin: 75,
    industryMatchMax: 75,
    connectionId: profile.id,
    site: "jobright",
    q: "Filter Engineer",
  };
  return { ...f, cookie, profile, filters, ids };
}
const query = (values) => new URLSearchParams(values).toString();

test("advanced filters combine inclusively, paginate and constrain export, clipboard and assignment identically", async () => {
  const f = await setup();
  try {
    const get = async (values) =>
      (
        await f.request(
          "GET",
          "/api/v1/jobs?" + query(values),
          undefined,
          f.cookie,
        )
      ).json();
    let page = await get({ ...f.filters, limit: 20 });
    assert.equal(page.items.length, 20);
    assert.ok(page.nextCursor);
    assert.deepEqual(page.items[0].matchingScores, {
      total: 80.125,
      skill: 90,
      industry: 75,
    });
    assert.equal(page.items[0].postedDate, "2026-11-08");
    const all = [
      ...page.items,
      ...(await get({ ...f.filters, cursor: page.nextCursor })).items,
    ];
    assert.equal(all.length, 24);
    assert.deepEqual(
      all.map((job) => job.id).sort((a, b) => a - b),
      f.ids.slice(0, 24),
    );
    const csv = await f.request(
      "GET",
      "/api/v1/jobs/export?" + query(f.filters),
      undefined,
      f.cookie,
    );
    assert.equal(csv.statusCode, 200);
    assert.equal(csv.body.trim().split("\r\n").length, 25);
    const clip = await f.request(
      "GET",
      "/api/v1/jobs/clipboard?" + query(f.filters),
      undefined,
      f.cookie,
    );
    assert.equal(clip.statusCode, 200);
    assert.equal(clip.body.trim().split("\n").length, 25);
    const bob = await f.login("bob");
    assert.equal(
      (
        await f.request(
          "GET",
          "/api/v1/jobs?" + query(f.filters),
          undefined,
          bob,
        )
      ).json().items.length,
      0,
    );
    const assign = await f.request(
      "POST",
      "/api/v1/jobs/assign",
      f.filters,
      f.cookie,
    );
    assert.equal(assign.statusCode, 200);
    assert.equal(assign.json().assignedCount, 24);
    assert.equal(
      (await get({ ...f.filters, status: "assigned" })).items.length,
      20,
    );
    assert.equal(
      (
        await f.request("POST", "/api/v1/jobs/assign", f.filters, f.cookie)
      ).json().assignedCount,
      0,
    );
    const detail = (
      await f.request("GET", `/api/v1/jobs/${f.ids[0]}`, undefined, f.cookie)
    ).json();
    assert.equal(detail.processingState, "saved");
    assert.ok(detail.assignedAt);
    assert.equal(detail.matchingScores.total, 80.125);
    const zero = await get({ totalMatchMin: 0, totalMatchMax: 0 });
    assert.equal(zero.items.length, 1);
    assert.equal(zero.items[0].id, f.ids[30]);
    assert.equal(
      (await get({ postedFrom: "2026-11-08", limit: 100 })).items.length,
      29,
    );
    assert.equal(
      (await get({ totalMatchMax: 100, limit: 100 })).items.length,
      30,
    );
    assert.equal(
      (await get({ registeredFrom: "2026-11-09T00:00:00Z" })).items.length,
      1,
    );
    assert.equal(
      (
        await get({
          registeredFrom: "2026-11-08T07:00:00-05:00",
          registeredTo: "2026-11-08T07:00:00-05:00",
          limit: 100,
        })
      ).items.length,
      30,
    );
    assert.equal(
      (await get({ collectedFrom: "2026-12-01T00:00:00Z", limit: 100 })).items
        .length,
      31,
    );
  } finally {
    await f.close();
  }
});

test("invalid advanced ranges fail consistently before any bulk mutation", async () => {
  const f = await setup();
  try {
    for (const filters of [
      { postedFrom: "2026-02-30" },
      { postedFrom: "2026-11-09", postedTo: "2026-11-08" },
      { registeredFrom: "bad" },
      {
        registeredFrom: "2026-11-09T00:00:00Z",
        registeredTo: "2026-11-08T00:00:00Z",
      },
      { totalMatchMin: 101 },
      { skillMatchMin: -1 },
      { industryMatchMin: 90, industryMatchMax: 80 },
      { totalMatchMin: "not-a-number" },
    ]) {
      for (const path of ["/jobs", "/jobs/export", "/jobs/clipboard"])
        assert.equal(
          (
            await f.request(
              "GET",
              "/api/v1" + path + "?" + query(filters),
              undefined,
              f.cookie,
            )
          ).statusCode,
          400,
          JSON.stringify(filters),
        );
      assert.equal(
        (await f.request("POST", "/api/v1/jobs/assign", filters, f.cookie))
          .statusCode,
        400,
      );
    }
    assert.equal(
      (
        await f.request(
          "GET",
          "/api/v1/jobs?status=assigned",
          undefined,
          f.cookie,
        )
      ).json().items.length,
      0,
    );
  } finally {
    await f.close();
  }
});
