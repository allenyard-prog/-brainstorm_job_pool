import test from "node:test";
import assert from "node:assert/strict";
import { ServiceStore } from "../src/storage/service-store.js";
import { migrate } from "../src/storage/migrations.js";
import { removeProfileSchema } from './helpers/profile-schema.js';
import { serviceFixture } from "./helpers/service-fixture.js";
import { accountKey } from "../src/core/security.js";

async function sync(f, user) {
  const request = await f.app.db.call("enqueueCompanySync", user.id);
  await f.app.db.call("claimCompanySync");
  let state;
  do {
    state = await f.app.db.call("processCompanySyncBatch", request.id);
  } while (state.status === "running");
  return state;
}
function save(f, user, profile, id, company) {
  const store = new ServiceStore(f.config.dbPath, {
    userId: user.id,
    connectionId: profile.id,
  });
  try {
    return store.saveJob("jobright", accountKey(profile.label), {
      id,
      title: `Engineer ${id}`,
      company: company?.companyName ?? null,
      url: `https://fixture.test/jobs/${id}`,
      details: {
        description: { text: "Complete retained job details" },
        company: company ?? {},
        applicationUrl: `https://employer.test/jobs/${id}`,
        postedAt: "2026-11-01 12:00:00",
        matching: { score: 80 },
      },
    });
  } finally {
    store.close();
  }
}
async function setup() {
  const f = await serviceFixture(),
    cookie = await f.login("alice");
  const one = await f.connect(cookie, "hold", "one@provider.test"),
    two = await f.connect(cookie, "hold", "two@provider.test");
  const blocked = { companyName: "Blocked Labs", companyId: "blocked" },
    allowed = { companyName: "Allowed Labs", companyId: "allowed" };
  const blockedIds = [
    save(f, f.users.alice, one, "blocked-1", blocked),
    save(f, f.users.alice, two, "blocked-2", blocked),
    save(f, f.users.alice, one, "blocked-3", blocked),
  ];
  for (let i = 0; i < 24; i++)
    save(f, f.users.alice, one, `allowed-${i}`, allowed);
  await sync(f, f.users.alice);
  const companies = (await f.app.db.call("listCompanies", f.users.alice.id))
    .items;
  const company = companies.find((item) => item.name === "Blocked Labs");
  const unlinked = save(f, f.users.alice, one, "blocked-unsynced", blocked),
    unknown = save(f, f.users.alice, one, "unknown", null);
  return { ...f, cookie, one, two, company, blockedIds, unlinked, unknown };
}

test("blacklist mutations are owner-scoped, strictly validated, idempotent and persistent", async () => {
  const f = await setup();
  try {
    const path = `/api/v1/companies/${f.company.id}`;
    assert.equal(f.company.isBlacklisted, false);
    const bob = await f.login("bob"),
      admin = await f.login("admin");
    for (const cookie of [bob, admin])
      assert.equal(
        (await f.request("PATCH", path, { isBlacklisted: true }, cookie))
          .statusCode,
        404,
      );
    assert.equal(
      (await f.request("PATCH", path, { isBlacklisted: true })).statusCode,
      401,
    );
    assert.equal(
      (
        await f.request(
          "PATCH",
          path,
          { isBlacklisted: true },
          f.cookie,
          "https://untrusted.test",
        )
      ).statusCode,
      403,
    );
    for (const body of [
      {},
      { isBlacklisted: "true" },
      { isBlacklisted: "false" },
      { isBlacklisted: 1 },
      { isBlacklisted: null },
      { isBlacklisted: true, name: "Changed" },
      [],
    ])
      assert.equal(
        (await f.request("PATCH", path, body, f.cookie)).statusCode,
        400,
        JSON.stringify(body),
      );
    const before = (await f.request("GET", path, undefined, f.cookie)).json();
    for (let i = 0; i < 2; i++) {
      const response = await f.request(
        "PATCH",
        path,
        { isBlacklisted: true },
        f.cookie,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().isBlacklisted, true);
      assert.equal(response.json().jobCount, 3);
      assert.equal(response.json().details, undefined);
    }
    const after = (await f.request("GET", path, undefined, f.cookie)).json();
    assert.deepEqual({ ...after, isBlacklisted: false }, before);
    const reopened = new ServiceStore(f.config.dbPath);
    try {
      assert.equal(
        reopened.companyDetail(f.users.alice.id, f.company.id).isBlacklisted,
        true,
      );
    } finally {
      reopened.close();
    }
    assert.equal(
      (await f.request("GET", "/api/v1/companies", undefined, f.cookie))
        .json()
        .items.find((company) => company.id === f.company.id).isBlacklisted,
      true,
    );
    await sync(f, f.users.alice);
    assert.equal(
      (await f.request("GET", path, undefined, f.cookie)).json().isBlacklisted,
      true,
    );
    assert.equal(
      (
        await f.request("PATCH", path, { isBlacklisted: false }, f.cookie)
      ).json().isBlacklisted,
      false,
    );
    await sync(f, f.users.alice);
    assert.equal(
      (await f.request("GET", path, undefined, f.cookie)).json().isBlacklisted,
      false,
    );
  } finally {
    await f.close();
  }
});

