import test from "node:test";
import assert from "node:assert/strict";
import { request } from "playwright";
import api from "../plugins/jobright/api.js";
import { Store } from "../src/storage/database.js";
import { runJobs } from "../src/core/runner.js";
import { UncertainWriteError, UnsupportedError } from "../src/core/errors.js";
import { fixtureJob, startFixtureServer } from "./helpers/fixture-server.js";

const listPath = "/swan/recommend/list/jobs";
const markPath = "/swan/job/apply";
const verifyPath = "/swan/job/applied/jobs-v3";

async function fixture(count = 25) {
  const ids = Array.from({ length: count }, (_, index) => `job${index}`);
  const server = await startFixtureServer({ ids });
  const http = await request.newContext({
    extraHTTPHeaders: { cookie: "fixture-session=valid" },
  });
  const store = new Store(":memory:");
  const controller = new AbortController();
  const context = {
    http,
    config: { baseUrl: server.baseUrl },
    signal: controller.signal,
  };
  const plugin = { ...api, authenticate: async () => {} };
  const options = {
    plugin,
    context,
    store,
    site: "fixture",
    account: "account",
    transport: "api",
    signal: controller.signal,
    limit: count,
    intervalMs: 0,
    pollMs: 1,
  };
  return {
    ids,
    server,
    store,
    controller,
    context,
    plugin,
    options,
    requests: (path) => server.requests.filter((entry) => entry.path === path),
    run: () =>
      store.db.prepare("SELECT * FROM runs ORDER BY rowid DESC LIMIT 1").get(),
    async close() {
      store.close();
      await http.dispose();
      await server.close();
    },
  };
}

test("API consumes full pages sequentially: 45 saved and verified jobs use three recommendation requests", async () => {
  const f = await fixture(45);
  f.plugin.markAsApplied = async (context, job) => {
    assert.equal(
      f.store.state("fixture", "account", job.id).state,
      "mark_pending",
    );
    assert.ok(
      f.store.jobs("fixture").some((saved) => saved.source_job_id === job.id),
    );
    await api.markAsApplied(context, job);
  };
  try {
    const result = await runJobs(f.options);
    assert.deepEqual(result, { saved: 45, confirmed: 45, failed: 0 });
    assert.deepEqual(
      f.requests(listPath).map((entry) => entry.query.position),
      ["0", "0", "0"],
    );
    const marksBeforeListing = [];
    let marked = 0;
    for (const entry of f.server.requests) {
      if (entry.path === listPath) marksBeforeListing.push(marked);
      if (entry.path === markPath) marked++;
    }
    assert.deepEqual(marksBeforeListing, [0, 20, 40]);
    assert.deepEqual(
      f.requests(markPath).map((entry) => entry.body.jobId),
      f.ids,
    );
    assert.equal(f.requests(verifyPath).length, 45);
    assert.ok(
      f.server.requests.every((entry) => entry.path.startsWith("/swan/")),
    );
    assert.deepEqual(
      f.store.jobs("fixture").map((job) => job.source_job_id),
      f.ids,
    );
    for (const job of f.store.jobs("fixture")) {
      assert.equal(job.raw.jobResult.jobId, job.source_job_id);
      assert.equal(
        f.store.state("fixture", "account", job.source_job_id).state,
        "mark_confirmed",
      );
    }
  } finally {
    await f.close();
  }
});

test("read-only API batches advance past unchanged recommendations without repeating saved jobs", async () => {
  const f = await fixture();
  const extracted = [];
  f.plugin.getJobDetails = async (context, job) => {
    extracted.push(job.id);
    return api.getJobDetails(context, job);
  };
  try {
    const result = await runJobs({ ...f.options, readOnly: true });
    assert.deepEqual(result, { saved: 25, confirmed: 0, failed: 0 });
    assert.deepEqual(extracted, f.ids);
    // The existing exclusion-aware listing scans past the unchanged first page.
    assert.deepEqual(
      f.requests(listPath).map((entry) => entry.query.position),
      ["0", "0", "20"],
    );
    assert.equal(f.requests(markPath).length, 0);
    assert.equal(f.requests(verifyPath).length, 0);
    assert.equal(f.store.jobs("fixture").length, 25);
  } finally {
    await f.close();
  }
});

