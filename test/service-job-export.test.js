import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./helpers/service-fixture.js";
import { ServiceStore } from "../src/storage/service-store.js";
import { accountKey } from "../src/core/security.js";

function seed(f, user, connection, entries) {
  const store = new ServiceStore(f.config.dbPath, {
    userId: user.id,
    connectionId: connection.id,
  });
  const account = accountKey(connection.label);
  try {
    return entries.map(
      (
        {
          title = "Data Engineer",
          time = "2026-11-08T12:00:00.000Z",
          status = "saved",
          ...rest
        },
        index,
      ) => {
        const id = store.saveJob("jobright", account, {
          id: `seed-${index}`,
          title,
          company: 'Example, "Labs"',
          url: `https://example.test/jobs/${index}`,
          details: {
            description: { text: "Complete description.\nSecond line." },
            skills: ["SQL"],
            applicationUrl: `https://employer.test/apply/${index}`,
            sessionToken: "detail-secret",
          },
          raw: { retained: "raw-secret" },
          ...rest,
        });
        store.db
          .prepare(
            "UPDATE jobs SET first_seen_at=?,last_scraped_at=? WHERE id=?",
          )
          .run("2020-01-01T00:00:00.000Z", time, id);
        if (status !== "saved")
          store.transition(id, account, status, "applied");
        return id;
      },
    );
  } finally {
    store.close();
  }
}

// Read RFC-style CSV records, including quoted commas, quotes, and embedded newlines.
function parseCsv(text) {
  const rows = [],
    row = [];
  let field = "",
    quoted = false;
  for (
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    index < text.length;
    index++
  ) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (char === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      rows.push([...row]);
      row.length = 0;
      field = "";
    } else field += char;
  }
  return rows;
}

test("job time filters are inclusive, normalize offsets, paginate, and reject invalid ranges", async () => {
  const f = await serviceFixture();
  try {
    const cookie = await f.login("alice");
    const connection = await f.connect(cookie);
    const ids = seed(f, f.users.alice, connection, [
      { time: "2026-11-08T11:59:59.999Z" },
      { time: "2026-11-08T12:00:00.000Z" },
      { time: "2026-11-08T13:00:00.000Z" },
      { time: "2026-11-08T13:00:00.001Z" },
    ]);
    const range = new URLSearchParams({
      collectedFrom: "2026-11-08T07:00:00-05:00",
      collectedTo: "2026-11-08T08:00:00-05:00",
      limit: "1",
    });
    const first = await f.request(
      "GET",
      `/api/v1/jobs?${range}`,
      undefined,
      cookie,
    );
    assert.equal(first.statusCode, 200);
    assert.deepEqual(
      first.json().items.map((job) => job.id),
      [ids[2]],
    );
    assert.ok(!("details" in first.json().items[0]));
    range.set("cursor", first.json().nextCursor);
    const second = (
      await f.request("GET", `/api/v1/jobs?${range}`, undefined, cookie)
    ).json();
    assert.deepEqual(
      second.items.map((job) => job.id),
      [ids[1]],
    );
    assert.equal(second.nextCursor, null);
    for (const [filter, expected] of [
      ["collectedFrom=2026-11-08T13%3A00%3A00Z", [ids[3], ids[2]]],
      ["collectedTo=2026-11-08T12%3A00%3A00Z", [ids[1], ids[0]]],
    ]) {
      assert.deepEqual(
        (await f.request("GET", `/api/v1/jobs?${filter}`, undefined, cookie))
          .json()
          .items.map((job) => job.id),
        expected,
      );
    }
    for (const endpoint of ["/jobs", "/jobs/export"]) {
      for (const filter of [
        "collectedFrom=invalid",
        "collectedTo=2026-02-30T00%3A00%3A00Z",
        "collectedFrom=2026-11-09T00%3A00%3A00Z&collectedTo=2026-11-08T00%3A00%3A00Z",
      ])
        assert.equal(
          (
            await f.request(
              "GET",
              `/api/v1${endpoint}?${filter}`,
              undefined,
              cookie,
            )
          ).statusCode,
          400,
        );
    }
  } finally {
    await f.close();
  }
});

