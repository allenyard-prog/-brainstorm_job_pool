import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildService } from '../../src/service/app.js';
import { serviceConfig } from '../../src/service/config.js';
import { hashPassword } from '../../src/service/crypto.js';

export const backendPassword = 'Backend-fixture-password-123!';
const passwordHash = await hashPassword(backendPassword);
export async function serviceFixture({ supervise = false, ...overrides } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'job-service-test-'));
  const config = serviceConfig({ key: randomBytes(32), dataDir: directory, artifactsDir: join(directory, 'artifacts'),
    dbPath: join(directory, 'jobs.sqlite'), tickMs: 25, stopGraceMs: 300, staleMs: 5000,
    workerModule: fileURLToPath(new URL('./managed-worker.mjs', import.meta.url)),
    workerSettings: { intervalMs: 0, pollMs: 20, timeout: 10000 }, ...overrides });
  let app;
  try { app = await buildService(config, { supervise }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const request = (method, url, payload, cookie, origin = config.origin) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } });
  const users = {};
  for (const [name, role] of [['admin', 'admin'], ['alice', 'user'], ['bob', 'user']]) users[name] = await app.db.call('createUser', { email: `${name}@fixture.test`, passwordHash, role });
  async function login(name) {
    const response = await request('POST', '/api/v1/auth/login', { email: `${name}@fixture.test`, password: backendPassword });
    if (response.statusCode !== 200) throw new Error(`Fixture login failed: ${response.body}`);
    return `session=${response.cookies.find(cookie => cookie.name === 'session').value}`;
  }
  async function connect(cookie, mode = 'hold', email = `${mode}@provider.test`) {
    const result = await request('POST', '/api/v1/connections', { site: 'jobright', email, password: mode }, cookie);
    if (result.statusCode !== 201) throw new Error(`Fixture connection failed: ${result.body}`);
    return result.json();
  }
  return { app, config, directory, users, request, login, connect,
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function waitForRun(fixture, cookie, id, states, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fixture.request('GET', `/api/v1/runs/${id}`, undefined, cookie);
    if (states.includes(last.json().status)) return last.json();
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Run did not reach ${states.join(', ')}: ${last?.body}`);
}