test("a finite API limit stops inside a page without saving or marking the remaining jobs", async () => {
  const f = await fixture();
  try {
    const result = await runJobs({ ...f.options, limit: 7 });
    assert.equal(result.saved, 7);
    assert.equal(f.requests(listPath).length, 1);
    assert.deepEqual(
      f.requests(markPath).map((entry) => entry.body.jobId),
      f.ids.slice(0, 7),
    );
    assert.equal(f.store.jobs("fixture").length, 7);
    assert.equal(f.run().status, "completed");
  } finally {
    await f.close();
  }
});

test("Stop during an API tracking update reconciles that job and discards the rest of the page", async () => {
  const f = await fixture();
  f.plugin.markAsApplied = async (context, job) => {
    await api.markAsApplied(context, job);
    f.controller.abort();
  };
  try {
    assert.deepEqual(await runJobs(f.options), {
      saved: 1,
      confirmed: 1,
      failed: 0,
    });
    assert.equal(f.requests(listPath).length, 1);
    assert.equal(f.requests(markPath).length, 1);
    assert.equal(f.requests(verifyPath).length, 1);
    assert.equal(f.store.jobs("fixture").length, 1);
    assert.equal(f.run().status, "stopped");
  } finally {
    await f.close();
  }
});

test("Stop immediately after saving an API job prevents its update and further cached extraction", async () => {
  const f = await fixture();
  try {
    const result = await runJobs({
      ...f.options,
      onProgress: (progress) => {
        if (progress.event === "job_saved") f.controller.abort();
      },
    });
    assert.equal(result.saved, 1);
    assert.equal(f.store.jobs("fixture").length, 1);
    assert.equal(f.requests(markPath).length, 0);
    assert.equal(f.run().status, "stopped");
  } finally {
    await f.close();
  }
});

test("API pages recheck confirmed state and skip duplicate source IDs before extracting", async () => {
  const f = await fixture(4);
  f.plugin.listJobs = async (context, options) => {
    const jobs = await api.listJobs(context, options);
    return [jobs[0], ...jobs];
  };
  f.plugin.getApplicationStatus = async (context, job) => {
    const result = await api.getApplicationStatus(context, job);
    if (job.id === "job0") {
      const other = await api.getJobDetails(context, {
        id: "job1",
        raw: fixtureJob("job1"),
      });
      const id = f.store.saveJob("fixture", "account", other);
      f.store.transition(id, "account", "mark_confirmed", "applied");
    }
    return result;
  };
  try {
    const result = await runJobs({ ...f.options, limit: 3 });
    assert.equal(result.confirmed, 3);
    assert.equal(f.requests(listPath).length, 1);
    assert.deepEqual(
      f.requests(markPath).map((entry) => entry.body.jobId),
      ["job0", "job2", "job3"],
    );
  } finally {
    await f.close();
  }
});

test("an API page that becomes fully confirmed is refreshed before entering empty-list polling", async () => {
  const f = await fixture(4);
  let listings = 0;
  const events = [];
  f.plugin.listJobs = async (context, options) => {
    const jobs = await api.listJobs(context, options);
    return ++listings === 1 ? jobs.slice(0, 3) : jobs;
  };
  f.plugin.getApplicationStatus = async (context, job) => {
    const result = await api.getApplicationStatus(context, job);
    if (job.id === "job0") {
      for (const id of ["job1", "job2"]) {
        const other = await api.getJobDetails(context, {
          id,
          raw: fixtureJob(id),
        });
        f.store.transition(
          f.store.saveJob("fixture", "account", other),
          "account",
          "mark_confirmed",
          "applied",
        );
      }
    }
    return result;
  };
  try {
    const result = await runJobs({
      ...f.options,
      limit: 2,
      onProgress: (progress) => events.push(progress.event),
    });
    assert.equal(result.confirmed, 2);
    assert.equal(f.requests(listPath).length, 2);
    assert.deepEqual(
      f.requests(markPath).map((entry) => entry.body.jobId),
      ["job0", "job3"],
    );
    assert.ok(!events.includes("waiting_for_jobs"));
  } finally {
    await f.close();
  }
});

