import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture, backendPassword } from './helpers/service-fixture.js';
import { hashPassword, verifyPassword, encryptCredentials, decryptCredentials, hashToken } from '../src/service/crypto.js';

test('backend sessions, role permissions, origin enforcement and OpenAPI', async t => {
  const f = await serviceFixture();
  try {
    const alice = await f.login('alice'), admin = await f.login('admin');
    await t.test('cookies are HttpOnly, revocable and resource responses omit authentication material', async () => {
      const login = await f.request('POST', '/api/v1/auth/login', { email: 'bob@fixture.test', password: backendPassword });
      assert.equal(login.statusCode, 200);
      assert.match(login.headers['set-cookie'], /HttpOnly/);
      assert.match(login.headers['set-cookie'], /SameSite=Strict/);
      assert.ok(!/password_hash|token|scrypt\$/.test(login.body));
      const cookie = `session=${login.cookies[0].value}`;
      assert.equal((await f.request('GET', '/api/v1/auth/me', undefined, cookie)).json().email, 'bob@fixture.test');
      assert.equal((await f.request('POST', '/api/v1/auth/logout', undefined, cookie)).statusCode, 200);
      assert.equal((await f.request('GET', '/api/v1/auth/me', undefined, cookie)).statusCode, 401);
      assert.equal((await f.request('GET', '/api/v1/jobs')).statusCode, 401);
      await f.app.db.call('createSession', { tokenHash: hashToken('expired'), userId: f.users.bob.id, expiresAt: Date.now() - 1000 });
      assert.equal((await f.request('GET', '/api/v1/auth/me', undefined, 'session=expired')).statusCode, 401);
    });
    await t.test('only administrators create users and cross-origin writes are rejected', async () => {
      const payload = { email: 'new@fixture.test', password: backendPassword };
      assert.equal((await f.request('POST', '/api/v1/users', payload, alice)).statusCode, 403);
      assert.equal((await f.request('POST', '/api/v1/users', payload, admin, 'https://untrusted.test')).statusCode, 403);
      assert.equal((await f.request('POST', '/api/v1/users', payload, admin, null)).statusCode, 403);
      assert.equal((await f.request('POST', '/api/v1/users', payload, admin)).statusCode, 201);
      assert.equal((await f.request('GET', '/api/v1/users', undefined, alice)).statusCode, 403);
      assert.equal((await f.request('POST', '/api/v1/users', { ...payload, injected: true }, admin)).statusCode, 400);
    });
    await t.test('connections encrypt credentials and reject replacement during queued work', async () => {
      const connection = await f.connect(alice, 'private-site-password', 'private@provider.test');
      assert.ok(!JSON.stringify(connection).includes('private-site-password'));
      const row = await f.app.db.call('getConnection', f.users.alice.id, connection.id);
      assert.ok(!row.encrypted_credentials.includes('private-site-password'));
      const values = decryptCredentials(row.encrypted_credentials, f.config.key, `${f.users.alice.id}:jobright:${row.account_key}`);
      assert.equal(values.password, 'private-site-password');
      const queued = await f.request('POST', '/api/v1/connections/' + connection.id + '/authenticate', undefined, alice);
      assert.equal(queued.statusCode, 202);
      assert.equal((await f.request('PATCH', `/api/v1/connections/${connection.id}/credentials`, { email: values.email, password: 'replacement' }, alice)).statusCode, 409);
      assert.ok(!JSON.stringify(queued.json()).includes('private-site-password'));
    });
    await t.test('login failures are generic and rate limited', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await f.request('POST', '/api/v1/auth/login', { email: 'unknown@fixture.test', password: 'incorrect' })).statusCode, 401);
      assert.equal((await f.request('POST', '/api/v1/auth/login', { email: 'unknown@fixture.test', password: 'incorrect' })).statusCode, 429);
    });
    await t.test('health, readiness and generated documentation are available', async () => {
      assert.equal((await f.request('GET', '/health')).statusCode, 200);
      assert.equal((await f.request('GET', '/ready')).statusCode, 200);
      const docs = await f.request('GET', '/docs/json');
      assert.equal(docs.statusCode, 200);
      assert.ok(docs.json().paths['/api/v1/runs']);
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const health = await fetch(`${address}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
    });
  } finally { await f.close(); }
});
test('password and connection cryptography verifies values and detects tampering or owner swaps', async () => {
  const hash = await hashPassword(backendPassword);
  assert.equal(await verifyPassword(backendPassword, hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  const key = Buffer.alloc(32, 3);
  const encoded = encryptCredentials({ password: 'secret' }, key, 'alice');
  assert.deepEqual(decryptCredentials(encoded, key, 'alice'), { password: 'secret' });
  assert.throws(() => decryptCredentials(encoded, key, 'bob'));
  const changed = JSON.parse(encoded); changed.tag = '00'.repeat(16);
  assert.throws(() => decryptCredentials(JSON.stringify(changed), key, 'alice'));
});
