import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from './helpers/service-fixture.js';
import { ServiceStore } from '../src/storage/service-store.js';
import { accountKey } from '../src/core/security.js';

async function setup() {
  const f = await serviceFixture();
  const cookie = await f.login('alice');
  const bob = await f.login('bob');
  const one = await f.connect(cookie, 'hold', 'one@provider.test');
  const two = await f.connect(cookie, 'hold', 'two@provider.test');
  const other = await f.connect(bob, 'hold', 'other@provider.test');
  const store = new ServiceStore(f.config.dbPath);
  store.updateConnectionProfile(f.users.alice.id, one.id, { personName: 'Daniel Zhang' });
  let next = 0;
  function save(user, profile, title = 'Assignment Engineer') {
    const scoped = new ServiceStore(f.config.dbPath, { userId: user.id, connectionId: profile.id });
    try {
      const id = scoped.saveJob('jobright', accountKey(profile.label), {
        id: String(next++), title, company: 'Fixture Company', url: 'https://employer.test/job',
        details: { description: { text: 'Long description '.repeat(1000) }, matching: { score: 80 } },
      });
      scoped.transition(id, accountKey(profile.label), 'mark_confirmed', 'applied');
      return id;
    } finally { scoped.close(); }
  }
  const a = Array.from({ length: 23 }, () => save(f.users.alice, one));
  const b = Array.from({ length: 4 }, () => save(f.users.alice, two));
  const foreign = save(f.users.bob, other);
  const imported = save(f.users.alice, one);
  store.db.prepare('UPDATE jobs SET connection_id=NULL WHERE id=?').run(imported);
  store.db.prepare('UPDATE jobs SET assigned_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', a[0]);
  const title = store.createProfileTitle(f.users.alice.id, one.id, { title: 'SRE' });
  store.setPreferredTitle(f.users.alice.id, a[1], title.id);
  const post = (path, body, session = cookie, origin) => f.request('POST', `/api/v1/jobs/${path}`, body, session, origin);
  return { ...f, cookie, bob, one, two, a, b, imported, foreign, store, save, post,
    async close() { store.close(); await f.close(); } };
}
const unchangedFields = (store) => store.db.prepare(`SELECT j.id,j.details_json,j.company_id,j.preferred_title_id,j.preferred_title_revision,p.state,p.website_status
  FROM jobs j LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key ORDER BY j.id`).all();

test('assignment previews count all pages by profile and updates only change local assignment', async () => {
  const f = await setup();
  try {
    const before = unchangedFields(f.store);
    const response = await f.post('assignment-preview', { action: 'assign', filters: {} });
    assert.equal(response.statusCode, 200);
    const preview = response.json();
    assert.equal(preview.total, 27);
    assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(preview.profiles.reduce((sum, p) => sum + p.count, 0), preview.total);
    assert.deepEqual(preview.profiles.find(p => p.connectionId === f.one.id), {
      connectionId: f.one.id, personName: 'Daniel Zhang', label: f.one.label, count: 22,
    });
    assert.equal(preview.profiles.find(p => p.connectionId === f.two.id).count, 4);
    assert.deepEqual(preview.profiles.find(p => p.connectionId === null), {
      connectionId: null, personName: null, label: 'Imported account', count: 1,
    });
    assert.equal((await f.post('assignment-preview', { action: 'assign', filters: { status: 'assigned' } })).json().total, 0);
    assert.equal((await f.post('assignment-preview', { action: 'unassign', filters: { status: 'available' } })).json().total, 0);
    const result = await f.post('assign', { previewFingerprint: preview.fingerprint });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { assignedCount: 27 });
    assert.equal((await f.post('assign', {})).json().assignedCount, 0);
    assert.equal(f.store.jobDetail(f.users.alice.id, f.a[0]).assignedAt, '2020-01-01T00:00:00.000Z');
    assert.equal(f.store.jobDetail(f.users.bob.id, f.foreign).assignedAt, null);
    const unassign = (await f.post('assignment-preview', { action: 'unassign', filters: { status: 'assigned' } })).json();
    assert.equal(unassign.total, 28);
    assert.equal((await f.post('unassign', { status: 'assigned', previewFingerprint: unassign.fingerprint })).json().unassignedCount, 28);
    assert.equal((await f.post('unassign', {})).json().unassignedCount, 0);
    assert.deepEqual(unchangedFields(f.store), before);
    assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 8);
  } finally { await f.close(); }
});