test("blacklist exclusion constrains shared job operations across profiles and keeps unlinked jobs", async () => {
  const f = await setup();
  try {
    await f.request(
      "PATCH",
      `/api/v1/companies/${f.company.id}`,
      { isBlacklisted: true },
      f.cookie,
    );
    const filters = {
      excludeBlacklistedCompanies: true,
      q: "Engineer",
      postedFrom: "2026-11-01",
      totalMatchMin: 80,
    };
    const get = async (extra) =>
      (
        await f.request(
          "GET",
          "/api/v1/jobs?" + new URLSearchParams({ ...filters, ...extra }),
          undefined,
          f.cookie,
        )
      ).json();
    const first = await get({ limit: 20 }),
      second = await get({ cursor: first.nextCursor });
    assert.equal(first.items.length, 20);
    assert.equal(second.items.length, 6);
    const ids = [...first.items, ...second.items].map((job) => job.id);
    assert.ok(ids.includes(f.unlinked));
    assert.ok(ids.includes(f.unknown));
    assert.ok(f.blockedIds.every((id) => !ids.includes(id)));
    assert.equal((await get({ connectionId: f.two.id })).items.length, 0);
    assert.equal(
      (await get({ excludeBlacklistedCompanies: false, limit: 100 })).items
        .length,
      29,
    );
    assert.equal(
      (
        await f.request(
          "GET",
          `/api/v1/jobs?companyId=${f.company.id}`,
          undefined,
          f.cookie,
        )
      ).json().items.length,
      3,
    );
    for (const [resource, separator] of [
      ["export", "\r\n"],
      ["clipboard", "\n"],
    ]) {
      const response = await f.request(
        "GET",
        `/api/v1/jobs/${resource}?` + new URLSearchParams(filters),
        undefined,
        f.cookie,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.trim().split(separator).length, 27);
      assert.ok(!response.body.includes("Engineer blocked-1"));
      assert.ok(response.body.includes("Engineer blocked-unsynced"));
    }
    const bob = await f.login("bob"),
      bobProfile = await f.connect(bob, "hold", "bob@provider.test");
    save(f, f.users.bob, bobProfile, "bob-blocked", {
      companyName: "Blocked Labs",
      companyId: "blocked",
    });
    await sync(f, f.users.bob);
    assert.equal(
      (
        await f.request(
          "GET",
          "/api/v1/jobs?excludeBlacklistedCompanies=true",
          undefined,
          bob,
        )
      ).json().items.length,
      1,
    );
    const assigned = await f.request(
      "POST",
      "/api/v1/jobs/assign",
      filters,
      f.cookie,
    );
    assert.equal(assigned.statusCode, 200);
    assert.equal(assigned.json().assignedCount, 26);
    assert.equal(
      (await f.request("POST", "/api/v1/jobs/assign", filters, f.cookie)).json()
        .assignedCount,
      0,
    );
    for (const id of f.blockedIds) {
      const job = (
        await f.request("GET", `/api/v1/jobs/${id}`, undefined, f.cookie)
      ).json();
      assert.equal(job.assignedAt, null);
      assert.equal(job.processingState, "saved");
    }
    await sync(f, f.users.alice);
    assert.equal((await get({ limit: 100 })).items.length, 25);
    await f.request(
      "PATCH",
      `/api/v1/companies/${f.company.id}`,
      { isBlacklisted: false },
      f.cookie,
    );
    assert.equal((await get({ limit: 100 })).items.length, 29);
    for (const resource of ["", "/export", "/clipboard"])
      assert.equal(
        (
          await f.request(
            "GET",
            "/api/v1/jobs" + resource + "?excludeBlacklistedCompanies=invalid",
            undefined,
            f.cookie,
          )
        ).statusCode,
        400,
      );
    assert.equal(
      (
        await f.request(
          "POST",
          "/api/v1/jobs/assign",
          { excludeBlacklistedCompanies: "invalid" },
          f.cookie,
        )
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test("automatic company merges preserve blacklisting from either record and allow explicit restoration", () => {
  for (const flagged of [0, 1]) {
    const store = new ServiceStore(":memory:");
    try {
      const user = store.createUser({
        email: "merge@fixture.test",
        passwordHash: "fixture",
      });
      store.createConnection({
        userId: user.id,
        site: "jobright",
        accountKey: "merge",
        label: "Fixture",
        encryptedCredentials: "{}",
        cliDefault: true,
      });
      const save = (id, company) =>
        store.saveJob("jobright", "merge", {
          id,
          title: id,
          url: "https://fixture.test/job",
          company: company.companyName,
          details: { description: { text: "Retained content" }, company },
        });
      const sync = () => {
        const request = store.enqueueCompanySync(user.id);
        store.claimCompanySync();
        return store.processCompanySyncBatch(request.id);
      };
      save("source", { companyName: "Acme", companyId: "acme" });
      save("domain", {
        companyName: "Acme Research",
        companyURL: "https://acme.test",
      });
      sync();
      const companies = store
        .listCompanies(user.id)
        .items.sort((a, b) => a.id - b.id);
      assert.equal(companies.length, 2);
      store.setCompanyBlacklist(user.id, companies[flagged].id, true);
      save("bridge", {
        companyName: "Acme",
        companyId: "acme",
        companyURL: "https://acme.test",
      });
      sync();
      const merged = store.listCompanies(user.id).items;
      assert.equal(merged.length, 1);
      assert.equal(merged[0].isBlacklisted, true);
      assert.equal(merged[0].jobCount, 3);
      assert.equal(
        store.listJobs(user.id, { excludeBlacklistedCompanies: true }).items
          .length,
        0,
      );
      store.setCompanyBlacklist(user.id, merged[0].id, false);
      sync();
      assert.equal(store.listCompanies(user.id).items[0].isBlacklisted, false);
      assert.equal(
        store.listJobs(user.id, { excludeBlacklistedCompanies: true }).items
          .length,
        3,
      );
    } finally {
      store.close();
    }
  }
});

test("version-five migration defaults flags without changing jobs, company metadata or pending tracking", () => {
  const store = new ServiceStore(":memory:");
  try {
    const user = store.createUser({
      email: "migration@fixture.test",
      passwordHash: "fixture",
    });
    store.createConnection({
      userId: user.id,
      site: "jobright",
      accountKey: "migration",
      label: "Fixture",
      encryptedCredentials: "{}",
      cliDefault: true,
    });
    const id = store.saveJob("jobright", "migration", {
      id: "preserved",
      title: "Engineer",
      company: "Acme",
      url: "https://fixture.test/job",
      details: {
        description: { text: "Long content. ".repeat(20000) },
        company: { companyName: "Acme" },
      },
      raw: { retained: true },
    });
    store.transition(id, "migration", "mark_pending");
    store.assignJobs(user.id);
    const sync = store.enqueueCompanySync(user.id);
    store.claimCompanySync();
    store.processCompanySyncBatch(sync.id);
    const job = store.jobDetail(user.id, id, true),
      company = store.companyDetail(user.id, job.companyId);
    store.db.exec(
      removeProfileSchema + "ALTER TABLE companies DROP COLUMN is_blacklisted; PRAGMA user_version=5",
    );
    migrate(store.db, ":memory:");
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 8);
    assert.deepEqual(store.jobDetail(user.id, id, true), job);
    assert.deepEqual(store.companyDetail(user.id, job.companyId), company);
    assert.throws(() =>
      store.db.prepare("UPDATE companies SET is_blacklisted=2").run(),
    );
    store.setCompanyBlacklist(user.id, job.companyId, true);
    migrate(store.db, ":memory:");
    assert.equal(
      store.companyDetail(user.id, job.companyId).isBlacklisted,
      true,
    );
    assert.equal(
      store.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    store.close();
  }
});
