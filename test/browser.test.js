import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openBrowser } from '../src/core/browser-manager.js';
import browserPlugin from '../plugins/jobright/browser.js';
import { AuthenticationError } from '../src/core/errors.js';
import { startFixtureServer } from './helpers/fixture-server.js';

test('browser fixture: login, detail extraction, return to list, and session reuse', async () => {
  const server = await startFixtureServer({ ids: ['a', 'b', 'c', 'multi'] });
  const directory = await mkdtemp(join(tmpdir(), 'job-browser-fixture-'));
  let browser;
  try {
    const sessionPath = join(directory, 'session.json');
    browser = await openBrowser({ sessionPath });
    const credentials = { email: 'fixture@example.test', password: 'fixture-password' };
    let context = { ...browser, credentials, config: { baseUrl: server.baseUrl } };
    await browserPlugin.authenticate(context);
    const jobs = await browserPlugin.listJobs(context);
    assert.deepEqual(jobs.map(j => j.id), ['a', 'b', 'c', 'multi']);
    const detail = await browserPlugin.getJobDetails(context, jobs[0]);
    assert.equal(detail.id, 'a');
    assert.equal(detail.company, 'Fixture Corp');
    assert.deepEqual(detail.details.responsibilities, ['Build pipelines', 'Maintain data quality']);
    assert.deepEqual(detail.details.qualifications.preferred, ['Python']);
    assert.deepEqual(detail.details.locations, ['New York, NY']);
    assert.match(detail.details.description.text, /Build reliable data systems/);
    const multi = await browserPlugin.getJobDetails(context, jobs.find(job => job.id === 'multi'));
    assert.deepEqual(multi.details.locations, ['New York, NY', 'San Francisco, CA']);
    assert.equal((await browserPlugin.listJobs(context)).length, 4);
    await browser.close(); browser = null;
    const loginCount = server.requests.filter(r => r.path === '/fixture-login').length;
    browser = await openBrowser({ sessionPath });
    context = { ...browser, credentials, config: { baseUrl: server.baseUrl } };
    await browserPlugin.authenticate(context);
    assert.equal(server.requests.filter(r => r.path === '/fixture-login').length, loginCount);
    const next = (await browserPlugin.listJobs(context))[0];
    await browserPlugin.markAsApplied(context, next);
    assert.equal(await browserPlugin.getApplicationStatus(context, next), 'applied');
    assert.deepEqual((await browserPlugin.listJobs(context)).map(j => j.id), ['b', 'c', 'multi']);
    await browser.close(); browser = null;
    browser = await openBrowser({ sessionPath: join(directory, 'invalid-session.json') });
    await assert.rejects(browserPlugin.authenticate({ ...browser, credentials: { email: 'fixture@example.test', password: 'incorrect-password' }, config: { baseUrl: server.baseUrl } }), AuthenticationError);
  } finally {
    await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});
