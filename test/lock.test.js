import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../src/core/lock.js';

test('account lock rejects concurrent runners and releases ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-runner-lock-'));
  const path = join(directory, 'account.lock');
  try {
    const release = await acquireLock(path);
    await assert.rejects(acquireLock(path), /Another runner/);
    await release();
    await (await acquireLock(path))();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('stale lock is reclaimed after the former process exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-runner-stale-'));
  try {
    const path = join(directory, 'account.lock');
    await writeFile(path, JSON.stringify({ pid: 2147483647, token: 'old' }));
    await (await acquireLock(path))();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
