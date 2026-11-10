import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  utimes,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockOwnershipError } from "../src/core/lock.js";
import { inspectProcess } from "../src/core/process-identity.js";

test("account lock rejects concurrent runners and releases ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-runner-lock-"));
  const path = join(directory, "account.lock");
  try {
    const release = await acquireLock(path);
    await assert.rejects(acquireLock(path), /Another runner/);
    await release();
    await (
      await acquireLock(path)
    )();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("stale lock is reclaimed after the former process exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-runner-stale-"));
  try {
    const path = join(directory, "account.lock");
    await writeFile(path, JSON.stringify({ pid: 2147483647, token: "old" }));
    await (
      await acquireLock(path)
    )();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const self = {
  state: "running",
  identity: "fixture:self",
  startedAt: "2026-01-01T00:00:00.000Z",
};
const inspector = (other) => async (pid) =>
  pid === process.pid ? self : other;
async function oldLock(content, fn) {
  const directory = await mkdtemp(join(tmpdir(), "job-lock-owner-")),
    path = join(directory, "account.lock");
  try {
    await writeFile(path, JSON.stringify(content));
    await fn(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("new locks persist native process identity and ignore unrelated replacement owners on release", async () => {
  const identity = await inspectProcess(process.pid);
  assert.equal(identity.state, "running");
  assert.ok(identity.identity);
  assert.ok(Number.isFinite(Date.parse(identity.startedAt)));
  const directory = await mkdtemp(join(tmpdir(), "job-lock-identity-")),
    path = join(directory, "account.lock");
  try {
    const release = await acquireLock(path),
      stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(stored.processIdentity, identity.identity);
    assert.equal(stored.pid, process.pid);
    await Promise.all([release(), release()]);
    const next = await acquireLock(path),
      replacement = await readFile(path, "utf8");
    await release();
    assert.equal(await readFile(path, "utf8"), replacement);
    await next();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reused PID identities are reclaimed even when the replacement process is still alive", async () => {
  await oldLock(
    { pid: 424242, token: "old", processIdentity: "fixture:old" },
    async (path) => {
      const release = await acquireLock(path, {
        inspect: inspector({
          state: "running",
          identity: "fixture:new",
          startedAt: "2026-02-01T00:00:00.000Z",
        }),
      });
      const current = JSON.parse(await readFile(path, "utf8"));
      assert.equal(current.processIdentity, self.identity);
      assert.notEqual(current.token, "old");
      await release();
      await assert.rejects(access(path));
      await assert.rejects(access(path + ".reclaim"));
    },
  );
});

test("legacy PID-only locks are reclaimed only when process birth proves PID reuse", async () => {
  await oldLock({ pid: 424242, token: "legacy" }, async (path) => {
    const date = new Date("2020-01-01T00:00:00Z");
    await utimes(path, date, date);
    const release = await acquireLock(path, {
      inspect: inspector({
        state: "running",
        identity: "replacement:system-service",
        startedAt: "2026-02-01T00:00:00Z",
      }),
    });
    await release();
  });
  await oldLock({ pid: 424242, token: "active-legacy" }, async (path) => {
    const before = await readFile(path, "utf8");
    await assert.rejects(
      acquireLock(path, {
        inspect: inspector({
          state: "running",
          identity: "fixture:active",
          startedAt: "2000-01-01T00:00:00Z",
        }),
      }),
      /Another runner/,
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("permission-denied or unverifiable owners remain locked with a readable error", async () => {
  await oldLock({ pid: 424242, token: "unknown" }, async (path) => {
    const before = await readFile(path, "utf8");
    await assert.rejects(
      acquireLock(path, { inspect: inspector({ state: "unknown" }) }),
      (error) =>
        error instanceof LockOwnershipError &&
        error.code === "LOCK_OWNER_UNVERIFIED" &&
        !error.message.includes("kill EPERM"),
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
  await oldLock(
    { pid: 424242, token: "active", processIdentity: "fixture:active" },
    async (path) => {
      await assert.rejects(
        acquireLock(path, {
          inspect: inspector({
            state: "running",
            identity: "fixture:active",
            startedAt: "2026-02-01T00:00:00Z",
          }),
        }),
        /Another runner/,
      );
    },
  );
});

test("concurrent stale-lock recovery produces one owner and never deletes its replacement lock", async () => {
  await oldLock({ pid: 424242, token: "dead" }, async (path) => {
    const inspect = inspector({ state: "exited" });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireLock(path, { inspect })),
    );
    const acquired = results.filter((result) => result.status === "fulfilled");
    assert.equal(acquired.length, 1);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).processIdentity,
      self.identity,
    );
    await acquired[0].value();
    await assert.rejects(access(path));
    await assert.rejects(access(path + ".reclaim"));
  });
});

test("abandoned recovery guards and malformed lock owners are preserved for inspection", async () => {
  await oldLock({ pid: 424242, token: "dead" }, async (path) => {
    await writeFile(
      path + ".reclaim",
      JSON.stringify({ pid: 424243, token: "abandoned" }),
    );
    await assert.rejects(
      acquireLock(path, { inspect: inspector({ state: "exited" }) }),
      (error) => error.code === "LOCK_RECOVERY_REQUIRED",
    );
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, "dead");
  });
  await oldLock({ pid: 0, token: "invalid" }, async (path) => {
    await assert.rejects(
      acquireLock(path, { inspect: inspector({ state: "exited" }) }),
      LockOwnershipError,
    );
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, 0);
  });
});
