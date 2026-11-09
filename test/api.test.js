import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openBrowser } from '../src/core/browser-manager.js';
import { Store } from '../src/storage/database.js';
import { runJobs } from '../src/core/runner.js';
import { compareJobs } from '../src/core/compare.js';
import { AuthenticationError, UnsupportedError } from '../src/core/errors.js';
import api from '../plugins/jobright/api.js';
import browserPlugin from '../plugins/jobright/browser.js';
import { startFixtureServer } from './helpers/fixture-server.js';

test('API fixture integration', async t => {
  const ids = Array.from({ length: 25 }, (_, i) => `job${i}`);
  const server = await startFixtureServer({ ids });
  const directory = await mkdtemp(join(tmpdir(), 'job-api-fixture-'));
  const browser = await openBrowser({ sessionPath: join(directory, 'session.json') });
  const store = new Store(':memory:');
  const context = { ...browser, http: browser.context.request, credentials: { email: 'fixture@example.test', password: 'fixture-password' }, config: { baseUrl: server.baseUrl } };
  try {
    await api.authenticate(context);
    await t.test('uses browser authentication for direct API reads and matches browser detail fields', async () => {
      const job = (await api.listJobs(context))[0];
      const fromApi = await api.getJobDetails(context, job);
      const fromBrowser = await browserPlugin.getJobDetails(context, job);
      assert.equal(compareJobs(fromBrowser, fromApi).matches, true);
      assert.deepEqual(fromApi.raw.jobResult.unknownFutureField, { nested: 'preserved' });
    });
    await t.test('paginates past excluded recommendations', async () => {
      const jobs = await api.listJobs(context, { excludeIds: ids.slice(0, 20) });
      assert.equal(jobs[0].id, 'job20');
      assert.ok(server.requests.some(r => r.path.includes('/recommend/list/jobs') && r.query.position === '20'));
    });
    await t.test('saves then updates through HTTP without navigating to job pages', async () => {
      const before = server.requests.filter(r => r.path.startsWith('/jobs/')).length;
      const originalAuth = api.authenticate;
      const plugin = { ...api, authenticate: async () => {} };
      const result = await runJobs({ plugin, context, store, site: 'fixture', account: 'account', transport: 'api', limit: 1, intervalMs: 0 });
      assert.equal(result.confirmed, 1);
      assert.equal(server.requests.filter(r => r.path.startsWith('/jobs/')).length, before);
      assert.equal(store.jobs('fixture').length, 1);
      assert.equal(typeof originalAuth, 'function');
    });
    await t.test('reconciles a lost write response without repeating the mutation', async () => {
      server.loseNextWriteResponse();
      const before = server.requests.filter(r => r.path === '/swan/job/apply').length;
      const result = await runJobs({ plugin: { ...api, authenticate: async () => {} }, context, store, site: 'fixture', account: 'account', transport: 'api', limit: 1, intervalMs: 0 });
      assert.equal(result.confirmed, 1);
      assert.equal(server.requests.filter(r => r.path === '/swan/job/apply').length, before + 1);
    });
    await t.test('paginates Applied history by cursor and treats absence as uncertain', async () => {
      ids.forEach(id => server.applied.add(id));
      assert.equal(await api.getApplicationStatus(context, { id: ids[0] }), 'applied');
      assert.ok(server.requests.some(r => r.path.endsWith('/applied/jobs-v3') && r.body.cursor));
      assert.equal(await api.getApplicationStatus(context, { id: 'missing' }), 'unknown');
    });
    await t.test('rejects changed response schemas without browser fallback', async () => {
      server.breakSchema(true);
      await assert.rejects(api.listJobs(context), UnsupportedError);
      server.breakSchema(false);
    });
    await t.test('expired session pauses rather than scraping or writing', async () => {
      server.expire();
      await assert.rejects(api.listJobs(context), AuthenticationError);
    });
  } finally {
    store.close(); await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});