test("failed persistence skips one cached API job without marking it or discarding its neighbors", async () => {
  const f = await fixture(4);
  const save = f.store.saveJob.bind(f.store);
  f.store.saveJob = (site, account, job) => {
    if (job.id === "job1") throw new Error("fixture persistence failure");
    return save(site, account, job);
  };
  try {
    assert.deepEqual(await runJobs({ ...f.options, limit: 3 }), {
      saved: 3,
      confirmed: 3,
      failed: 1,
    });
    assert.equal(f.requests(listPath).length, 1);
    assert.deepEqual(
      f.requests(markPath).map((entry) => entry.body.jobId),
      ["job0", "job2", "job3"],
    );
    assert.equal(f.store.state("fixture", "account", "job1"), undefined);
  } finally {
    await f.close();
  }
});

test("an uncertain API write pauses the batch, and restart does not replay it or process later jobs", async () => {
  const f = await fixture();
  f.server.loseNextWriteResponse();
  f.plugin.getApplicationStatus = async () => "unknown";
  try {
    await assert.rejects(runJobs(f.options), UncertainWriteError);
    assert.equal(f.store.pending("fixture", "account").length, 1);
    assert.equal(f.store.jobs("fixture").length, 1);
    assert.equal(f.run().status, "attention_required");
    await assert.rejects(runJobs(f.options), UncertainWriteError);
    assert.equal(f.requests(markPath).length, 1);
    assert.equal(f.requests(listPath).length, 1);
    assert.equal(f.store.jobs("fixture").length, 1);
  } finally {
    await f.close();
  }
});

test("session expiry in a cached API batch stops before later jobs and preserves the uncertain update", async () => {
  const f = await fixture();
  f.plugin.getApplicationStatus = async (context, job) => {
    const result = await api.getApplicationStatus(context, job);
    if (job.id === "job0") f.server.expire();
    return result;
  };
  try {
    await assert.rejects(runJobs(f.options), UncertainWriteError);
    assert.equal(f.run().status, "attention_required");
    assert.equal(f.requests(listPath).length, 1);
    assert.deepEqual([...f.server.applied], ["job0"]);
    assert.deepEqual(
      f.store.jobs("fixture").map((job) => job.source_job_id),
      ["job0", "job1"],
    );
    assert.equal(f.store.pending("fixture", "account")[0].id, "job1");
    assert.equal(f.requests(markPath).length, 2);
  } finally {
    await f.close();
  }
});

test("a changed next-page response fails clearly after the previous API batch is committed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runJobs({
        ...f.options,
        onProgress: (progress) => {
          if (
            progress.event === "job_marked_applied" &&
            progress.counters.confirmed === 20
          )
            f.server.breakSchema(true);
        },
      }),
      UnsupportedError,
    );
    assert.equal(f.run().status, "failed");
    assert.equal(f.requests(listPath).length, 2);
    assert.equal(f.requests(markPath).length, 20);
    assert.equal(f.store.jobs("fixture").length, 20);
  } finally {
    await f.close();
  }
});

test("empty API recommendations poll after the page is consumed and remain cancellable", async () => {
  const f = await fixture(3);
  try {
    const result = await runJobs({
      ...f.options,
      limit: 4,
      onProgress: (progress) => {
        if (progress.event === "waiting_for_jobs") f.controller.abort();
      },
    });
    assert.equal(result.saved, 3);
    assert.equal(f.requests(listPath).length, 2);
    assert.equal(f.run().status, "stopped");
  } finally {
    await f.close();
  }
});
