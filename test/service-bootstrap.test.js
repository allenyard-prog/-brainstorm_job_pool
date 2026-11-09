import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ServiceStore } from '../src/storage/service-store.js';
import { verifyPassword } from '../src/service/crypto.js';
import { serviceFixture } from './helpers/service-fixture.js';

test('bootstrap creates one admin and a persistent encryption key without printing secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-service-bootstrap-'));
  let store;
  try {
    const password = 'Bootstrap-fixture-password!';
    const script = fileURLToPath(new URL('../scripts/bootstrap-service.mjs', import.meta.url));
    const options = { cwd: directory, env: { ...process.env, DATA_DIR: join(directory, 'data'), SERVICE_ENCRYPTION_KEY: '', SERVICE_ADMIN_PASSWORD: password }, windowsHide: true };
    const result = await promisify(execFile)(process.execPath, [script, '--email', 'bootstrap@fixture.test'], options);
    assert.ok(!result.stdout.includes(password));
    const configuration = await readFile(join(directory, '.env'), 'utf8');
    assert.match(configuration, /SERVICE_ENCRYPTION_KEY=[a-f0-9]{64}/);
    store = new ServiceStore(join(directory, 'data', 'jobs.sqlite'));
    assert.equal(await verifyPassword(password, store.findUser('bootstrap@fixture.test').password_hash), true);
    const key = configuration.match(/SERVICE_ENCRYPTION_KEY=([a-f0-9]+)/)[1];
    await assert.rejects(promisify(execFile)(process.execPath, [script, '--email', 'other@fixture.test'], { ...options, env: { ...options.env, SERVICE_ENCRYPTION_KEY: key } }));
    assert.equal(store.listUsers().length, 1);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
test('health stays responsive and readiness reports failure after a database worker crash', async () => {
  const f = await serviceFixture();
  try {
    await f.app.db.worker.terminate();
    assert.equal((await f.request('GET', '/health')).statusCode, 200);
    assert.equal((await f.request('GET', '/ready')).statusCode, 503);
  } finally { await f.close(); }
});
