import test from "node:test";
import assert from "node:assert/strict";
import { ServiceStore } from "../src/storage/service-store.js";
import { migrate } from "../src/storage/migrations.js";
import { serviceFixture } from "./helpers/service-fixture.js";
import { removeProfileSchema } from "./helpers/profile-schema.js";
import { accountKey } from "../src/core/security.js";

async function fixture() {
  const f = await serviceFixture();
  const cookie = await f.login("alice"),
    bob = await f.login("bob"),
    admin = await f.login("admin");
  const one = await f.connect(cookie, "fixture", "one@provider.test"),
    two = await f.connect(cookie, "fixture", "two@provider.test");
  const foreign = await f.connect(bob, "fixture", "foreign@provider.test");
  const store = new ServiceStore(f.config.dbPath);
  function save(profile, sourceId, owner = f.users.alice) {
    const writer = new ServiceStore(f.config.dbPath, {
      userId: owner.id,
      connectionId: profile.id,
    });
    const job = {
      id: sourceId,
      title: `Cloud Engineer ${sourceId}`,
      company: "Company",
      url: "https://example.test/job",
      details: {
        description: { text: "Full preserved content. ".repeat(2000) },
        applicationUrl: "https://employer.test/apply",
        company: { companyName: "Company" },
      },
      raw: { retained: "raw source" },
    };
    try {
      return writer.saveJob("jobright", accountKey(profile.label), job);
    } finally {
      writer.close();
    }
  }
  const a = save(one, "a"),
    b = save(one, "b"),
    c = save(two, "c"),
    other = save(foreign, "private", f.users.bob);
  async function command(method, path, body, status = 200, session = cookie) {
    const response = await f.request(method, `/api/v1${path}`, body, session);
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  }
  return {
    ...f,
    cookie,
    bob,
    admin,
    one,
    two,
    store,
    a,
    b,
    c,
    other,
    save,
    command,
    async close() {
      store.close();
      await f.close();
    },
  };
}

test("profile names preserve account identity and specializations normalize, rename, archive and restore", async () => {
  const f = await fixture();
  try {
    const created = await f.command(
      "POST",
      "/connections",
      {
        site: "jobright",
        email: "new@provider.test",
        password: "never-return-this",
        personName: "  Daniel   Zhang  ",
      },
      201,
    );
    assert.equal(created.personName, "Daniel Zhang");
    assert.equal(created.label, "new@provider.test");
    assert.deepEqual(created.titles, []);
    const person = await f.command("PATCH", `/connections/${f.one.id}`, {
      personName: "Daniel Zhang",
    });
    assert.equal(person.label, f.one.label);
    const sre = await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "  SRE  " },
      201,
    );
    assert.equal(sre.title, "SRE");
    await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "sre" },
      409,
    );
    await f.command(
      "POST",
      `/connections/${f.two.id}/titles`,
      { title: "SRE" },
      201,
    );
    const platform = await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "Platform   Engineer" },
      201,
    );
    assert.equal(platform.title, "Platform Engineer");
    await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "platform engineer" },
      409,
    );
    await f.command(
      "PATCH",
      `/connections/${f.one.id}/titles/${sre.id}`,
      { title: "Platform Engineer" },
      409,
    );
    const renamed = await f.command(
      "PATCH",
      `/connections/${f.one.id}/titles/${sre.id}`,
      { title: "Site Reliability Engineer" },
    );
    assert.equal(renamed.id, sre.id);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await f.command(
            "PATCH",
            `/connections/${f.one.id}/titles/${sre.id}`,
            { isArchived: true },
          )
        ).isArchived,
        true,
      );
    await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "site reliability engineer" },
      409,
    );
    assert.equal(
      (
        await f.command("PATCH", `/connections/${f.one.id}/titles/${sre.id}`, {
          isArchived: false,
        })
      ).isArchived,
      false,
    );
    const profiles = await f.command("GET", "/connections");
    assert.equal(
      profiles.find((profile) => profile.id === f.one.id).titles.length,
      2,
    );
    assert.ok(!JSON.stringify(profiles).includes("never-return-this"));
    assert.ok(!JSON.stringify(profiles).includes("encrypted_credentials"));
    assert.equal(
      (
        await f.command("PATCH", `/connections/${f.one.id}`, {
          personName: null,
        })
      ).personName,
      null,
    );
  } finally {
    await f.close();
  }
});

