import test from "node:test";
import assert from "node:assert/strict";
import { ServiceStore } from "../src/storage/service-store.js";
import { serviceFixture } from "./helpers/service-fixture.js";
import { accountKey } from "../src/core/security.js";
import { buildService } from "../src/service/app.js";

function localStore() {
  const store = new ServiceStore(":memory:");
  const user = store.createUser({
    email: "owner@fixture.test",
    passwordHash: "fixture",
  });
  let sequence = 0;
  function profile(owner = user) {
    const account = `account-${++sequence}`;
    const connection = store.createConnection({
      userId: owner.id,
      site: "jobright",
      accountKey: account,
      label: account,
      encryptedCredentials: "{}",
      cliDefault: true,
    });
    return { ...connection, account };
  }
  const one = profile(),
    two = profile();
  function save(connection, id, company, extra = {}) {
    return store.saveJob("jobright", connection.account, {
      id,
      title: `Role ${id}`,
      url: `https://example.test/job/${id}`,
      company: company?.companyName ?? company?.name ?? null,
      details: {
        description: { text: "Full job content." },
        company,
        ...extra,
      },
    });
  }
  function sync(owner = user) {
    const request = store.enqueueCompanySync(owner.id);
    assert.equal(store.claimCompanySync().id, request.id);
    let result;
    do {
      result = store.processCompanySyncBatch(request.id);
    } while (result.status === "running");
    return result;
  }
  return { store, user, one, two, profile, save, sync };
}

test("company sync groups titles/profiles, preserves metadata and processing, and is idempotent", () => {
  const f = localStore();
  try {
    const first = f.save(f.one, "engineer", {
      name: "  ACME   Labs ",
      text: "Browser company text.",
      links: [{ text: "News", url: "https://news.test/acme" }],
    });
    const second = f.save(f.two, "designer", {
      companyName: "Acme Labs",
      companyId: "acme",
      companyURL: "https://www.acme.test/about",
      companyDesc: "Rich API description. ".repeat(2000),
      companyLocation: "New York",
      companyIndustry: "Software",
      companySize: "100",
      companyFoundYear: 2010,
      fundraisingCurrentStage: "Series B",
      futureField: { retained: true },
      sessionToken: "secret",
    });
    f.store.transition(first, f.one.account, "mark_pending");
    f.store.transition(second, f.two.account, "mark_confirmed", "applied");
    f.store.assignJobs(f.user.id, { connectionId: f.two.id });
    const before = f.store.jobDetail(f.user.id, first);
    const result = f.sync();
    assert.equal(result.total, 2);
    assert.equal(result.processed, 2);
    assert.equal(result.created, 1);
    assert.equal(result.linked, 2);
    const list = f.store.listCompanies(f.user.id);
    assert.equal(list.items.length, 1);
    const company = f.store.companyDetail(f.user.id, list.items[0].id);
    assert.equal(company.domain, "acme.test");
    assert.equal(company.jobCount, 2);
    assert.equal(company.assignedCount, 1);
    assert.equal(company.markedAppliedCount, 1);
    assert.equal(
      company.details.description,
      "Rich API description. ".repeat(2000),
    );
    assert.equal(company.details.links[0].text, "News");
    assert.equal(company.details.sourceMetadata.futureField.retained, true);
    assert.equal(
      f.store.jobDetail(f.user.id, first).processingState,
      "mark_pending",
    );
    assert.deepEqual(
      f.store.jobDetail(f.user.id, first).details,
      before.details,
    );
    assert.equal(
      f.store.listJobs(f.user.id, { companyId: company.id }).items.length,
      2,
    );
    assert.equal(
      f.store.listCompanies(f.user.id, { connectionId: f.one.id }).items[0]
        .jobCount,
      1,
    );
    const again = f.sync();
    assert.equal(again.created, 0);
    assert.equal(again.updated, 1);
    assert.equal(f.store.listCompanies(f.user.id).items[0].id, company.id);
    f.store.assignJobs(f.user.id, { connectionId: f.one.id });
    assert.equal(f.store.companyDetail(f.user.id, company.id).assignedCount, 2);
    assert.equal(
      f.store.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    f.store.close();
  }
});

test("newer nonempty company fields win independent of job order and empty fields", () => {
  const f = localStore();
  try {
    const newer = f.save(f.one, "newer", {
      name: "Acme",
      description: "Latest",
      size: 0,
      industry: "Current industry",
      funding: { stage: "Series B" },
    });
    const older = f.save(f.one, "older", {
      name: "Acme",
      description: "Old",
      location: "London",
      industry: { label: "Older industry shape" },
      funding: "Old funding shape",
    });
    const blank = f.save(f.one, "empty", {
      name: "Acme",
      description: "   ",
      location: null,
    });
    for (const [id, time] of [
      [newer, "2026-11-03"],
      [older, "2026-11-01"],
      [blank, "2026-11-05"],
    ])
      f.store.db
        .prepare("UPDATE jobs SET last_scraped_at=? WHERE id=?")
        .run(time, id);
    f.sync();
    const company = f.store.companyDetail(
      f.user.id,
      f.store.listCompanies(f.user.id).items[0].id,
    );
    assert.equal(company.details.description, "Latest");
    assert.equal(company.details.location, "London");
    assert.equal(company.details.size, 0);
    assert.equal(company.details.industry, "Current industry");
    assert.deepEqual(company.details.funding, { stage: "Series B" });
    assert.equal(company.domain, null); // arbitrary news links are never company identity
  } finally {
    f.store.close();
  }
});

test("strong evidence merges compatible provisional companies without dropping job links", () => {
  const f = localStore();
  try {
    f.save(f.one, "source", { companyName: "Acme", companyId: "acme" });
    f.save(f.two, "domain", {
      name: "Acme Research",
      website: "https://acme.test",
    });
    f.sync();
    assert.equal(f.store.listCompanies(f.user.id).items.length, 2);
    const bridge = f.save(f.one, "bridge", {
      companyName: "Acme",
      companyId: "acme",
      companyURL: "https://acme.test",
    });
    f.sync();
    const companies = f.store.listCompanies(f.user.id).items;
    assert.equal(companies.length, 1);
    assert.equal(companies[0].jobCount, 3);
    assert.equal(
      f.store.jobDetail(f.user.id, bridge).companyId,
      companies[0].id,
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) AS n FROM company_identifiers WHERE kind='name'",
        )
        .get().n,
      2,
    );
  } finally {
    f.store.close();
  }
});

