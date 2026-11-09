import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture, waitForRun } from './helpers/service-fixture.js';
import { buildService } from '../src/service/app.js';
import { acquireLock } from '../src/core/lock.js';
import { join } from 'node:path';
import { ServiceStore } from '../src/storage/service-store.js';

test('queue limits, fast API responses, queued stop, active stop and linked retry', async () => {
  const f = await serviceFixture({ supervise: true });
  try {
    const alice = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('admin');
    const a = await f.connect(alice, 'hold', 'a@provider.test');
    const b = await f.connect(alice, 'hold', 'b@provider.test');
    const c = await f.connect(bob, 'hold', 'c@provider.test');
    const start = async (connection, cookie) => {
      const response = await f.request('POST', '/api/v1/runs', { connectionId: connection.id }, cookie);
      assert.equal(response.statusCode, 202); return response.json();
    };
    const first = await start(a, alice); await waitForRun(f, alice, first.id, ['running']);
    const second = await start(c, bob); await waitForRun(f, bob, second.id, ['running']);
    const d = await f.connect(admin, 'hold', 'admin@provider.test');
    const globallyQueued = await start(d, admin);
    assert.equal((await f.request('GET', `/api/v1/runs/${globallyQueued.id}`, undefined, admin)).json().status, 'queued');
    await f.request('POST', `/api/v1/runs/${globallyQueued.id}/stop`, undefined, admin);
    const queued = await start(b, alice);
    const duplicate = await f.request('POST', '/api/v1/runs', { connectionId: a.id }, alice);
    assert.equal(duplicate.statusCode, 409); assert.equal(duplicate.json().error.details.runId, first.id);
    const responses = await Promise.race([
      Promise.all([f.request('GET', '/health'), f.request('GET', '/api/v1/jobs', undefined, alice)]),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('APIs blocked behind scraping.')), 1000); timer.unref(); }),
    ]);
    assert.ok(responses.every(response => response.statusCode === 200));
    assert.equal((await f.request('GET', `/api/v1/runs/${queued.id}`, undefined, alice)).json().status, 'queued');
    assert.equal((await f.request('POST', `/api/v1/runs/${queued.id}/stop`, undefined, alice)).json().status, 'stopped');
    assert.equal((await f.request('POST', `/api/v1/runs/${queued.id}/stop`, undefined, alice)).json().status, 'stopped');
    const retried = (await f.request('POST', `/api/v1/runs/${queued.id}/retry`, undefined, alice)).json();
    assert.equal(retried.parentRunId, queued.id);
    assert.equal(retried.status, 'queued');
    await f.request('POST', `/api/v1/runs/${first.id}/stop`, undefined, alice);
    assert.equal((await waitForRun(f, alice, first.id, ['stopped'])).forced, false);
    await waitForRun(f, alice, retried.id, ['running']);
  } finally { await f.close(); }
});

test('same provider account is serialized across users', async () => {
  const f = await serviceFixture({ supervise: true });
  try {
    const alice = await f.login('alice'), bob = await f.login('bob');
    const a = await f.connect(alice, 'hold', 'shared@provider.test');
    const b = await f.connect(bob, 'hold', 'shared@provider.test');
    const first = (await f.request('POST', '/api/v1/runs', { connectionId: a.id }, alice)).json();
    await waitForRun(f, alice, first.id, ['running']);
    const second = (await f.request('POST', '/api/v1/runs', { connectionId: b.id }, bob)).json();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await f.request('GET', `/api/v1/runs/${second.id}`, undefined, bob)).json().status, 'queued');
    await f.request('POST', `/api/v1/runs/${first.id}/stop`, undefined, alice);
    await waitForRun(f, bob, second.id, ['running']);
  } finally { await f.close(); }
});

test('unresponsive worker is stopped by its owned process tree', async () => {
  const f = await serviceFixture({ supervise: true, stopGraceMs: 150 });
  try {
    const alice = await f.login('alice');
    const connection = await f.connect(alice, 'ignore-stop');
    const run = (await f.request('POST', '/api/v1/runs', { connectionId: connection.id }, alice)).json();
    await waitForRun(f, alice, run.id, ['running']);
    assert.equal((await f.request('POST', `/api/v1/runs/${run.id}/stop`, undefined, alice)).statusCode, 202);
    const stopped = await waitForRun(f, alice, run.id, ['stopped']);
    assert.equal(stopped.forced, true);
    assert.equal(stopped.error.code, 'FORCED_STOP');
  } finally { await f.close(); }
});

