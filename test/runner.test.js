import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/database.js';
import { runJobs } from '../src/core/runner.js';
import { AuthenticationError, UncertainWriteError } from '../src/core/errors.js';

const detail = id => ({ id, url: `https://example.test/jobs/${id}`, title: `Job ${id}`, details: { description: { text: `Description ${id}` } } });
function setup(overrides = {}) {
  const store = new Store(':memory:');
  const controller = new AbortController();
  const applied = new Set();
  const writes = [];
  const plugin = {
    authenticate: async () => {},
    listJobs: async () => ['a', 'b', 'c'].filter(id => !applied.has(id)).map(id => ({ id })),
    getJobDetails: async (_, job) => detail(job.id),
    markAsApplied: async (_, job) => {
      assert.equal(store.state('fixture', 'account', job.id).state, 'mark_pending');
      assert.ok(store.jobs('fixture').some(row => row.source_job_id === job.id));
      writes.push(job.id); applied.add(job.id);
    },
    getApplicationStatus: async (_, job) => applied.has(job.id) ? 'applied' : 'not_applied',
    ...overrides,
  };
  const options = { plugin, context: {}, store, site: 'fixture', account: 'account', transport: 'browser', signal: controller.signal, limit: 3, intervalMs: 0, pollMs: 1 };
  return { store, controller, applied, writes, plugin, options };
}
test('persists before writing and does not skip cards when the list shrinks', async () => {
  const f = setup();
  let listings = 0;
  const list = f.plugin.listJobs;
  f.plugin.listJobs = async (...args) => { listings++; return list(...args); };
  try {
    const result = await runJobs(f.options);
    assert.deepEqual(f.writes, ['a', 'b', 'c']);
    assert.equal(result.confirmed, 3);
    assert.equal(listings, 3, 'browser transport must re-list after each job');
  } finally { f.store.close(); }
});
test('failed persistence prevents any website update', async () => {
  const f = setup();
  f.store.saveJob = () => { throw new Error('disk full'); };
  try {
    await assert.rejects(runJobs(f.options), /Three jobs failed/);
    assert.equal(f.writes.length, 0);
  } finally { f.store.close(); }
});
test('ambiguous status write is not retried and remains pending', async () => {
  let calls = 0;
  const f = setup({ markAsApplied: async () => { calls++; throw new Error('connection lost'); }, getApplicationStatus: async () => 'unknown' });
  try {
    await assert.rejects(runJobs(f.options), UncertainWriteError);
    assert.equal(calls, 1);
    assert.equal(f.store.pending('fixture', 'account').length, 1);
  } finally { f.store.close(); }
});
test('restart verifies a previously pending update without repeating it', async () => {
  const f = setup();
  const id = f.store.saveJob('fixture', 'account', detail('a'));
  f.store.transition(id, 'account', 'mark_pending'); f.applied.add('a');
  try {
    await runJobs({ ...f.options, limit: 2 });
    assert.deepEqual(f.writes, ['b', 'c']);
    assert.equal(f.store.state('fixture', 'account', 'a').state, 'mark_confirmed');
  } finally { f.store.close(); }
});
test('Ctrl+C after persistence prevents the next write', async () => {
  const f = setup();
  const save = f.store.saveJob.bind(f.store);
  f.store.saveJob = (...args) => { const id = save(...args); f.controller.abort(); return id; };
  try {
    await runJobs(f.options);
    assert.equal(f.writes.length, 0);
    assert.equal(f.store.jobs('fixture').length, 1);
  } finally { f.store.close(); }
});
test('an update already sent before interruption is still reconciled', async () => {
  const f = setup();
  f.plugin.markAsApplied = async (_, job) => { f.applied.add(job.id); f.controller.abort(); };
  try {
    await runJobs(f.options);
    assert.equal(f.store.state('fixture', 'account', 'a').state, 'mark_confirmed');
  } finally { f.store.close(); }
});
test('authentication failure pauses without processing jobs', async () => {
  const f = setup({ authenticate: async () => { throw new AuthenticationError('Session expired'); } });
  try {
    await assert.rejects(runJobs(f.options), AuthenticationError);
    assert.equal(f.writes.length, 0);
  } finally { f.store.close(); }
});
test('read-only mode saves without website updates', async () => {
  const f = setup();
  try {
    await runJobs({ ...f.options, limit: 1, readOnly: true });
    assert.equal(f.writes.length, 0);
    assert.equal(f.store.jobs('fixture').length, 1);
  } finally { f.store.close(); }
});
test('empty recommendations poll until stopped', async () => {
  const f = setup({ listJobs: async () => [] });
  setTimeout(() => f.controller.abort(), 10);
  try { const result = await runJobs(f.options); assert.equal(result.saved, 0); }
  finally { f.store.close(); }
});
test('persisted run errors redact credential values', async () => {
  const f = setup({ authenticate: async () => { throw new AuthenticationError('Failed for fixture-password and fixture@example.test'); } });
  try {
    await assert.rejects(runJobs({ ...f.options, context: { credentials: { email: 'fixture@example.test', password: 'fixture-password' } } }), AuthenticationError);
    const error = f.store.db.prepare('SELECT error FROM runs').get().error;
    assert.ok(!error.includes('fixture-password'));
    assert.ok(!error.includes('fixture@example.test'));
  } finally { f.store.close(); }
});
