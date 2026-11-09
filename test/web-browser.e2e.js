import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serviceFixture, backendPassword } from "./helpers/service-fixture.js";
import { ServiceStore } from "../src/storage/service-store.js";
import { accountKey } from "../src/core/security.js";
import { encryptCredentials } from "../src/service/crypto.js";

async function browserFixture() {
  await access(resolve("web/dist/index.html"));
  const f = await serviceFixture({
    webDist: resolve("web/dist"),
    stopGraceMs: 1000,
  });
  async function connection(user, email, password = "hold") {
    const key = accountKey(email);
    return f.app.db.call("createConnection", {
      userId: user.id,
      site: "jobright",
      accountKey: key,
      label: email,
      encryptedCredentials: encryptCredentials(
        { email, password },
        f.config.key,
        `${user.id}:jobright:${key}`,
      ),
    });
  }
  const aliceProfile = await connection(f.users.alice, "alice@provider.test");
  const bobProfile = await connection(f.users.bob, "bob@provider.test");
  const seed = (user, profile, title) => {
    const key = accountKey(profile.label),
      store = new ServiceStore(f.config.dbPath, {
        userId: user.id,
        connectionId: profile.id,
      });
    try {
      const id = store.saveJob("jobright", key, {
        id: title,
        url: "https://jobright.ai/jobs/info/fixture",
        title,
        company:
          user.id === f.users.alice.id ? "Northstar Labs" : "Bob Company",
        details: {
          description: {
            text: 'Build thoughtful data products and reliable pipelines.\n<img src=x onerror="window.compromised=true">',
          },
          applicationUrl: "javascript:alert(1)",
          locations: ["New York, NY", "San Francisco, CA"],
          workArrangement: "Hybrid",
          employmentType: "Full-time",
          seniority: "Senior Level",
          compensation: { display: "$150K/yr – $185K/yr" },
          responsibilities: [
            "Build reliable pipelines",
            "Improve data quality",
          ],
          qualifications: {
            required: ["SQL experience", "Strong communication"],
            preferred: ["Python"],
          },
          skills: ["SQL", "Python", "dbt"],
          benefits: ["Health insurance", "Learning budget"],
          company: {
            companyName: "Northstar Labs",
            companyDesc: "A team building useful, dependable software.",
            companyLocation: "New York",
            companySize: "51–200 employees",
            companyURL: "https://company.test",
          },
          postedAt: "2 days ago",
          matching: {
            score: 86,
            label: "Strong match",
            recommendations: [{ displayName: "Skill match", score: 0.92 }],
          },
          extra: { future: "Additional preserved information" },
        },
        raw: {
          retained: "Source data preserved",
          sessionToken: "must-not-appear",
        },
      });
      store.transition(id, key, "mark_confirmed", "applied");
      return id;
    } finally {
      store.close();
    }
  };
  const jobId = seed(f.users.alice, aliceProfile, "Senior Data Engineer");
  seed(f.users.bob, bobProfile, "Bob-only opportunity");
  const history = await f.app.db.call(
    "enqueue",
    f.users.alice.id,
    aliceProfile.id,
    "collection",
    { transport: "api", readOnly: false, limit: 100 },
  );
  await f.app.db.call("endRun", history.id, "completed");
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  f.config.origin = address;
  f.config.allowedOrigins.splice(0, f.config.allowedOrigins.length, address);
  await f.app.supervisor.start();
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function login(name = "alice") {
    await page.goto(`${address}/login`);
    await page
      .getByLabel("Email address", { exact: true })
      .fill(`${name}@fixture.test`);
    await page.getByLabel("Password", { exact: true }).fill(backendPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Your collection, in motion." })
      .waitFor();
  }
  return {
    ...f,
    page,
    browser,
    address,
    aliceProfile,
    jobId,
    errors,
    login,
    addConnection: connection,
    async close() {
      await browser.close();
      await f.close();
    },
  };
}

test("browser UI: collect, navigate while running, view details, stop/retry and render mobile", async () => {
  const f = await browserFixture();
  try {
    await f.login();
    const { page } = f;
    await page
      .getByRole("button", { name: "Start collection", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.getByLabel(/Mark saved jobs as Already applied/).isChecked(),
      true,
    );
    await dialog
      .getByRole("button", { name: "Start collection", exact: true })
      .click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Running" })
      .waitFor();
    const runUrl = page.url();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page.locator(".activity-card.has-activity").waitFor();
    await mkdir("artifacts/frontend", { recursive: true });
    await page.screenshot({
      path: "artifacts/frontend/dashboard-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Start collection", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Start collection", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("link", { name: /Open existing run/ })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(page.url(), runUrl);
    await page
      .getByRole("link", { name: "Collected jobs", exact: true })
      .click();
    await page
      .getByRole("link", { name: /Senior Data Engineer/ })
      .first()
      .click();
    await page.getByRole("heading", { name: "Senior Data Engineer" }).waitFor();
    assert.equal(await page.evaluate(() => window.compromised), undefined);
    assert.equal(await page.locator("img").count(), 0);
    assert.equal(
      await page.getByRole("link", { name: "Original posting" }).count(),
      0,
    );
    await page
      .getByRole("tab", { name: "Qualifications", exact: true })
      .click();
    await page.getByText("SQL experience", { exact: true }).waitFor();
    await page
      .getByRole("tab", { name: "Qualifications", exact: true })
      .press("End");
    assert.equal(
      await page
        .getByRole("tab", { name: "Source & metadata" })
        .getAttribute("aria-selected"),
      "true",
    );
    await page.getByText("Raw source data", { exact: true }).click();
    await page.getByText(/Source data preserved/).waitFor();
    assert.equal(
      await page.getByText("must-not-appear", { exact: false }).count(),
      0,
    );
    await page.reload();
    await page.getByRole("heading", { name: "Senior Data Engineer" }).waitFor();
    await page.goto(runUrl);
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Stopped" })
      .waitFor();
    await page.getByRole("log").getByText("stopped", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry run", exact: true }).click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Running" })
      .waitFor();
    assert.notEqual(page.url(), runUrl);
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Stopped" })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page
      .getByRole("heading", { name: "Your collection, in motion." })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
    );
    await page.screenshot({
      path: "artifacts/frontend/dashboard-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      JSON.stringify(
        await page.evaluate(() =>
          [...document.querySelectorAll("body *")]
            .map((element) => ({
              class: element.className?.toString(),
              x: element.getBoundingClientRect().x,
              right: element.getBoundingClientRect().right,
              width: element.getBoundingClientRect().width,
            }))
            .filter((box) => box.right > innerWidth + 1 && box.width > 0),
        ),
      ),
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("browser UI: queued cancellation, busy credentials, worker crash and expired-session recovery", async () => {
  const f = await browserFixture();
  try {
    const secondary = await f.addConnection(
      f.users.alice,
      "queued@provider.test",
      "crash",
    );
    await f.login();
    const { page } = f;
    async function start(profileId) {
      await page
        .getByRole("button", { name: "Start collection", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Profile", { exact: true })
        .selectOption(profileId);
      await dialog
        .getByRole("button", { name: "Start collection", exact: true })
        .click();
    }
    await start(f.aliceProfile.id);
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Running" })
      .waitFor();
    const holdingRun = page.url();
    await page.getByRole("link", { name: "Profiles", exact: true }).click();
    const busy = page
      .locator(".profile-card")
      .filter({ hasText: "alice@provider.test" });
    assert.equal(
      await busy
        .getByRole("button", { name: /Update credentials/ })
        .isDisabled(),
      true,
    );
    assert.equal(
      await busy.getByRole("link", { name: "View run" }).getAttribute("href"),
      new URL(holdingRun).pathname,
    );
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await start(secondary.id);
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Queued" })
      .waitFor();
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Stopped" })
      .waitFor();
    await page.getByRole("button", { name: "Retry run", exact: true }).click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Queued" })
      .waitFor();
    const queuedRun = page.url();
    await page.goto(holdingRun);
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Stopped" })
      .waitFor();
    await page.goto(queuedRun);
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Interrupted" })
      .waitFor();
    await page
      .getByText("Worker exited unexpectedly.", { exact: true })
      .waitFor();
    await page.context().clearCookies();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByText(/Your session expired/).waitFor();
    await page
      .getByLabel("Email address", { exact: true })
      .fill("alice@fixture.test");
    await page.getByLabel("Password", { exact: true }).fill(backendPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Interrupted" })
      .waitFor();
    assert.equal(page.url(), queuedRun);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("browser UI: profiles, authentication, credentials, logout and user isolation", async () => {
  const f = await browserFixture();
  try {
    await f.login();
    const { page } = f;
    await page.getByRole("link", { name: "Profiles", exact: true }).click();
    await page
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Account email").fill("second@provider.test");
    await dialog
      .getByLabel("Job-site password", { exact: true })
      .fill("complete");
    await dialog
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    const card = page
      .locator(".profile-card")
      .filter({ hasText: "second@provider.test" });
    await card.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sign in to job site" })
      .click();
    await page
      .locator(".run-status-bar .status")
      .filter({ hasText: "Completed" })
      .waitFor();
    await page.getByRole("link", { name: "Profiles", exact: true }).click();
    await card.getByText("Connected", { exact: true }).waitFor();
    await card.getByRole("button", { name: /Update credentials/ }).click();
    assert.equal(
      await dialog.getByLabel("New job-site password").inputValue(),
      "",
    );
    assert.equal(
      await dialog.getByLabel("Account email").getAttribute("readonly"),
      "",
    );
    await dialog.getByLabel("New job-site password").fill("replacement");
    await dialog
      .getByRole("button", { name: "Update credentials", exact: true })
      .click();
    await card.getByText("Sign-in needed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page
      .getByRole("heading", { name: "Sign in to your workspace" })
      .waitFor();
    await page
      .getByLabel("Email address", { exact: true })
      .fill("bob@fixture.test");
    await page.getByLabel("Password", { exact: true }).fill(backendPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("link", { name: "Collected jobs", exact: true })
      .click();
    await page
      .getByRole("link", { name: /Bob-only opportunity/ })
      .first()
      .waitFor();
    assert.equal(
      await page.getByText("Senior Data Engineer", { exact: true }).count(),
      0,
    );
    await page.goto(`${f.address}/jobs/${f.jobId}`);
    await page.getByRole("heading", { name: "Job unavailable" }).waitFor();
    await page.goto(`${f.address}/users`);
    await page
      .getByRole("heading", { name: "Administrator access required" })
      .waitFor();
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("browser UI: administrator can create users without seeing other users’ jobs", async () => {
  const f = await browserFixture();
  try {
    await f.login("admin");
    const { page } = f;
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page
      .getByRole("button", { name: "Create user", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email address").fill("newmember@fixture.test");
    await dialog.getByLabel("Initial password").fill(backendPassword);
    await dialog
      .getByRole("button", { name: "Create user", exact: true })
      .click();
    await page.getByRole("cell", { name: "newmember@fixture.test" }).waitFor();
    await page
      .getByRole("link", { name: "Collected jobs", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Your job library starts here" })
      .waitFor();
    assert.equal(
      await page.getByText("Senior Data Engineer", { exact: true }).count(),
      0,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