test('stale membership, changed assignment timestamps, other owners and changed filters invalidate previews', async () => {
  const f = await setup();
  try {
    const preview = async (action, filters = {}) => (await f.post('assignment-preview', { action, filters })).json();
    const first = await preview('assign');
    f.save(f.users.alice, f.one);
    const stale = await f.post('assign', { previewFingerprint: first.fingerprint });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'ASSIGNMENT_PREVIEW_CHANGED');
    assert.equal((await preview('unassign')).total, 1);
    const current = await preview('assign');
    assert.equal((await f.post('assign', { q: 'Assignment', previewFingerprint: current.fingerprint })).statusCode, 409);
    assert.equal((await f.post('assign', { previewFingerprint: current.fingerprint }, f.bob)).statusCode, 409);
    assert.equal((await f.post('unassign', { previewFingerprint: current.fingerprint })).statusCode, 409);
    // Same total, different identities must also require another confirmation.
    f.store.db.prepare('UPDATE jobs SET assigned_at=NULL WHERE id=?').run(f.a[0]);
    f.store.db.prepare('UPDATE jobs SET assigned_at=? WHERE id=?').run('2021-01-01T00:00:00.000Z', f.a[1]);
    assert.equal((await preview('assign')).total, current.total);
    assert.equal((await f.post('assign', { previewFingerprint: current.fingerprint })).statusCode, 409);
    const unassign = await preview('unassign');
    f.store.db.prepare('UPDATE jobs SET assigned_at=? WHERE id=?').run('2022-01-01T00:00:00.000Z', f.a[1]);
    assert.equal((await f.post('unassign', { previewFingerprint: unassign.fingerprint })).statusCode, 409);
    const ownerScoped = await f.post('assignment-preview', { action: 'unassign', filters: { connectionId: f.one.id } }, f.bob);
    assert.deepEqual(ownerScoped.json().profiles, []);
    assert.equal((await f.post('unassign', { connectionId: f.one.id }, f.bob)).json().unassignedCount, 0);
    // Reordering the same filter fields does not invalidate a preview.
    const filters = { q: 'Assignment', connectionId: f.two.id };
    const sorted = await preview('assign', filters);
    assert.equal((await f.post('assign', { connectionId: f.two.id, q: 'Assignment', previewFingerprint: sorted.fingerprint })).json().assignedCount, 4);
  } finally { await f.close(); }
});

test('assignment preview and mutations enforce authentication, origins and strict request schemas', async () => {
  const f = await setup();
  try {
    for (const [path, body] of [['assignment-preview', { action: 'assign', filters: {} }], ['assign', {}], ['unassign', {}]]) {
      assert.equal((await f.request('POST', `/api/v1/jobs/${path}`, body)).statusCode, 401);
      assert.equal((await f.post(path, body, f.cookie, 'https://untrusted.test')).statusCode, 403);
    }
    for (const body of [{}, { action: 'delete', filters: {} }, { action: 'assign' }, { action: 'assign', filters: { limit: 20 } }, { action: 'assign', filters: { totalMatchMin: 101 } }])
      assert.equal((await f.post('assignment-preview', body)).statusCode, 400);
    for (const path of ['assign', 'unassign']) {
      for (const body of [{ previewFingerprint: 'bad' }, { previewFingerprint: null }, { page: 1 }, { industryMatchMin: 90, industryMatchMax: 20 }])
        assert.equal((await f.post(path, body)).statusCode, 400);
    }
  } finally { await f.close(); }
});

test('assignment and unassignment roll back every row on persistence failure', async () => {
  const f = await setup();
  try {
    for (const action of ['assign', 'unassign']) {
      if (action === 'unassign') f.store.assignJobs(f.users.alice.id);
      const before = f.store.db.prepare('SELECT id,assigned_at FROM jobs ORDER BY id').all();
      const preview = (await f.post('assignment-preview', { action, filters: {} })).json();
      f.store.db.exec(`CREATE TRIGGER assignment_failure BEFORE UPDATE OF assigned_at ON jobs WHEN NEW.id=${f.a[2]} BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`);
      assert.equal((await f.post(action, { previewFingerprint: preview.fingerprint })).statusCode, 500);
      assert.deepEqual(f.store.db.prepare('SELECT id,assigned_at FROM jobs ORDER BY id').all(), before);
      f.store.db.exec('DROP TRIGGER assignment_failure');
    }
    assert.equal((await f.request('GET', '/ready')).statusCode, 200);
  } finally { await f.close(); }
});
