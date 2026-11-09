import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, waitForRun } from './helpers/service-fixture.js';
import { startFixtureServer } from './helpers/fixture-server.js';

test('real background worker authenticates and collects through Jobright plugin against a local fixture', async () => {
  const source = await startFixtureServer();
  const f = await serviceFixture({ supervise: true, workerModule: undefined, stopGraceMs: 5000, workerSettings: { baseUrl: source.baseUrl, intervalMs: 0, pollMs: 50, timeout: 10000 } });
  try {
    const alice = await f.login('alice');
    const connection = await f.connect(alice, 'fixture-password', 'fixture@example.test');
    const authentication = await f.request('POST', `/api/v1/connections/${connection.id}/authenticate`, {}, alice);
    assert.equal(authentication.statusCode, 202);
    assert.equal(authentication.json().status, 'queued');
    assert.equal((await f.request('GET', '/health')).statusCode, 200);
    await waitForRun(f, alice, authentication.json().id, ['completed'], 20000);
    assert.equal((await f.request('GET', '/api/v1/connections', undefined, alice)).json()[0].authStatus, 'ready');
    await access(join(f.directory, 'sessions', f.users.alice.id, connection.id, 'session.json'));
    const response = await f.request('POST', '/api/v1/runs', { connectionId: connection.id, transport: 'api', limit: 1 }, alice);
    assert.equal(response.statusCode, 202);
    const complete = await waitForRun(f, alice, response.json().id, ['completed'], 20000);
    assert.equal(complete.counters.confirmed, 1);
    assert.equal(source.applied.size, 1);
    const jobs = (await f.request('GET', '/api/v1/jobs', undefined, alice)).json().items;
    assert.equal(jobs[0].processingState, 'mark_confirmed');
    const events = (await f.request('GET', `/api/v1/runs/${response.json().id}/events`, undefined, alice)).json().items;
    assert.ok(events.some(event => event.type === 'job_saved'));
    assert.ok(!JSON.stringify(events).includes('fixture-password'));
    const continuous = (await f.request('POST', '/api/v1/runs', { connectionId: connection.id, transport: 'api', readOnly: true }, alice)).json();
    await waitForRun(f, alice, continuous.id, ['running'], 20000);
    const entry = f.app.supervisor.children.get(continuous.id);
    entry.child.disconnect();
    const interrupted = await waitForRun(f, alice, continuous.id, ['interrupted'], 20000);
    assert.equal(interrupted.error.code, 'SUPERVISOR_DISCONNECTED');
  } finally { await f.close(); await source.close(); }
});
