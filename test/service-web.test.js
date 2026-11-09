import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serviceFixture } from "./helpers/service-fixture.js";

test("site capabilities and run filters remain authenticated and owner scoped", async () => {
  const f = await serviceFixture();
  try {
    const alice = await f.login("alice"),
      bob = await f.login("bob");
    assert.equal((await f.request("GET", "/api/v1/sites")).statusCode, 401);
    const sites = (
      await f.request("GET", "/api/v1/sites", undefined, alice)
    ).json();
    assert.equal(sites[0].id, "jobright");
    assert.ok(sites[0].transports.includes("api"));
    assert.ok(sites[0].operations.includes("markAsApplied"));
    const one = await f.connect(alice, "hold", "one@provider.test"),
      two = await f.connect(alice, "hold", "two@provider.test");
    const first = (
      await f.request("POST", "/api/v1/runs", { connectionId: one.id }, alice)
    ).json();
    await f.app.db.call("endRun", first.id, "completed");
    const second = (
      await f.request("POST", "/api/v1/runs", { connectionId: one.id }, alice)
    ).json();
    await f.request("POST", "/api/v1/runs", { connectionId: two.id }, alice);
    const active = (
      await f.request(
        "GET",
        `/api/v1/runs?connectionId=${one.id}&status=active`,
        undefined,
        alice,
      )
    ).json();
    assert.deepEqual(
      active.items.map((run) => run.id),
      [second.id],
    );
    const page = (
      await f.request(
        "GET",
        `/api/v1/runs?connectionId=${one.id}&limit=1`,
        undefined,
        alice,
      )
    ).json();
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = (
      await f.request(
        "GET",
        `/api/v1/runs?connectionId=${one.id}&limit=1&cursor=${page.nextCursor}`,
        undefined,
        alice,
      )
    ).json();
    assert.equal(next.items[0].id, first.id);
    assert.equal(
      (
        await f.request(
          "GET",
          `/api/v1/runs?connectionId=${one.id}`,
          undefined,
          bob,
        )
      ).json().items.length,
      0,
    );
    assert.equal(
      (await f.request("GET", "/api/v1/runs?status=unknown", undefined, alice))
        .statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});
test("frontend history fallback preserves API, documentation and missing-asset responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gather-static-"));
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><title>Frontend fixture</title>",
  );
  await writeFile(
    join(directory, "assets", "app.js"),
    'console.log("fixture")',
  );
  const f = await serviceFixture({ webDist: directory });
  try {
    const cookie = await f.login("alice");
    for (const path of [
      "/",
      "/login",
      "/dashboard",
      "/runs/run-id",
      "/jobs/123",
    ]) {
      const result = await f.request("GET", path);
      assert.equal(result.statusCode, 200);
      assert.match(result.headers["content-type"], /html/);
      assert.match(result.body, /Frontend fixture/);
    }
    assert.equal((await f.request("GET", "/assets/app.js")).statusCode, 200);
    for (const path of [
      "/api/v1/unknown",
      "/assets/missing.js",
      "/favicon-missing.svg",
      "/docs/missing",
      "/health/missing",
    ]) {
      const result = await f.request("GET", path, undefined, cookie);
      assert.equal(result.statusCode, 404, path);
      assert.ok(!result.body.includes("Frontend fixture"));
    }
    assert.equal((await f.request("GET", "/docs/json")).statusCode, 200);
    assert.equal((await f.request("GET", "/health")).statusCode, 200);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