test("CSV downloads export every matching page, retain details, escape spreadsheet cells, and isolate owners", async () => {
  const f = await serviceFixture();
  try {
    const alice = await f.login("alice"),
      bob = await f.login("bob"),
      admin = await f.login("admin");
    const connection = await f.connect(alice),
      other = await f.connect(alice, "hold", "other@provider.test");
    const bobConnection = await f.connect(bob);
    const title = '  =Engineer, "lead"\nRemote';
    const ids = seed(f, f.users.alice, connection, [
      ...Array.from({ length: 105 }, (_, index) => ({
        title: index === 0 ? title : `Engineer ${index}`,
        status: "mark_confirmed",
      })),
      {
        title: "Engineer too early",
        status: "mark_confirmed",
        time: "2026-11-07T00:00:00.000Z",
      },
      { title: "Engineer wrong status" },
      { title: "Designer", status: "mark_confirmed" },
    ]);
    seed(f, f.users.alice, other, [
      { title: "Engineer wrong profile", status: "mark_confirmed" },
    ]);
    seed(f, f.users.bob, bobConnection, [
      { title: "Engineer other owner", status: "mark_confirmed" },
    ]);
    const params = new URLSearchParams({
      connectionId: connection.id,
      site: "jobright",
      q: "Engineer",
      status: "mark_confirmed",
      collectedFrom: "2026-11-08T12:00:00Z",
      collectedTo: "2026-11-08T13:00:00Z",
    });
    const path = `/api/v1/jobs/export?${params}`;
    assert.equal((await f.request("GET", path)).statusCode, 401);
    const response = await f.request("GET", path, undefined, alice);
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /^text\/csv/);
    assert.match(
      response.headers["content-disposition"],
      /attachment; filename="gather-jobs.csv"/,
    );
    assert.equal(response.headers["cache-control"], "private, no-store");
    const [headers, ...rows] = parseCsv(response.body);
    assert.equal(rows.length, 105);
    const records = rows.map((row) =>
      Object.fromEntries(headers.map((name, index) => [name, row[index]])),
    );
    assert.deepEqual(
      records.map((job) => Number(job.id)),
      ids.slice(0, 105).reverse(),
    );
    assert.equal(records.at(-1).title, `'${title}`);
    assert.equal(records[0].company, 'Example, "Labs"');
    assert.equal(
      JSON.parse(records[0].details).description.text,
      "Complete description.\nSecond line.",
    );
    assert.equal(JSON.parse(records[0].details).sessionToken, "[REDACTED]");
    assert.ok(!response.body.includes("detail-secret"));
    assert.ok(!response.body.includes("raw-secret"));
    for (const outsider of [bob, admin]) {
      assert.equal(
        parseCsv((await f.request("GET", path, undefined, outsider)).body)
          .length,
        1,
      );
    }
    assert.equal(
      parseCsv(
        (
          await f.request(
            "GET",
            "/api/v1/jobs/export?q=nonexistent",
            undefined,
            alice,
          )
        ).body,
      ).length,
      1,
    );
    assert.equal(
      (await f.request("GET", `${path}&cursor=ignored`, undefined, alice))
        .statusCode,
      400,
    );
    assert.equal(
      parseCsv(
        (
          await f.request(
            "GET",
            `${path.replace("site=jobright", "site=other-site")}`,
            undefined,
            alice,
          )
        ).body,
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("bulk assignment and Sheets copying share all filters, span pages, preserve processing state, and respect Tracking", async () => {
  const f = await serviceFixture();
  try {
    const alice = await f.login("alice"),
      bob = await f.login("bob"),
      admin = await f.login("admin");
    const connection = await f.connect(alice),
      other = await f.connect(alice, "hold", "other@provider.test"),
      bobConnection = await f.connect(bob);
    const ids = seed(f, f.users.alice, connection, [
      ...Array.from({ length: 105 }, (_, index) => ({
        title: index === 0 ? '=Engineer, "lead"\nRemote' : `Engineer ${index}`,
        status: "mark_confirmed",
      })),
      {
        title: "Engineer too early",
        status: "mark_confirmed",
        time: "2026-11-07T00:00:00.000Z",
      },
      { title: "Engineer pending", status: "mark_pending" },
      { title: "Designer", status: "mark_confirmed" },
    ]);
    const [otherId] = seed(f, f.users.alice, other, [
      { title: "Engineer other profile", status: "mark_confirmed" },
    ]);
    const [bobId] = seed(f, f.users.bob, bobConnection, [
      { title: "Engineer other owner", status: "mark_confirmed" },
    ]);
    const store = new ServiceStore(f.config.dbPath);
    try {
      store.db
        .prepare("UPDATE jobs SET assigned_at=? WHERE id=?")
        .run("2026-11-08T14:00:00.000Z", ids[104]);
    } finally {
      store.close();
    }
    const filters = {
      connectionId: connection.id,
      q: "Engineer",
      site: "jobright",
      status: "mark_confirmed",
      collectedFrom: "2026-11-08T12:00:00Z",
      collectedTo: "2026-11-08T13:00:00Z",
    };
    const clipboardPath = `/api/v1/jobs/clipboard?${new URLSearchParams(filters)}`;
    assert.equal((await f.request("GET", clipboardPath)).statusCode, 401);
    assert.equal(
      (await f.request("POST", "/api/v1/jobs/assign", filters)).statusCode,
      401,
    );
    assert.equal(
      (
        await f.request(
          "POST",
          "/api/v1/jobs/assign",
          filters,
          alice,
          "https://untrusted.test",
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.request(
          "POST",
          "/api/v1/jobs/assign",
          { ...filters, cursor: "ignored" },
          alice,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.request(
          "POST",
          "/api/v1/jobs/assign",
          { ...filters, collectedTo: "2026-11-07T00:00:00Z" },
          alice,
        )
      ).statusCode,
      400,
    );
    const copied = await f.request("GET", clipboardPath, undefined, alice);
    assert.equal(copied.statusCode, 200);
    assert.match(copied.headers["content-type"], /^text\/plain/);
    const rows = copied.body
      .trimEnd()
      .split("\n")
      .map((row) => row.split("\t"));
    assert.deepEqual(rows[0], ["Company Name", "Job Title", "Link"]);
    assert.equal(rows.length, 105);
    assert.ok(rows.every((row) => row.length === 3));
    assert.deepEqual(rows.at(-1), [
      'Example, "Labs"',
      '\'=Engineer, "lead" Remote',
      "https://employer.test/apply/0",
    ]);
    assert.ok(!copied.body.includes("Engineer 104"));
    assert.equal(rows[1][2], "https://employer.test/apply/103");
    assert.ok(!copied.body.includes("https://example.test/jobs/"));
    assert.ok(!copied.body.includes("detail-secret"));
    assert.ok(!copied.body.includes("Engineer pending"));
    assert.equal(
      (await f.app.db.call("jobDetail", f.users.alice.id, ids[0])).assignedAt,
      null,
    );
    for (const outsider of [bob, admin]) {
      assert.equal(
        (
          await f.request("POST", "/api/v1/jobs/assign", filters, outsider)
        ).json().assignedCount,
        0,
      );
      assert.equal(
        (await f.request("GET", clipboardPath, undefined, outsider)).body,
        "Company Name\tJob Title\tLink\n",
      );
    }
    const assigned = await f.request(
      "POST",
      "/api/v1/jobs/assign",
      filters,
      alice,
    );
    assert.equal(assigned.statusCode, 200);
    assert.equal(assigned.json().assignedCount, 104);
    const detail = await f.app.db.call("jobDetail", f.users.alice.id, ids[0]);
    assert.ok(detail.assignedAt);
    assert.equal(detail.processingState, "mark_confirmed");
    assert.equal(detail.websiteStatus, "applied");
    assert.equal(
      (await f.app.db.call("jobDetail", f.users.alice.id, ids[104])).assignedAt,
      "2026-11-08T14:00:00.000Z",
    );
    for (const id of [ids[105], ids[106], ids[107], otherId])
      assert.equal(
        (await f.app.db.call("jobDetail", f.users.alice.id, id)).assignedAt,
        null,
      );
    assert.equal(
      (await f.app.db.call("jobDetail", f.users.bob.id, bobId)).assignedAt,
      null,
    );
    assert.equal(
      (await f.request("POST", "/api/v1/jobs/assign", filters, alice)).json()
        .assignedCount,
      0,
    );
    assert.equal(
      (await f.request("GET", clipboardPath, undefined, alice)).body,
      "Company Name\tJob Title\tLink\n",
    );
    const assignedFilters = { ...filters, status: "assigned" };
    const assignedClipboard = (
      await f.request(
        "GET",
        `/api/v1/jobs/clipboard?${new URLSearchParams(assignedFilters)}`,
        undefined,
        alice,
      )
    ).body;
    assert.equal(assignedClipboard.trimEnd().split("\n").length, 106);
    const allFilters = { ...filters };
    delete allFilters.status;
    const allClipboard = (
      await f.request(
        "GET",
        `/api/v1/jobs/clipboard?${new URLSearchParams(allFilters)}`,
        undefined,
        alice,
      )
    ).body;
    assert.equal(allClipboard.trimEnd().split("\n").length, 107);
    const page = (
      await f.request(
        "GET",
        `/api/v1/jobs?${new URLSearchParams(assignedFilters)}&limit=100`,
        undefined,
        alice,
      )
    ).json();
    assert.equal(page.items.length, 100);
    assert.ok(page.items.every((job) => job.assignedAt));
    const next = (
      await f.request(
        "GET",
        `/api/v1/jobs?${new URLSearchParams(assignedFilters)}&limit=100&cursor=${page.nextCursor}`,
        undefined,
        alice,
      )
    ).json();
    assert.equal(next.items.length, 5);
    assert.equal(
      (
        await f.request(
          "GET",
          `/api/v1/jobs?${new URLSearchParams(filters)}`,
          undefined,
          alice,
        )
      ).json().items.length,
      0,
    );
    assert.equal(
      (
        await f.request(
          "GET",
          `/api/v1/jobs?${new URLSearchParams({ ...filters, status: "available" })}`,
          undefined,
          alice,
        )
      ).json().items.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("clipboard links use only valid external application URLs and leave missing/unsafe links blank", async () => {
  const f = await serviceFixture();
  try {
    const cookie = await f.login("alice"),
      connection = await f.connect(cookie);
    const urls = [
      "https://boards.greenhouse.io/example/jobs/123?source=jobright",
      "http://employer.test/apply/456",
      null,
      undefined,
      "",
      "not-a-url",
      "javascript:alert(1)",
      "https://jobright.ai/jobs/info/123",
      "https://www.jobright.ai/redirect/123",
      "https://JOBRIGHT.AI./jobs/info/123",
      "https://user:password@employer.test/apply",
    ];
    seed(
      f,
      f.users.alice,
      connection,
      urls.map((applicationUrl, index) => ({
        title: `Application URL ${index}`,
        url: `https://jobright.ai/jobs/info/${index}`,
        details: {
          description: { text: "Stored description" },
          applicationUrl,
        },
      })),
    );
    const response = await f.request(
      "GET",
      "/api/v1/jobs/clipboard",
      undefined,
      cookie,
    );
    assert.equal(response.statusCode, 200);
    const rows = response.body
      .split("\n")
      .filter(Boolean)
      .slice(1)
      .map((line) => line.split("\t"));
    assert.equal(rows.length, urls.length);
    assert.ok(rows.every((row) => row.length === 3));
    const byTitle = new Map(rows.map((row) => [row[1], row[2]]));
    assert.equal(byTitle.get("Application URL 0"), urls[0]);
    assert.equal(byTitle.get("Application URL 1"), urls[1]);
    for (let index = 2; index < urls.length; index++)
      assert.equal(byTitle.get(`Application URL ${index}`), "");
    assert.ok(!response.body.includes("jobright.ai/jobs/info/"));
    assert.ok(!response.body.includes("javascript:"));
  } finally {
    await f.close();
  }
});
