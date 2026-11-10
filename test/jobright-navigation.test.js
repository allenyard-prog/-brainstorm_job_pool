import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openBrowser } from "../src/core/browser-manager.js";
import browserPlugin from "../plugins/jobright/browser.js";
import apiPlugin from "../plugins/jobright/api.js";
import { navigateJobright } from "../plugins/jobright/navigation.js";
import { openSignInDialog } from "../plugins/jobright/auth.js";
import {
  AuthenticationError,
  SystemicError,
  UnsupportedError,
} from "../src/core/errors.js";
import { startFixtureServer } from "./helpers/fixture-server.js";

async function fixture() {
  const server = await startFixtureServer(),
    directory = await mkdtemp(join(tmpdir(), "job-navigation-"));
  const browser = await openBrowser({
    sessionPath: join(directory, "session.json"),
    timeout: 4000,
  });
  const context = {
    ...browser,
    http: browser.context.request,
    credentials: {
      email: "fixture@example.test",
      password: "fixture-password",
    },
    config: { baseUrl: server.baseUrl, timeout: 4000 },
  };
  return {
    server,
    browser,
    context,
    async close() {
      await browser.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("browser and API session login work while DOMContentLoaded is blocked by a deferred asset", async () => {
  const f = await fixture();
  try {
    f.server.stallAssets();
    await browserPlugin.authenticate(f.context);
    await assert.rejects(
      f.browser.page.waitForLoadState("domcontentloaded", { timeout: 100 }),
    );
    const fromApi = await apiPlugin.listJobs(f.context),
      fromBrowser = await browserPlugin.listJobs(f.context);
    assert.deepEqual(
      fromApi.map((job) => job.id),
      fromBrowser.map((job) => job.id),
    );
    const detail = await browserPlugin.getJobDetails(f.context, fromBrowser[0]);
    assert.equal(detail.id, fromBrowser[0].id);
    await browserPlugin.listJobs(f.context);
    const submitted = f.server.requests.filter(
      (request) => request.path === "/fixture-login",
    ).length;
    f.context.hasSession = true;
    await apiPlugin.authenticate(f.context);
    assert.equal(
      f.server.requests.filter((request) => request.path === "/fixture-login")
        .length,
      submitted,
    );
    assert.equal(
      await browserPlugin.getApplicationStatus(f.context, {
        id: "not-applied",
      }),
      "unknown",
    );
    assert.equal(f.server.applied.size, 0);
  } finally {
    await f.close();
  }
});

test("only transient page reads retry, with a strict attempt limit and clear errors", async () => {
  const f = await fixture();
  try {
    await f.browser.context.addCookies([
      { name: "fixture-session", value: "valid", url: f.server.baseUrl },
    ]);
    let count = 0;
    await f.browser.context.route("**/jobs/recommend", (route) =>
      ++count === 1 ? route.abort("connectionreset") : route.continue(),
    );
    await navigateJobright(f.context, `${f.server.baseUrl}/jobs/recommend`);
    assert.equal(count, 2);
    await f.browser.context.unroute("**/jobs/recommend");
    f.server.failNavigations(2);
    let before = f.server.requests.length;
    await navigateJobright(f.context, `${f.server.baseUrl}/jobs/recommend`);
    assert.equal(
      f.server.requests
        .slice(before)
        .filter((request) => request.path === "/jobs/recommend").length,
      3,
    );
    f.server.failNavigations(10);
    before = f.server.requests.length;
    await assert.rejects(
      navigateJobright(f.context, `${f.server.baseUrl}/jobs/recommend`),
      (error) =>
        error instanceof SystemicError &&
        /3 attempts \(HTTP 503\)/.test(error.message),
    );
    assert.equal(
      f.server.requests
        .slice(before)
        .filter((request) => request.path === "/jobs/recommend").length,
      3,
    );
    for (const [status, Type] of [
      [403, AuthenticationError],
      [429, SystemicError],
      [404, UnsupportedError],
    ]) {
      f.server.failNavigations(1, status);
      before = f.server.requests.length;
      await assert.rejects(
        navigateJobright(f.context, `${f.server.baseUrl}/jobs/recommend`),
        Type,
      );
      assert.equal(
        f.server.requests
          .slice(before)
          .filter((request) => request.path === "/jobs/recommend").length,
        1,
      );
    }
    assert.equal(
      f.server.requests.filter(
        (request) =>
          request.path === "/fixture-login" ||
          request.path === "/swan/job/apply",
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Stop cancels a main-document request promptly without closing the authenticated HTTP context", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    f.server.holdRecommendations();
    const pending = navigateJobright(
      {
        ...f.context,
        signal: controller.signal,
        config: { ...f.context.config, timeout: 60000 },
      },
      `${f.server.baseUrl}/jobs/recommend`,
    );
    const rejected = assert.rejects(
      pending,
      (error) => error.name === "AbortError",
    );
    const deadline = Date.now() + 2000;
    while (
      !f.server.requests.some(
        (request) => request.path === "/jobs/recommend",
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    controller.abort();
    await rejected;
    assert.ok(Date.now() - started < 1500);
    const response = await f.browser.context.request.get(f.server.baseUrl);
    assert.equal(response.status(), 200);
    await response.dispose();
  } finally {
    await f.close();
  }
});

test("expired saved sessions can sign in once, while rejected credentials are never retried", async () => {
  const f = await fixture();
  try {
    f.context.hasSession = true;
    await browserPlugin.authenticate(f.context);
    assert.equal(
      f.server.requests.filter((request) => request.path === "/fixture-login")
        .length,
      1,
    );
    await f.browser.context.clearCookies();
    f.server.delaySignIn(800);
    f.context.credentials.password = "incorrect-password";
    await assert.rejects(
      apiPlugin.authenticate(f.context),
      AuthenticationError,
    );
    assert.equal(
      f.server.requests.filter((request) => request.path === "/fixture-login")
        .length,
      2,
    );
    assert.equal(f.server.applied.size, 0);
  } finally {
    await f.close();
  }
});

test("SIGN IN is retried when rendered before its handler, without submitting credentials", async () => {
  const f = await fixture();
  try {
    f.server.delaySignIn(800);
    assert.equal(
      await navigateJobright(f.context, f.server.baseUrl, { kind: "entry" }),
      "sign_in",
    );
    assert.equal(await openSignInDialog(f.context), "credentials");
    assert.ok(
      (await f.browser.page.evaluate(() => window.fixtureDialogActivations)) >=
        2,
    );
    assert.equal(
      await f.browser.page
        .getByPlaceholder("Password", { exact: true })
        .isVisible(),
      true,
    );
    assert.equal(
      f.server.requests.filter((request) => request.path === "/fixture-login")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

for (const [name, plugin] of [
  ["browser", browserPlugin],
  ["API", apiPlugin],
]) {
  test(`${name} fresh login handles delayed hydration and submits credentials once`, async () => {
    const f = await fixture();
    try {
      f.server.delaySignIn(800);
      await plugin.authenticate(f.context);
      assert.equal(
        f.server.requests.filter((request) => request.path === "/fixture-login")
          .length,
        1,
      );
      assert.equal(f.server.applied.size, 0);
    } finally {
      await f.close();
    }
  });
}

test("a partially rendered sign-in dialog is awaited without toggling its trigger", async () => {
  const f = await fixture();
  try {
    f.server.delaySignIn(-1);
    await navigateJobright(f.context, f.server.baseUrl, { kind: "entry" });
    await f.browser.page.evaluate(() => {
      document.querySelector(".ant-modal").hidden = false;
      const password = document.querySelector('input[placeholder="Password"]');
      password.hidden = true;
      setTimeout(() => {
        password.hidden = false;
      }, 500);
    });
    assert.equal(await openSignInDialog(f.context), "credentials");
    assert.equal(
      await f.browser.page.evaluate(() => window.fixtureDialogActivations),
      0,
    );
    assert.equal(
      f.server.requests.filter((request) => request.path === "/fixture-login")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a permanently unhydrated dialog fails within budget without submitting or saving a session", async () => {
  const f = await fixture();
  let saved = 0;
  try {
    f.server.delaySignIn(-1);
    const started = Date.now();
    await assert.rejects(
      browserPlugin.authenticate({
        ...f.context,
        config: { ...f.context.config, timeout: 600 },
        saveSession: async () => {
          saved++;
        },
      }),
      (error) =>
        error instanceof SystemicError &&
        /SIGN IN dialog did not become interactive/.test(error.message),
    );
    assert.ok(Date.now() - started < 2500);
    assert.equal(saved, 0);
    assert.equal(
      f.server.requests.filter((request) => request.path === "/fixture-login")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Stop promptly cancels hydration waiting without a login submission", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let timer;
  try {
    f.server.delaySignIn(-1);
    await navigateJobright(f.context, f.server.baseUrl, { kind: "entry" });
    const started = Date.now();
    timer = setTimeout(() => controller.abort(), 100);
    await assert.rejects(
      openSignInDialog({ ...f.context, signal: controller.signal }),
      (error) => error.name === "AbortError",
    );
    assert.ok(Date.now() - started < 1500);
    assert.equal(
      f.server.requests.filter((request) => request.path === "/fixture-login")
        .length,
      0,
    );
    assert.equal(f.server.applied.size, 0);
  } finally {
    clearTimeout(timer);
    await f.close();
  }
});

test("HTTP success without authenticated UI is not accepted as a valid session", async () => {
  const f = await fixture();
  let saved = 0;
  try {
    await f.browser.context.route("**/jobs/recommend", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>Loading...</body></html>",
      }),
    );
    await assert.rejects(
      browserPlugin.authenticate({
        ...f.context,
        hasSession: true,
        config: { ...f.context.config, timeout: 250 },
        saveSession: async () => {
          saved++;
        },
      }),
      SystemicError,
    );
    assert.equal(saved, 0);
    assert.equal(f.server.applied.size, 0);
  } finally {
    await f.close();
  }
});
