import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture, waitForRun } from './helpers/service-fixture.js';

test('users cannot access another owner connections, jobs, runs, events or retries', async () => {
  const f = await serviceFixture({ supervise: true });
  try {
    const alice = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('admin');
    const connection = await f.connect(alice, 'complete');
    const started = await f.request('POST', '/api/v1/runs', { connectionId: connection.id, transport: 'api', limit: 1 }, alice);
    assert.equal(started.statusCode, 202);
    const run = await waitForRun(f, alice, started.json().id, ['completed']);
    assert.equal(run.counters.saved, 1);
    for (const outsider of [bob, admin]) {
      assert.deepEqual((await f.request('GET', '/api/v1/connections', undefined, outsider)).json(), []);
      assert.equal((await f.request('GET', '/api/v1/jobs', undefined, outsider)).json().items.length, 0);
      for (const [method, path, payload] of [['GET', `/api/v1/runs/${run.id}`], ['GET', `/api/v1/runs/${run.id}/events`], ['POST', `/api/v1/runs/${run.id}/stop`], ['POST', `/api/v1/runs/${run.id}/retry`], ['POST', `/api/v1/connections/${connection.id}/authenticate`, {}], ['PATCH', `/api/v1/connections/${connection.id}/credentials`, { email: 'someone@provider.test', password: 'secret' }]]) {
        assert.equal((await f.request(method, path, payload, outsider)).statusCode, 404, path);
      }
    }
    const list = (await f.request('GET', '/api/v1/jobs?limit=1&q=Engineer&status=mark_confirmed', undefined, alice)).json();
    assert.equal(list.items.length, 1);
    assert.ok(!list.items[0].details);
    const id = list.items[0].id;
    assert.equal((await f.request('GET', `/api/v1/jobs/${id}`, undefined, bob)).statusCode, 404);
    const detail = (await f.request('GET', `/api/v1/jobs/${id}`, undefined, alice)).json();
    assert.ok(detail.details.description.text.length > 100000);
    assert.ok(!('raw' in detail));
    const withRaw = await f.request('GET', `/api/v1/jobs/${id}?includeRaw=true`, undefined, alice);
    assert.equal(withRaw.json().raw.retained, true);
    assert.ok(!withRaw.body.includes('should-not-leak'));
    assert.equal((await f.request('GET', '/api/v1/jobs?limit=101', undefined, alice)).statusCode, 400);
    assert.equal((await f.request('GET', '/api/v1/jobs?cursor=invalid', undefined, alice)).statusCode, 400);
    assert.equal((await f.request('GET', '/api/v1/jobs?q=%25', undefined, alice)).statusCode, 200);
    const events = (await f.request('GET', `/api/v1/runs/${run.id}/events`, undefined, alice)).json();
    assert.ok(events.items.length);
    assert.equal((await f.request('GET', `/api/v1/runs/${run.id}/events?after=${events.nextCursor}`, undefined, alice)).json().items.length, 0);
  } finally { await f.close(); }
});
