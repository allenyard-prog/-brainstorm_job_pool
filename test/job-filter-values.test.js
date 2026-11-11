import test from "node:test";
import assert from "node:assert/strict";
import {
  jobFilterValues,
  calendarDate,
} from "../src/storage/job-filter-values.js";
import { ServiceStore } from "../src/storage/service-store.js";
import { migrate } from "../src/storage/migrations.js";
import {
  removeFilterSchema,
  revertedChatSchema,
} from "./helpers/filter-schema.js";

const details = {
  description: { text: "Long preserved content. ".repeat(12000) },
  postedAt: "2026-11-06 23:47:46",
  matching: {
    score: 84.4677,
    recommendations: [
      { featureName: "q_job_skill_match", score: 0.8666666666666667 },
      { featureName: "q_industry_match", score: 0 },
    ],
    skills: [{ score: 1 }],
    industries: [{ score: 1 }],
  },
  company: { companyName: "Acme" },
};
test("derived dates and aggregate scores preserve precision and never guess unrelated or missing values", () => {
  assert.deepEqual(jobFilterValues(details), {
    postedDate: "2026-11-06",
    totalMatch: 84.4677,
    skillMatch: 86.66666666666667,
    industryMatch: 0,
  });
  assert.deepEqual(
    jobFilterValues({
      postedAt: "1 day ago",
      matching: {
        charts: [
          { value: "100", text: "2022 (10)" },
          { value: "80", text: "80% Skill Match" },
          { value: "70", text: "Industry Experience" },
          { value: "84", text: "Overall Match" },
        ],
      },
    }),
    { postedDate: null, totalMatch: 84, skillMatch: 80, industryMatch: 70 },
  );
  assert.deepEqual(
    jobFilterValues({
      matching: {
        skills: [{ score: 1 }],
        industries: [{ score: 1 }],
        charts: [{ value: "50", text: "2025 (5)" }],
      },
    }),
    {
      postedDate: null,
      totalMatch: null,
      skillMatch: null,
      industryMatch: null,
    },
  );
  for (const invalid of [
    "2026-02-30",
    "2026-13-01",
    "2026-11-01 25:00:00",
    "yesterday",
    "1 day ago",
    null,
    1700000000,
  ])
    assert.equal(calendarDate(invalid), null);
  assert.equal(calendarDate("2024-02-29"), "2024-02-29");
  assert.equal(calendarDate("2026-11-01T23:30:00-07:00"), "2026-11-01");
  for (const invalid of [101, -1, "", NaN, "1e2", "84%"])
    assert.equal(
      jobFilterValues({ matching: { score: invalid } }).totalMatch,
      null,
    );
  assert.equal(jobFilterValues({ matching: { score: 0 } }).totalMatch, 0);
  assert.equal(
    jobFilterValues({
      matching: {
        recommendations: [{ featureName: "q_job_skill_match", score: 0.58 }],
      },
    }).skillMatch,
    58,
  );
  assert.equal(
    jobFilterValues({
      matching: {
        recommendations: [{ featureName: "q_job_skill_match", score: 1.01 }],
      },
    }).skillMatch,
    null,
  );
  assert.equal(
    jobFilterValues({
      matching: {
        recommendations: [
          { featureName: "q_job_skill_match", score: 0.8 },
          { featureName: "q_job_skill_match", score: 0.9 },
        ],
      },
    }).skillMatch,
    null,
  );
});

for (const version of [3, 4])
  test(`version ${version} backfill preserves source JSON, company links, assignment and pending tracking`, () => {
    const store = new ServiceStore(":memory:");
    try {
      const user = store.createUser({
        email: "filters@fixture.test",
        passwordHash: "fixture",
      });
      const profile = store.createConnection({
        userId: user.id,
        site: "jobright",
        accountKey: "filters",
        label: "Fixture",
        encryptedCredentials: "{}",
        cliDefault: true,
      });
      const job = {
        id: "backfill",
        title: "Engineer",
        company: "Acme",
        url: "https://fixture.test/job",
        details,
        raw: { preserved: "raw" },
      };
      const id = store.saveJob("jobright", "filters", job);
      store.transition(id, "filters", "mark_pending");
      store.assignJobs(user.id);
      const sync = store.enqueueCompanySync(user.id);
      store.claimCompanySync();
      store.processCompanySyncBatch(sync.id);
      const before = store.jobDetail(user.id, id, true);
      assert.ok(before.companyId);
      store.db.exec(removeFilterSchema);
      if (version === 4) {
        store.db.exec(revertedChatSchema);
        store.db
          .prepare("INSERT INTO chat_conversations VALUES(?,?,?,?,?)")
          .run(
            "historical",
            user.id,
            "Retained history",
            "2026-11-01",
            "2026-11-01",
          );
      }
      store.db.exec(`PRAGMA user_version=${version}`);
      migrate(store.db, ":memory:");
      assert.equal(
        store.db.prepare("PRAGMA user_version").get().user_version,
        8,
      );
      assert.deepEqual(store.jobDetail(user.id, id, true), before);
      assert.equal(store.getConnection(user.id, profile.id).id, profile.id);
      if (version === 4)
        assert.equal(
          store.db.prepare("SELECT title FROM chat_conversations").get().title,
          "Retained history",
        );
      store.saveJob("jobright", "filters", {
        ...job,
        details: { ...details, postedAt: "relative", matching: { score: 0 } },
      });
      const refreshed = store.jobDetail(user.id, id, true);
      assert.equal(refreshed.firstSeenAt, before.firstSeenAt);
      assert.equal(refreshed.assignedAt, before.assignedAt);
      assert.equal(refreshed.processingState, "mark_pending");
      assert.deepEqual(refreshed.matchingScores, {
        total: 0,
        skill: null,
        industry: null,
      });
      assert.equal(refreshed.postedDate, null);
      assert.equal(
        store.db.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      store.close();
    }
  });

test("unrecognized version-four and future schemas fail without partially migrating", () => {
  const store = new ServiceStore(":memory:");
  try {
    store.db.exec(removeFilterSchema + "PRAGMA user_version=4");
    assert.throws(() => migrate(store.db, ":memory:"), /Unrecognized/);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 4);
    assert.equal(
      store.db
        .prepare("PRAGMA table_info(jobs)")
        .all()
        .some((column) => column.name === "posted_date"),
      false,
    );
    store.db.exec("PRAGMA user_version=9");
    assert.throws(() => migrate(store.db, ":memory:"), /newer/);
  } finally {
    store.close();
  }
});