test("conflicting identities remain separate, ambiguous names and missing metadata are skipped", () => {
  const f = localStore();
  try {
    f.save(f.one, "a", {
      companyName: "Acme",
      companyId: "a",
      companyURL: "https://first.test",
    });
    f.save(f.one, "b", {
      companyName: "Acme",
      companyId: "b",
      companyURL: "https://second.test",
    });
    const ambiguous = f.save(f.one, "ambiguous", { name: "Acme" });
    const missing = f.save(f.one, "missing", null);
    const result = f.sync();
    assert.equal(f.store.listCompanies(f.user.id).items.length, 2);
    assert.equal(result.skipped, 2);
    assert.ok(result.warnings >= 1);
    assert.equal(f.store.jobDetail(f.user.id, ambiguous).companyId, null);
    assert.equal(f.store.jobDetail(f.user.id, missing).companyId, null);
    f.sync();
    assert.equal(f.store.listCompanies(f.user.id).items.length, 2);
  } finally {
    f.store.close();
  }
});

test("company batches honor snapshot cutoff, exclusivity and durable partial recovery", () => {
  const f = localStore();
  try {
    for (let i = 0; i < 205; i++) f.save(f.one, String(i), { name: "Acme" });
    const request = f.store.enqueueCompanySync(f.user.id);
    assert.throws(
      () => f.store.enqueueCompanySync(f.user.id),
      (error) =>
        error.code === "COMPANY_SYNC_EXISTS" &&
        error.details.syncId === request.id,
    );
    const bob = f.store.createUser({
      email: "bob@fixture.test",
      passwordHash: "fixture",
    });
    const queued = f.store.enqueueCompanySync(bob.id);
    assert.equal(f.store.claimCompanySync().id, request.id);
    assert.equal(f.store.claimCompanySync(), null);
    let result = f.store.processCompanySyncBatch(request.id);
    assert.equal(result.processed, 100);
    assert.equal(result.total, 205);
    const later = f.save(f.one, "later", { name: "After cutoff" });
    result = f.store.processCompanySyncBatch(request.id);
    assert.equal(result.processed, 200);
    result = f.store.processCompanySyncBatch(request.id);
    assert.equal(result.status, "completed");
    assert.equal(result.processed, 205);
    assert.equal(f.store.jobDetail(f.user.id, later).companyId, null);
    assert.equal(f.store.claimCompanySync().id, queued.id);
    f.store.recoverCompanySyncs();
    assert.equal(
      f.store.getCompanySync(bob.id, queued.id).status,
      "interrupted",
    );
    assert.equal(f.store.listCompanies(f.user.id).items[0].jobCount, 205);
    const recovery = f.sync();
    assert.equal(recovery.total, 206);
    assert.equal(f.store.listCompanies(f.user.id).items.length, 2);
  } finally {
    f.store.close();
  }
});