test("preferred titles are independent annotations, survive re-scraping and preserve archived selections", async () => {
  const f = await fixture();
  try {
    f.store.transition(f.a, accountKey(f.one.label), "mark_pending");
    f.store.assignJobs(f.users.alice.id, { connectionId: f.one.id });
    const before = f.store.jobDetail(f.users.alice.id, f.a, true);
    const title = await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "SRE" },
      201,
    );
    const selected = await f.command("PATCH", `/jobs/${f.a}`, {
      preferredTitleId: title.id,
    });
    assert.equal(selected.preferredTitle, "SRE");
    assert.equal(selected.title, before.title);
    assert.equal(selected.assignedAt, before.assignedAt);
    assert.equal(selected.processingState, "mark_pending");
    assert.ok(!Object.hasOwn(selected, "details"));
    f.save(f.one, "a");
    const after = await f.command("GET", `/jobs/${f.a}?includeRaw=true`);
    assert.equal(after.preferredTitleId, title.id);
    assert.equal(after.firstSeenAt, before.firstSeenAt);
    assert.equal(after.assignedAt, before.assignedAt);
    assert.deepEqual(after.details, before.details);
    assert.deepEqual(after.raw, before.raw);
    await f.command("PATCH", `/connections/${f.one.id}/titles/${title.id}`, {
      title: "DevOps Engineer",
      isArchived: true,
    });
    const retained = await f.command("PATCH", `/jobs/${f.a}`, {
      preferredTitleId: title.id,
    });
    assert.equal(retained.preferredTitle, "DevOps Engineer");
    assert.equal(retained.preferredTitleArchived, true);
    await f.command(
      "PATCH",
      `/jobs/${f.b}`,
      { preferredTitleId: title.id },
      409,
    );
    assert.equal(
      (await f.command("PATCH", `/jobs/${f.a}`, { preferredTitleId: null }))
        .preferredTitle,
      null,
    );
    await f.command(
      "PATCH",
      `/jobs/${f.a}`,
      { preferredTitleId: title.id },
      409,
    );
    await f.command("PATCH", `/connections/${f.one.id}/titles/${title.id}`, {
      isArchived: false,
    });
    await f.command("PATCH", `/jobs/${f.a}`, { preferredTitleId: title.id });
    assert.equal(
      f.store.jobDetail(f.users.alice.id, f.a).processingState,
      "mark_pending",
    );
  } finally {
    await f.close();
  }
});

test("all title writes enforce ownership and the exact job connection, including administrators", async () => {
  const f = await fixture();
  try {
    const title = await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "SRE" },
      201,
    );
    for (const session of [f.bob, f.admin]) {
      await f.command(
        "PATCH",
        `/connections/${f.one.id}`,
        { personName: "Wrong owner" },
        404,
        session,
      );
      await f.command(
        "POST",
        `/connections/${f.one.id}/titles`,
        { title: "Private" },
        404,
        session,
      );
      await f.command(
        "PATCH",
        `/connections/${f.one.id}/titles/${title.id}`,
        { isArchived: true },
        404,
        session,
      );
      await f.command(
        "PATCH",
        `/jobs/${f.a}`,
        { preferredTitleId: title.id },
        404,
        session,
      );
    }
    await f.command(
      "PATCH",
      `/connections/${f.two.id}/titles/${title.id}`,
      { title: "Wrong profile" },
      404,
    );
    await f.command(
      "PATCH",
      `/jobs/${f.c}`,
      { preferredTitleId: title.id },
      404,
    );
    await f.command(
      "PATCH",
      `/jobs/${f.other}`,
      { preferredTitleId: title.id },
      404,
    );
    const foreignTitle = await f.command(
      "POST",
      `/connections/${f.two.id}/titles`,
      { title: "Platform" },
      201,
    );
    await f.command(
      "PATCH",
      `/jobs/${f.a}`,
      { preferredTitleId: foreignTitle.id },
      404,
    );
    const outsider = await f.command(
      "GET",
      "/connections",
      undefined,
      200,
      f.bob,
    );
    assert.ok(outsider.every((profile) => profile.id !== f.one.id));
  } finally {
    await f.close();
  }
});