test('crash retains pending external update and retry does not replay it', async () => {
  const f = await serviceFixture({ supervise: true });
  try {
    const alice = await f.login('alice');
    const connection = await f.connect(alice, 'pending');
    const run = (await f.request('POST', '/api/v1/runs', { connectionId: connection.id }, alice)).json();
    await waitForRun(f, alice, run.id, ['interrupted']);
    const jobs = (await f.request('GET', '/api/v1/jobs', undefined, alice)).json().items;
    assert.equal(jobs[0].processingState, 'mark_pending');
    const retryResponse = await f.request('POST', `/api/v1/runs/${run.id}/retry`, undefined, alice);
    assert.equal(retryResponse.statusCode, 202);
    const retry = retryResponse.json();
    await waitForRun(f, alice, retry.id, ['attention_required']);
    const events = await Promise.all([run.id, retry.id].map(async id => (await f.request('GET', `/api/v1/runs/${id}/events`, undefined, alice)).json().items));
    assert.equal(events.flat().filter(event => event.type === 'simulated_external_write').length, 1);
  } finally { await f.close(); }
});

test('queued work and sessions survive restart; abandoned active work becomes interrupted', async () => {
  const f = await serviceFixture(); let second;
  try {
    const alice = await f.login('alice'), bob = await f.login('bob');
    const a = await f.connect(alice, 'hold');
    const b = await f.connect(bob, 'complete');
    const active = (await f.request('POST', '/api/v1/runs', { connectionId: a.id }, alice)).json();
    await f.app.db.call('claim', 'old-supervisor', 2);
    const queued = (await f.request('POST', '/api/v1/runs', { connectionId: b.id }, bob)).json();
    await f.app.close();
    second = await buildService(f.config);
    const request = (method, url, payload, cookie) => second.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { origin: f.config.origin, cookie } });
    const restarted = { ...f, request };
    assert.equal((await request('GET', `/api/v1/runs/${active.id}`, undefined, alice)).json().status, 'interrupted');
    await waitForRun(restarted, bob, queued.id, ['completed']);
    assert.equal((await request('GET', '/api/v1/auth/me', undefined, bob)).statusCode, 200);
  } finally { await second?.close(); await f.close(); }
});

test('a CLI account lock defers backend work until that account is released', async () => {
  const f = await serviceFixture({ supervise: true }); let release;
  try {
    const alice = await f.login('alice');
    const connection = await f.connect(alice, 'hold');
    const stored = await f.app.db.call('getConnection', f.users.alice.id, connection.id);
    release = await acquireLock(join(f.directory, 'locks', `jobright-${stored.account_key}.lock`));
    const run = (await f.request('POST', '/api/v1/runs', { connectionId: connection.id }, alice)).json();
    const deadline = Date.now() + 5000;
    let deferred = false;
    while (Date.now() < deadline) {
      const events = (await f.request('GET', `/api/v1/runs/${run.id}/events`, undefined, alice)).json().items;
      const current = (await f.request('GET', `/api/v1/runs/${run.id}`, undefined, alice)).json();
      if (events.some(event => event.type === 'starting') && current.status === 'queued') { deferred = true; break; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(deferred, true);
    await f.request('POST', `/api/v1/runs/${run.id}/stop`, undefined, alice);
    await release(); release = null;
    const retry = (await f.request('POST', `/api/v1/runs/${run.id}/retry`, undefined, alice)).json();
    await waitForRun(f, alice, retry.id, ['running']);
  } finally { await release?.(); await f.close(); }
});

test('abandoned CLI records do not permanently consume backend worker capacity', async () => {
  const f = await serviceFixture({ supervise: true });
  try {
    const alice = await f.login('alice');
    const connection = await f.connect(alice, 'hold');
    const stored = await f.app.db.call('getConnection', f.users.alice.id, connection.id);
    const cli = new ServiceStore(f.config.dbPath, { userId: f.users.alice.id, connectionId: connection.id });
    const id = cli.startRun('jobright', stored.account_key, 'browser');
    cli.db.prepare('UPDATE runs SET pid=? WHERE id=?').run(2147483647, id); cli.close();
    const recovered = await waitForRun(f, alice, id, ['interrupted']);
    assert.equal(recovered.error.code, 'CLI_INTERRUPTED');
    const run = (await f.request('POST', '/api/v1/runs', { connectionId: connection.id }, alice)).json();
    await waitForRun(f, alice, run.id, ['running']);
  } finally { await f.close(); }
});
