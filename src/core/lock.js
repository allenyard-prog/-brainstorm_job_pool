import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { inspectProcess, inspectSelf } from "./process-identity.js";

export class LockOwnershipError extends Error {
  constructor(message, code = "LOCK_OWNER_UNVERIFIED") {
    super(message);
    this.code = code;
  }
}
const busy = () =>
  new Error("Another runner already holds or is recovering the account lock.");

async function snapshot(path) {
  let file;
  try {
    file = await open(path, "r");
    const text = await file.readFile("utf8"),
      stat = await file.stat();
    const owner = JSON.parse(text);
    if (
      !owner ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== "string" ||
      !owner.token ||
      (Object.hasOwn(owner, "processIdentity") &&
        (typeof owner.processIdentity !== "string" || !owner.processIdentity))
    )
      throw new Error("Invalid lock owner.");
    return { owner, text, stat };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new LockOwnershipError(
      "Another runner is initializing or the account lock cannot be verified. The lock was preserved.",
    );
  } finally {
    await file?.close();
  }
}
function same(left, right) {
  return (
    !!left &&
    !!right &&
    left.text === right.text &&
    left.stat.ino === right.stat.ino &&
    left.stat.dev === right.stat.dev
  );
}
async function releaseOwned(path, token) {
  const current = await snapshot(path);
  if (current?.owner.token === token) {
    try {
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
function releaseFor(path, token) {
  let pending;
  return () => (pending ??= releaseOwned(path, token));
}

function ownerState(previous, current) {
  if (current.state === "exited") return "stale";
  if (current.state !== "running" || !current.identity) return "unknown";
  if (previous.owner.processIdentity)
    return previous.owner.processIdentity === current.identity
      ? "active"
      : "stale";
  // Legacy locks have only a PID. A process born after the lock was written
  // cannot be its owner. A margin protects coarse filesystem/OS timestamps.
  const started = Date.parse(current.startedAt);
  if (Number.isFinite(started) && started > previous.stat.mtimeMs + 1000)
    return "stale";
  return "active";
}

async function createLock(path, owner) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(owner));
  } finally {
    await file.close();
  }
}

export async function acquireLock(path, { inspect = inspectProcess } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const identity =
    inspect === inspectProcess
      ? await inspectSelf()
      : await inspect(process.pid);
  if (identity.state !== "running" || !identity.identity)
    throw new LockOwnershipError(
      "Unable to verify this runner’s process identity. No lock was acquired.",
    );
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
    processIdentity: identity.identity,
    processStartedAt: identity.startedAt ?? null,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await createLock(path, owner);
      return releaseFor(path, owner.token);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const previous = await snapshot(path);
    if (!previous) continue;
    const state = ownerState(previous, await inspect(previous.owner.pid));
    if (state === "active") throw busy();
    if (state === "unknown")
      throw new LockOwnershipError(
        "Cannot verify the existing runner lock owner. The lock was preserved to prevent overlapping runs; inspect the lock owner before retrying.",
      );

    // Serialize stale removals. Without this guard, two reclaimers can both
    // inspect the old owner and the second can delete the first's new lock.
    const guardPath = path + ".reclaim",
      guard = { ...owner, token: randomUUID() };
    try {
      await createLock(guardPath, guard);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await snapshot(guardPath);
      if (
        existing &&
        ownerState(existing, await inspect(existing.owner.pid)) === "stale"
      )
        throw new LockOwnershipError(
          "A previous lock-recovery process exited. Its recovery guard was preserved; inspect it before retrying.",
          "LOCK_RECOVERY_REQUIRED",
        );
      throw busy();
    }
    try {
      const current = await snapshot(path);
      if (!same(previous, current)) continue;
      try {
        await unlink(path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      try {
        await createLock(path, owner);
        return releaseFor(path, owner.token);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      await releaseOwned(guardPath, guard.token);
    }
  }
  throw busy();
}