test("profile metadata remains editable during queued work, with strict title bodies and origin checks", async () => {
  const f = await fixture();
  try {
    await f.command(
      "POST",
      "/runs",
      { connectionId: f.one.id, transport: "api", readOnly: true },
      202,
    );
    await f.command("PATCH", `/connections/${f.one.id}`, {
      personName: "Daniel Zhang",
    });
    const title = await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "SRE" },
      201,
    );
    await f.command(
      "PATCH",
      `/connections/${f.one.id}/credentials`,
      { email: f.one.label, password: "replacement" },
      409,
    );
    for (const body of [
      {},
      { title: "   " },
      { title: "x".repeat(101) },
      { title: "SRE", password: "bad" },
    ])
      await f.command("POST", `/connections/${f.one.id}/titles`, body, 400);
    for (const body of [
      {},
      { isArchived: "false" },
      { title: "" },
      { isArchived: null },
    ])
      await f.command(
        "PATCH",
        `/connections/${f.one.id}/titles/${title.id}`,
        body,
        400,
      );
    for (const body of [
      {},
      { preferredTitleId: "invalid" },
      { preferredTitleId: false },
      { preferredTitleId: "" },
      { preferredTitleId: title.id, assignedAt: "bad" },
    ])
      await f.command("PATCH", `/jobs/${f.a}`, body, 400);
    const response = await f.request(
      "PATCH",
      `/api/v1/jobs/${f.a}`,
      { preferredTitleId: title.id },
      f.cookie,
      "https://untrusted.test",
    );
    assert.equal(response.statusCode, 403);
  } finally {
    await f.close();
  }
});

test("preferred-title filters, totals, sorting, exports, copying and assignment share the same owned set", async () => {
  const f = await fixture();
  try {
    const sre = await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "SRE" },
      201,
    );
    const devops = await f.command(
      "POST",
      `/connections/${f.one.id}/titles`,
      { title: "DevOps Engineer" },
      201,
    );
    const separate = await f.command(
      "POST",
      `/connections/${f.two.id}/titles`,
      { title: "SRE" },
      201,
    );
    await f.command("PATCH", `/jobs/${f.a}`, { preferredTitleId: sre.id });
    await f.command("PATCH", `/jobs/${f.b}`, { preferredTitleId: devops.id });
    await f.command("PATCH", `/jobs/${f.c}`, { preferredTitleId: separate.id });
    const ids = [f.a];
    for (let i = 0; i < 104; i++) {
      const id = f.save(f.one, `extra-${i}`);
      f.store.setPreferredTitle(f.users.alice.id, id, sre.id);
      ids.push(id);
    }
    const unselected = f.save(f.one, "unselected");
    const filter = `preferredTitleId=${sre.id}&sortBy=preferredTitle&sortOrder=asc`;
    const page = await f.command("GET", `/jobs?page=3&limit=20&${filter}`);
    assert.equal(page.total, 105);
    assert.equal(page.items.length, 20);
    assert.ok(page.items.every((job) => job.preferredTitleId === sre.id));
    await f.command("PATCH", `/connections/${f.one.id}/titles/${sre.id}`, {
      isArchived: true,
    });
    assert.equal((await f.command("GET", `/jobs?page=1&${filter}`)).total, 105);
    assert.deepEqual(
      (await f.command("GET", "/jobs?preferredTitleId=unselected")).items.map(
        (job) => job.id,
      ),
      [unselected],
    );
    for (const direction of ["asc", "desc"]) {
      const sorted = await f.command(
        "GET",
        `/jobs?sortBy=preferredTitle&sortOrder=${direction}&limit=100`,
      );
      assert.equal(
        sorted.items[0].preferredTitle,
        direction === "asc" ? "DevOps Engineer" : "SRE",
      );
    }
    const csv = await f.request(
      "GET",
      `/api/v1/jobs/export?${filter}`,
      undefined,
      f.cookie,
    );
    assert.equal(csv.statusCode, 200);
    assert.equal(csv.body.trim().split("\r\n").length, 106);
    assert.ok(
      csv.body
        .split("\r\n")[0]
        .endsWith("preferredTitleId,preferredTitle,preferredTitleArchived"),
    );
    assert.ok(csv.body.includes('"SRE","true"'));
    const copied = await f.request(
      "GET",
      `/api/v1/jobs/clipboard?${filter}`,
      undefined,
      f.cookie,
    );
    const sheet = copied.body.trim().split("\n");
    assert.equal(sheet.length, 106);
    assert.equal(sheet[0], "Company Name\tJob Title\tLink");
    assert.ok(
      sheet
        .slice(1)
        .every((row) => row.split("\t")[1].startsWith("Cloud Engineer")),
    );
    const assigned = await f.command("POST", "/jobs/assign", {
      preferredTitleId: sre.id,
    });
    assert.equal(assigned.assignedCount, 105);
    assert.equal(
      (
        await f.command(
          "GET",
          `/jobs?preferredTitleId=${sre.id}&status=assigned&page=1`,
        )
      ).total,
      105,
    );
    assert.equal(
      (
        await f.command(
          "GET",
          `/jobs?preferredTitleId=${separate.id}&connectionId=${f.one.id}&page=1`,
        )
      ).total,
      0,
    );
  } finally {
    await f.close();
  }
});

