import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serviceFixture, backendPassword } from "./helpers/service-fixture.js";
import { ServiceStore } from "../src/storage/service-store.js";
import { accountKey } from "../src/core/security.js";
import { encryptCredentials } from "../src/service/crypto.js";

test("browser UI: blacklist companies, exclude linked jobs, synchronize and restore", async () => {
  const f = await browserFixture();
  try {
    const second = await f.addConnection(
      f.users.alice,
      "blacklist-second@provider.test",
    );
    function save(profile, id, title, company) {
      const store = new ServiceStore(f.config.dbPath, {
        userId: f.users.alice.id,
        connectionId: profile.id,
      });
      try {
        store.saveJob("jobright", accountKey(profile.label), {
          id,
          title,
          company: company.companyName,
          url: `https://fixture.test/jobs/${id}`,
          details: {
            description: { text: "Complete fixture description" },
            company,
          },
        });
      } finally {
        store.close();
      }
    }
    const northstar = {
      companyName: "Northstar Labs",
      companyURL: "https://company.test",
    };
    save(second, "blocked-second", "Blacklisted Engineer", northstar);
    save(f.aliceProfile, "allowed", "Allowed Engineer", {
      companyName: "Allowed Labs",
      companyURL: "https://allowed.test",
    });
    await f.login();
    const { page } = f;
    async function openCompanies() {
      await page.getByRole("link", { name: "Companies", exact: true }).click();
      await page
        .getByRole("heading", { name: "Your company directory", exact:true })
        .waitFor();
    }
    async function sync() {
      await page
        .getByRole("button", { name: "Sync companies", exact: true })
        .click();
      await page
        .getByText(/Company directory is up to date for this sync/)
        .waitFor();
      await page
        .getByRole("button", { name: "Sync companies", exact: true })
        .waitFor();
    }
    await openCompanies();
    await sync();
    await page
      .getByRole("button", {
        name: "Blacklist company Northstar Labs",
        exact: true,
      })
      .click();
    const restore = page.getByRole("button", {
      name: "Remove Northstar Labs from blacklist",
      exact: true,
    });
    await restore.waitFor();
    await page.getByText("Blacklisted", { exact: true }).waitFor();
    await mkdir(resolve("artifacts/frontend"), { recursive: true });
    await page.screenshot({
      path: resolve("artifacts/frontend/company-blacklist-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("link", { name: "View Northstar Labs", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Northstar Labs", exact: true })
      .waitFor();
    await page.getByText("Blacklisted", { exact: true }).waitFor();
    assert.equal(await page.locator("tbody tr").count(), 2);
    save(f.aliceProfile, "unsynced", "Unsynced Engineer", northstar);
    await page
      .getByRole("link", { name: "Collected jobs", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 4,
    );
    await page.getByRole("button", { name: /^Filters/ }).click();
    const checkbox = page.getByLabel("Exclude blacklisted companies");
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(
      new URL(page.url()).searchParams.has("excludeBlacklistedCompanies"),
      false,
    );
    await page.getByRole("button", { name: /^Filters/ }).click();
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 2,
    );
    assert.equal(
      new URL(page.url()).searchParams.get("excludeBlacklistedCompanies"),
      "true",
    );
    assert.equal(
      await page
        .getByRole("link", { name: "View Senior Data Engineer", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("link", { name: "View Blacklisted Engineer", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("link", { name: "View Unsynced Engineer", exact: true })
      .waitFor();
    const filteredUrl = page.url();
    await page.reload();
    await page
      .getByRole("button", { name: "Remove Blacklist filter" })
      .waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 2,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /^Filters/ }).click();
    assert.equal(await checkbox.isChecked(), true);
    await checkbox.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve("artifacts/frontend/company-blacklist-filter-mobile.png"),
      animations: "disabled",
    });
    assert.equal(
      Math.round((await page.getByRole("dialog").boundingBox()).width),
      390,
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await openCompanies();
    await sync();
    await restore.waitFor();
    await page.goto(filteredUrl);
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 1,
    );
    await page
      .getByRole("link", { name: "View Allowed Engineer", exact: true })
      .waitFor();
    await openCompanies();
    await restore.click();
    await page
      .getByRole("button", {
        name: "Blacklist company Northstar Labs",
        exact: true,
      })
      .waitFor();
    await page.goto(filteredUrl);
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 4,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

async function browserFixture({ timezoneId } = {}) {
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
  await f.app.companySyncs.start();
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    ...(timezoneId ? { timezoneId } : {}),
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

test("browser UI: manual company sync, detailed directory, profiles, pagination and privacy", async () => {
  const f = await browserFixture();
  try {
    const profile = await f.addConnection(
      f.users.alice,
      "second@provider.test",
    );
    const store = new ServiceStore(f.config.dbPath, {
      userId: f.users.alice.id,
      connectionId: profile.id,
    });
    try {
      for (let i = 0; i < 22; i++) {
        const id = store.saveJob("jobright", accountKey(profile.label), {
          id: `company-role-${i}`,
          title: `Company Role ${i}`,
          url: `https://fixture.test/jobs/${i}`,
          company: "Northstar Labs",
          details: {
            description: { text: "Job description." },
            company: {
              companyId: "northstar",
              companyName: "Northstar Labs",
              companyURL: "https://company.test",
              companyDesc:
                'Company details from stored metadata.\n<img src=x onerror="window.compromised=true">',
              companyIndustry: "Software",
              companySize: "100",
              links: [{ text: "Unsafe link", url: "javascript:alert(1)" }],
            },
          },
        });
        if (i === 21) {
          store.transition(
            id,
            accountKey(profile.label),
            "mark_confirmed",
            "applied",
          );
          store.assignJobs(f.users.alice.id, { connectionId: profile.id });
        }
      }
    } finally {
      store.close();
    }
    await f.login();
    const { page } = f;
    await page.getByRole("link", { name: "Companies", exact: true }).click();
    await page
      .getByRole("heading", { name: "Your company directory starts here" })
      .waitFor();
    await page
      .getByRole("button", { name: "Sync companies", exact: true })
      .click();
    await page.getByText("23 / 23 jobs processed", { exact: true }).waitFor();
    await page
      .getByRole("link", { name: /Northstar Labs/ })
      .first()
      .waitFor();
    await page.reload();
    await page.getByText("23 / 23 jobs processed", { exact: true }).waitFor();
    await page.screenshot({
      path: "artifacts/frontend/companies-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("link", { name: /Northstar Labs/ })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "Northstar Labs", exact: true })
      .waitFor();
    assert.equal(await page.locator("img").count(), 0);
    assert.equal(
      await page.getByRole("link", { name: "Unsafe link" }).count(),
      0,
    );
    const role = page.getByRole("row").filter({ hasText: "Company Role 21" });
    await role.getByText("Assigned", { exact: true }).waitFor();
    await role.getByText("Marked applied", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page
      .getByRole("link", { name: "Senior Data Engineer", exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: "Senior Data Engineer", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Senior Data Engineer", exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: "← Company jobs", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Northstar Labs", exact: true })
      .waitFor();
    assert.ok(new URL(page.url()).searchParams.has("cursor"));
    await page
      .getByRole("combobox", { name: "Profile", exact: true })
      .selectOption(f.aliceProfile.id);
    await page
      .getByRole("link", { name: "Senior Data Engineer", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("link", { name: /Company Role/ }).count(),
      0,
    );
    const companyUrl = page.url();
    await page.reload();
    await page
      .getByRole("heading", { name: "Northstar Labs", exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
    );
    await page.screenshot({
      path: "artifacts/frontend/company-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.getByRole("button", { name: "Open navigation" }).click();
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
      .getByRole("heading", { name: "Your collection, in motion." })
      .waitFor();
    await page.goto(companyUrl);
    await page.getByRole("heading", { name: "Company unavailable" }).waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Northstar Labs", exact: true })
        .count(),
      0,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("browser UI: filters persist, CSV and Sheets cover every page, and assignment persists", async () => {
  const f = await browserFixture({ timezoneId: "America/New_York" });
  try {
    const account = accountKey(f.aliceProfile.label);
    const store = new ServiceStore(f.config.dbPath, {
      userId: f.users.alice.id,
      connectionId: f.aliceProfile.id,
    });
    try {
      for (let index = 0; index < 23; index++) {
        const id = store.saveJob("jobright", account, {
          id: `export-${index}`,
          title: `Export Engineer ${index}`,
          company: "Export Company",
          url: `https://example.test/job/${index}`,
          details: {
            description: { text: "Export data." },
            applicationUrl: `https://employer.test/apply/${index}`,
            postedAt:
              index === 22 ? "2026-11-05 12:00:00" : "2026-11-06 23:30:00",
            matching: {
              score: 84.4677,
              recommendations: [
                { featureName: "q_job_skill_match", score: 0.8 },
                { featureName: "q_industry_match", score: 0.7 },
              ],
            },
          },
        });
        store.db
          .prepare(
            "UPDATE jobs SET first_seen_at=?,last_scraped_at=? WHERE id=?",
          )
          .run(
            index === 22
              ? "2026-11-07T12:00:00.000Z"
              : "2026-11-08T12:00:00.000Z",
            "2026-12-01T00:00:00.000Z",
            id,
          );
      }
    } finally {
      store.close();
    }
    await f.login();
    const { page } = f;
    await page
      .getByRole("link", { name: "Collected jobs", exact: true })
      .click();
    await page
      .getByRole("searchbox", { name: "Search jobs" })
      .fill("Export Engineer");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const filterButton = page.getByRole("button", { name: /^Filters/ });
    const beforeFilters = page.url();
    await filterButton.click();
    await page
      .getByLabel("Company name", { exact: true })
      .fill("Unapplied draft");
    assert.equal(page.url(), beforeFilters);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      await filterButton.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await filterButton.click();
    assert.equal(
      await page.getByLabel("Company name", { exact: true }).inputValue(),
      "",
    );
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page
        .getByRole("button", { name: "Apply filters" })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page
      .getByLabel("Company name", { exact: true })
      .fill("export company");
    await page.getByLabel("Posted from", { exact: true }).fill("2026-11-06");
    await page.getByLabel("Posted to", { exact: true }).fill("2026-11-06");
    await page
      .getByLabel("Registered from", { exact: true })
      .fill("2026-11-08");
    await page.getByLabel("Registered to", { exact: true }).fill("2026-11-08");
    await page.getByLabel("Total match minimum").fill("84");
    await page.getByLabel("Total match maximum").fill("85");
    await page.getByLabel("Skill match minimum").fill("80");
    await page.getByLabel("Skill match maximum").fill("80");
    await page.getByLabel("Industry match minimum").fill("70");
    await page.getByLabel("Industry match maximum").fill("70");
    await page
      .getByLabel("Profile", { exact: true })
      .selectOption(f.aliceProfile.id);
    await mkdir("artifacts/frontend", { recursive: true });
    await page.screenshot({
      path: "artifacts/frontend/jobs-filter-drawer-desktop.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForFunction(
      () =>
        new URL(location.href).searchParams.get("registeredFrom") ===
        "2026-11-08T05:00:00.000Z",
    );
    assert.equal(
      new URL(page.url()).searchParams.get("registeredTo"),
      "2026-11-09T04:59:59.999Z",
    );
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 2,
    );
    const downloadReady = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download CSV", exact: true })
      .click();
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), "gather-jobs.csv");
    const csv = await readFile(await download.path(), "utf8");
    assert.equal(csv.trim().split("\r\n").length, 23);
    assert.ok(csv.includes('"Export Engineer 0"'));
    assert.ok(csv.includes('"Export Engineer 21"'));
    assert.ok(!csv.includes('"Export Engineer 22"'));
    assert.ok(!csv.includes("Senior Data Engineer"));
    assert.ok(!csv.includes("Bob-only opportunity"));
    assert.ok(csv.includes("Export data."));
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedJobs = text;
          },
        },
      });
    });
    await page
      .getByRole("button", { name: "Copy Available Jobs", exact: true })
      .click();
    await page
      .getByText("22 jobs copied. Paste into Google Sheets with Ctrl+V.", {
        exact: true,
      })
      .waitFor();
    const copied = await page.evaluate(() => window.copiedJobs);
    const sheet = copied
      .trimEnd()
      .split("\n")
      .map((row) => row.split("\t"));
    assert.deepEqual(sheet[0], ["Company Name", "Job Title", "Link"]);
    assert.equal(sheet.length, 23);
    assert.ok(
      sheet
        .slice(1)
        .every(
          (row) =>
            row.length === 3 &&
            row[0] === "Export Company" &&
            row[2].startsWith("https://employer.test/apply/"),
        ),
    );
    await page
      .getByRole("button", { name: "Assign all Jobs", exact: true })
      .click();
    await page.getByText("22 jobs assigned.", { exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody .status-assigned").length === 20,
    );
    assert.equal(new URL(page.url()).searchParams.has("cursor"), false);
    await page
      .getByRole("button", { name: "Copy Available Jobs", exact: true })
      .click();
    await page
      .getByText("22 jobs copied. Paste into Google Sheets with Ctrl+V.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await page.evaluate(() => window.copiedJobs), copied);
    await filterButton.click();
    await page
      .getByRole("combobox", { name: "Tracking status" })
      .selectOption("assigned");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForFunction(
      () => new URL(location.href).searchParams.get("status") === "assigned",
    );
    await page.reload();
    await page
      .getByRole("heading", { name: "Collected opportunities" })
      .waitFor();
    await page
      .getByRole("button", { name: "Remove Registered filter" })
      .waitFor();
    await filterButton.click();
    assert.equal(
      await page.getByLabel("Registered from", { exact: true }).inputValue(),
      "2026-11-08",
    );
    assert.equal(
      await page.getByLabel("Skill match minimum").inputValue(),
      "80",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody .status-assigned").length === 20,
    );
    await mkdir("artifacts/frontend", { recursive: true });
    await page.screenshot({
      path: "artifacts/frontend/jobs-filters-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: "artifacts/frontend/jobs-filters-mobile.png",
      fullPage: true,
    });
    await filterButton.click();
    await page.screenshot({
      path: "artifacts/frontend/jobs-filter-drawer-mobile.png",
      animations: "disabled",
    });
    assert.ok(
      await page.getByRole("button", { name: "Apply filters" }).isVisible(),
    );
    const drawerBox = await page.getByRole("dialog").boundingBox();
    assert.equal(Math.round(drawerBox.width), 390);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Remove Registered filter" })
      .click();
    await page.waitForFunction(
      () => !new URL(location.href).searchParams.has("registeredFrom"),
    );
    const url = new URL(page.url());
    assert.equal(url.searchParams.get("q"), "Export Engineer");
    assert.equal(url.searchParams.has("cursor"), false);
    await filterButton.click();
    assert.equal(
      await page.getByLabel("Registered from", { exact: true }).inputValue(),
      "",
    );
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForFunction(
      () => !new URL(location.href).searchParams.has("company"),
    );
    assert.equal(new URL(page.url()).searchParams.get("q"), "Export Engineer");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

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
test('browser UI: job and company sorting spans pages, restores URLs and supports keyboard/mobile use', async () => {
  const f = await browserFixture();
  const { page } = f;
  try {
    const store = new ServiceStore(f.config.dbPath, { connectionId: f.aliceProfile.id, userId: f.users.alice.id });
    const titles = Array.from({ length: 26 }, (_, i) => `Sort Role ${String(i).padStart(2, '0')}`);
    try {
      for (let i = 0; i < titles.length; i++) {
        store.saveJob('jobright', accountKey(f.aliceProfile.label), {
          id: `sort-${i}`, title: titles[i], company: `Sort Company ${String(i).padStart(2, '0')}`,
          url: 'https://example.test/job', details: { description: { text: 'Sorting fixture' },
            matching: { score: 26 - i }, company: { companyName: `Sort Company ${String(i).padStart(2, '0')}`, companyLocation: i % 2 ? 'Austin' : 'New York' } },
        });
      }
    } finally { store.close(); }
    async function rows(expected) {
      await page.waitForFunction(values => {
        const displayed = [...document.querySelectorAll('tbody .table-title > span:last-child')].map(node => node.firstChild.textContent.trim());
        return JSON.stringify(displayed) === JSON.stringify(values);
      }, expected);
    }
    await f.login();
    await page.goto(`${f.address}/jobs?q=Sort`);
    await page.getByRole('button', { name: 'Sort by Job', exact: true }).click();
    await rows(titles.slice(0, 20));
    assert.equal(new URL(page.url()).searchParams.get('sortOrder'), 'asc');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await rows(titles.slice(20));
    const secondPage = page.url();
    await page.getByRole('link', { name: `View ${titles[20]}`, exact: true }).click();
    await page.locator('.back-link').click();
    assert.equal(page.url(), secondPage);
    await rows(titles.slice(20));
    await page.reload();
    await rows(titles.slice(20));
    const total = page.getByRole('button', { name: 'Sort by Total match', exact: true });
    await total.focus();
    await page.keyboard.press('Enter');
    await rows([...titles].reverse().slice(0, 20));
    assert.equal(new URL(page.url()).searchParams.has('cursor'), false);
    assert.equal(new URL(page.url()).searchParams.has('stack'), false);
    assert.equal(await total.evaluate(element => element === document.activeElement), true);
    assert.equal(await total.locator('..').locator('..').getAttribute('aria-sort'), 'ascending');
    await page.keyboard.press('Enter');
    await rows(titles.slice(0, 20));
    await page.goBack();
    await rows([...titles].reverse().slice(0, 20));

    await page.goto(`${f.address}/companies?q=Sort`);
    await page.getByRole('button', { name: 'Sync companies', exact: true }).click();
    await page.getByText(/Company directory is up to date for this sync/).waitFor();
    const names = titles.map(title => title.replace('Role', 'Company'));
    await page.getByRole('button', { name: 'Sort by Company', exact: true }).click();
    await rows(names.slice(0, 20));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await rows(names.slice(20));
    const companiesPage = page.url();
    await page.getByRole('link', { name: `View ${names[20]}`, exact: true }).click();
    await page.locator('.back-link').click();
    assert.equal(page.url(), companiesPage);
    await rows(names.slice(20));
    await page.getByRole('button', { name: 'Sort by Company', exact: true }).click();
    await rows([...names].reverse().slice(0, 20));
    await page.reload();
    await rows([...names].reverse().slice(0, 20));
    await page.setViewportSize({ width: 390, height: 844 });
    const location = page.getByRole('button', { name: 'Sort by Location', exact: true });
    await location.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('th[aria-sort="ascending"] button[aria-pressed="true"]')?.textContent.includes('Location'));
    await mkdir(resolve('artifacts/frontend'), { recursive: true });
    await page.screenshot({ path: resolve('artifacts/frontend/company-sorting-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('browser UI: numbered jobs/company pagination shows totals, page sizes, jumps and empty results', async () => {
  const f = await browserFixture();
  const { page } = f;
  try {
    const store = new ServiceStore(f.config.dbPath, { connectionId: f.aliceProfile.id, userId: f.users.alice.id });
    try {
      for (let i = 0; i < 55; i++) {
        const name = `Page Company ${String(i % 25).padStart(2, '0')}`;
        store.saveJob('jobright', accountKey(f.aliceProfile.label), { id: `page-${i}`, title: `Page Role ${String(i).padStart(2, '0')}`, company: name, url: 'https://example.test/job', details: { description: { text: 'Pagination fixture' }, company: { companyName: name } } });
      }
    } finally { store.close(); }
    await f.login();
    await page.goto(`${f.address}/jobs?q=Page`);
    await page.getByText('Showing 1–20 of 55 jobs', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Rows per page' }).selectOption('10');
    await page.getByText('Page 1 of 6', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Page 6', exact: true }).click();
    await page.getByText('Showing 51–55 of 55 jobs', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('page'), '6');
    assert.equal(new URL(page.url()).searchParams.get('pageSize'), '10');
    assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
    const jobPage = page.url();
    await page.getByRole('link', { name: 'View Page Role 04', exact: true }).click();
    await page.locator('.back-link').click();
    assert.equal(page.url(), jobPage);
    await page.reload();
    await page.getByText('Showing 51–55 of 55 jobs', { exact: true }).waitFor();
    await page.getByRole('spinbutton', { name: 'Go to page' }).fill('3');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.getByText('Showing 21–30 of 55 jobs', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Page 3', exact: true }).getAttribute('aria-current'), 'page');
    await page.goBack();
    await page.getByText('Showing 51–55 of 55 jobs', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Rows per page' }).selectOption('50');
    await page.getByText('Showing 1–50 of 55 jobs', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.has('page'), false);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('Showing 51–55 of 55 jobs', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sort by Job', exact: true }).click();
    await page.getByText('Showing 1–50 of 55 jobs', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('q'), 'Page');
    await page.getByRole('combobox', { name: 'Rows per page' }).selectOption('10');
    await page.getByText('Showing 1–10 of 55 jobs', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('navigation', { name: 'Jobs pagination' }).scrollIntoViewIfNeeded();
    await mkdir(resolve('artifacts/frontend'), { recursive: true });
    await page.screenshot({ path: resolve('artifacts/frontend/jobs-pagination-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    await page.goto(`${f.address}/companies?q=Page`);
    await page.getByRole('button', { name: 'Sync companies', exact: true }).click();
    await page.getByText(/Company directory is up to date for this sync/).waitFor();
    await page.getByText('Showing 1–20 of 25 companies', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Page 2', exact: true }).click();
    await page.getByText('Showing 21–25 of 25 companies', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Rows per page' }).selectOption('10');
    await page.getByText('Showing 1–10 of 25 companies', { exact: true }).waitFor();
    await page.getByRole('spinbutton', { name: 'Go to page' }).fill('3');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.getByText('Showing 21–25 of 25 companies', { exact: true }).waitFor();
    const companyPage = page.url();
    await page.reload();
    await page.getByText('Showing 21–25 of 25 companies', { exact: true }).waitFor();
    assert.equal(page.url(), companyPage);
    await page.getByRole('searchbox', { name: 'Search companies', exact: true }).fill('not-found');
    await page.getByRole('button', { name: 'Search companies', exact: true }).click();
    await page.getByText('Showing 0–0 of 0 companies', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Previous', exact: true }).isDisabled(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
