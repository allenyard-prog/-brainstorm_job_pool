import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/database.js';

const job = () => ({ id: 'abc', url: 'https://example.com/jobs/abc', title: 'Engineer', company: 'Example', details: { description: { text: '長い description '.repeat(20000), html: '<p>Full description</p>' }, extra: { nested: [1, null, '🚀'] } }, raw: { jobId: 'abc', arbitrary: { futureField: true } } });
test('SQLite preserves long JSON, raw data and source identity on upsert', () => {
  const store = new Store(':memory:');
  try {
    const initial = job();
    const id = store.saveJob('fixture', 'a', initial);
    assert.equal(store.saveJob('fixture', 'a', { ...initial, title: 'Updated title' }), id);
    const rows = store.jobs('fixture');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].details, initial.details);
    assert.deepEqual(rows[0].raw, initial.raw);
    assert.equal(rows[0].title, 'Updated title');
  } finally { store.close(); }
});
test('processing state is account scoped and pending updates survive resaving', () => {
  const store = new Store(':memory:');
  try {
    const id = store.saveJob('fixture', 'a', job());
    store.transition(id, 'a', 'mark_pending');
    store.saveJob('fixture', 'a', job());
    store.saveJob('fixture', 'b', job());
    assert.equal(store.state('fixture', 'a', 'abc').state, 'mark_pending');
    assert.equal(store.state('fixture', 'b', 'abc').state, 'saved');
    assert.equal(store.pending('fixture', 'a')[0].databaseId, id);
  } finally { store.close(); }
});
test('invalid extraction or invalid JSON cannot create a markable record', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.saveJob('fixture', 'a', { ...job(), details: {} }));
    assert.equal(store.jobs('fixture').length, 0);
    const id = store.saveJob('fixture', 'a', job());
    assert.throws(() => store.db.prepare('UPDATE jobs SET details_json=? WHERE id=?').run('{broken', id));
  } finally { store.close(); }
});