test("profile sorting uses person names and falls back to account email", async () => {
  const f = await fixture();
  try {
    await f.command("PATCH", `/connections/${f.two.id}`, {
      personName: "Aaron",
    });
    let page = await f.command("GET", "/jobs?sortBy=profile&sortOrder=asc");
    assert.equal(page.items[0].id, f.c);
    await f.command("PATCH", `/connections/${f.one.id}`, {
      personName: "Aardvark",
    });
    page = await f.command("GET", "/jobs?sortBy=profile&sortOrder=asc");
    assert.equal(page.items[0].connectionId, f.one.id);
  } finally {
    await f.close();
  }
});

test("version-six migration preserves data, links and pending tracking and rolls back incomplete DDL", () => {
  const store = new ServiceStore(":memory:");
  try {
    const user = store.createUser({
      email: "legacy@fixture.test",
      passwordHash: "fixture",
    });
    const connection = store.createConnection({
      userId: user.id,
      site: "jobright",
      accountKey: "legacy",
      label: "Account",
      encryptedCredentials: "cipher",
      cliDefault: true,
    });
    const id = store.saveJob("jobright", "legacy", {
      id: "old",
      title: "Engineer",
      url: "https://example.test",
      company: "Acme",
      details: {
        description: { text: "Long content ".repeat(10000) },
        company: { companyName: "Acme" },
      },
      raw: { preserved: true },
    });
    store.transition(id, "legacy", "mark_pending");
    store.assignJobs(user.id);
    const sync = store.enqueueCompanySync(user.id);
    store.claimCompanySync();
    store.processCompanySyncBatch(sync.id);
    const before = store.jobDetail(user.id, id, true);
    store.setCompanyBlacklist(user.id, before.companyId, true);
    store.db.exec(
      removeProfileSchema +
        "PRAGMA user_version=6; CREATE TABLE profile_titles(unrelated TEXT);",
    );
    assert.throws(() => migrate(store.db, ":memory:"), /already exists/);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 6);
    assert.ok(
      !store.db
        .prepare("PRAGMA table_info(connections)")
        .all()
        .some((column) => column.name === "person_name"),
    );
    store.db.exec("DROP TABLE profile_titles");
    migrate(store.db, ":memory:");
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 7);
    assert.deepEqual(store.jobDetail(user.id, id, true), before);
    assert.equal(
      store.companyDetail(user.id, before.companyId).isBlacklisted,
      true,
    );
    assert.equal(store.listConnections(user.id)[0].personName, null);
    assert.deepEqual(store.listConnections(user.id)[0].titles, []);
    assert.equal(
      store.getConnection(user.id, connection.id).encrypted_credentials,
      "cipher",
    );
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    migrate(store.db, ":memory:");
  } finally {
    store.close();
  }
});