test("shared domains with conflicting source IDs never guess for a domain-only job", () => {
  const f = localStore();
  try {
    f.save(f.one, "a", {
      name: "Shared brand",
      companyId: "a",
      website: "https://shared.test",
    });
    f.save(f.one, "b", {
      name: "Shared brand",
      companyId: "b",
      website: "https://shared.test",
    });
    const ambiguous = f.save(f.one, "unknown", {
      name: "Shared brand",
      website: "https://shared.test",
    });
    const result = f.sync();
    assert.equal(f.store.listCompanies(f.user.id).items.length, 2);
    assert.equal(f.store.jobDetail(f.user.id, ambiguous).companyId, null);
    assert.ok(result.warnings >= 1);
    f.sync();
    assert.equal(f.store.listCompanies(f.user.id).items.length, 2);
  } finally {
    f.store.close();
  }
});

async function seed(f, user, profile, company, title = "Engineer") {
  const account = accountKey(profile.label);
  const store = new ServiceStore(f.config.dbPath, {
    userId: user.id,
    connectionId: profile.id,
  });
  try {
    return store.saveJob("jobright", account, {
      id: title,
      title,
      url: "https://fixture.test/job",
      company: company.companyName ?? company.name,
      details: { description: { text: "Full job content" }, company },
    });
  } finally {
    store.close();
  }
}
async function waitSync(f, cookie, id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = (
      await f.request("GET", `/api/v1/company-syncs/${id}`, undefined, cookie)
    ).json();
    if (!["queued", "running"].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Company sync did not finish.");
}

test("company resources are owner-scoped, paginated, filtered, sanitized, and manual-only", async () => {
  const f = await serviceFixture();
  try {
    const alice = await f.login("alice"),
      bob = await f.login("bob"),
      admin = await f.login("admin");
    const profile = await f.connect(alice);
    const first = await seed(f, f.users.alice, profile, {
      name: "Acme",
      sessionToken: "must-not-leak",
      text: "Description",
    });
    await seed(f, f.users.alice, profile, { name: "Another" }, "Designer");
    assert.equal((await f.request("GET", "/api/v1/companies")).statusCode, 401);
    assert.equal(
      (
        await f.request("GET", "/api/v1/company-syncs/latest", undefined, alice)
      ).json(),
      null,
    );
    assert.equal(
      (await f.request("GET", "/api/v1/companies", undefined, alice)).json()
        .items.length,
      0,
    );
    const start = await f.request(
      "POST",
      "/api/v1/company-syncs",
      undefined,
      alice,
    );
    assert.equal(start.statusCode, 202);
    assert.equal(start.json().status, "queued");
    assert.equal(
      (await f.request("POST", "/api/v1/company-syncs", undefined, alice))
        .statusCode,
      409,
    );
    await f.app.companySyncs.start();
    assert.equal(
      (await waitSync(f, alice, start.json().id)).status,
      "completed",
    );
    const page = (
      await f.request("GET", "/api/v1/companies?limit=1", undefined, alice)
    ).json();
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = (
      await f.request(
        "GET",
        `/api/v1/companies?limit=1&cursor=${page.nextCursor}`,
        undefined,
        alice,
      )
    ).json();
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].id, page.items[0].id);
    const company = (
      await f.request("GET", "/api/v1/companies?q=Acme", undefined, alice)
    ).json().items[0];
    const detail = await f.request(
      "GET",
      `/api/v1/companies/${company.id}`,
      undefined,
      alice,
    );
    assert.ok(!detail.body.includes("must-not-leak"));
    assert.equal(detail.json().details.description, "Description");
    const jobs = (
      await f.request(
        "GET",
        `/api/v1/jobs?companyId=${company.id}`,
        undefined,
        alice,
      )
    ).json();
    assert.equal(jobs.items[0].id, first);
    assert.equal(jobs.items[0].companyName, "Acme");
    for (const cookie of [bob, admin]) {
      assert.equal(
        (await f.request("GET", "/api/v1/companies", undefined, cookie)).json()
          .items.length,
        0,
      );
      assert.equal(
        (
          await f.request(
            "GET",
            `/api/v1/companies/${company.id}`,
            undefined,
            cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await f.request(
            "GET",
            `/api/v1/company-syncs/${start.json().id}`,
            undefined,
            cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await f.request(
            "GET",
            `/api/v1/jobs?companyId=${company.id}`,
            undefined,
            cookie,
          )
        ).json().items.length,
        0,
      );
    }
    assert.equal(
      (await f.request("GET", "/api/v1/companies?limit=101", undefined, alice))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await f.request(
          "POST",
          "/api/v1/company-syncs",
          undefined,
          alice,
          "https://evil.test",
        )
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("manual sync responds before processing, yields for APIs, and restores queued work", async () => {
  const f = await serviceFixture();
  let release;
  try {
    const cookie = await f.login("alice"),
      profile = await f.connect(cookie);
    await seed(f, f.users.alice, profile, { name: "Acme" });
    const original = f.app.db.call.bind(f.app.db);
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.app.db.call = async (method, ...args) => {
      if (method === "processCompanySyncBatch") await gate;
      return original(method, ...args);
    };
    const request = (
      await f.request("POST", "/api/v1/company-syncs", undefined, cookie)
    ).json();
    await f.app.companySyncs.start();
    assert.equal((await f.request("GET", "/health")).statusCode, 200);
    assert.equal(
      (await f.request("GET", "/api/v1/jobs", undefined, cookie)).json().items
        .length,
      1,
    );
    assert.ok(
      ["queued", "running"].includes(
        (
          await f.request(
            "GET",
            `/api/v1/company-syncs/${request.id}`,
            undefined,
            cookie,
          )
        ).json().status,
      ),
    );
    release();
    assert.equal((await waitSync(f, cookie, request.id)).status, "completed");
    assert.equal(f.app.supervisor.children.size, 0);
  } finally {
    release?.();
    await f.close();
  }
});

test("service restart preserves queued requests and interrupts partially committed synchronization", async () => {
  const f = await serviceFixture();
  let restarted;
  try {
    const alice = await f.login("alice"),
      bob = await f.login("bob"),
      profile = await f.connect(alice);
    await seed(f, f.users.alice, profile, { name: "Acme" });
    await seed(f, f.users.alice, profile, { name: "Another" }, "Designer");
    const running = await f.app.db.call("enqueueCompanySync", f.users.alice.id);
    await f.app.db.call("claimCompanySync");
    await f.app.db.call("processCompanySyncBatch", running.id, 1);
    const queued = await f.app.db.call("enqueueCompanySync", f.users.bob.id);
    await f.app.close();
    restarted = await buildService(f.config, { supervise: false });
    await restarted.companySyncs.start();
    const original = await restarted.db.call(
      "getCompanySync",
      f.users.alice.id,
      running.id,
    );
    assert.equal(original.status, "interrupted");
    assert.equal(original.processed, 1);
    assert.equal(
      (await restarted.db.call("listCompanies", f.users.alice.id)).items.length,
      1,
    );
    const deadline = Date.now() + 5000;
    while (
      (await restarted.db.call("getCompanySync", f.users.bob.id, queued.id))
        .status !== "completed" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      (await restarted.db.call("getCompanySync", f.users.bob.id, queued.id))
        .status,
      "completed",
    );
    const retry = (
      await restarted.inject({
        method: "POST",
        url: "/api/v1/company-syncs",
        headers: { cookie: alice, origin: f.config.origin },
      })
    ).json();
    while (
      (await restarted.db.call("getCompanySync", f.users.alice.id, retry.id))
        .status !== "completed" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      (await restarted.db.call("listCompanies", f.users.alice.id)).items.length,
      2,
    );
    assert.equal(
      (
        await restarted.inject({
          method: "GET",
          url: `/api/v1/company-syncs/${running.id}`,
          headers: { cookie: bob },
        })
      ).statusCode,
      404,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test("failed batches roll back links and metadata and report a sanitized failure", async () => {
  const f = await serviceFixture();
  try {
    const cookie = await f.login("alice"),
      profile = await f.connect(cookie);
    await seed(f, f.users.alice, profile, { name: "Acme" });
    const store = new ServiceStore(f.config.dbPath);
    store.db.exec(
      "CREATE TRIGGER simulate_link_failure BEFORE UPDATE OF company_id ON jobs BEGIN SELECT RAISE(ABORT,'private-source-value'); END",
    );
    store.close();
    const sync = (
      await f.request("POST", "/api/v1/company-syncs", undefined, cookie)
    ).json();
    await f.app.companySyncs.start();
    const result = await waitSync(f, cookie, sync.id);
    assert.equal(result.status, "failed");
    assert.equal(result.processed, 0);
    assert.ok(!JSON.stringify(result).includes("private-source-value"));
    assert.equal(
      (await f.app.db.call("listCompanies", f.users.alice.id)).items.length,
      0,
    );
    assert.equal((await f.request("GET", "/health")).statusCode, 200);
  } finally {
    await f.close();
  }
});
