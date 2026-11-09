import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NetworkRecorder } from '../src/core/network-recorder.js';

test('concurrent diagnostic writes remain valid JSONL and redact secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-recorder-'));
  try {
    const recorder = new NetworkRecorder(directory, ['fixture-password']);
    recorder.action('verify', 'fixture-job');
    await Promise.all(Array.from({ length: 8 }, (_, index) => recorder.api({
      url: 'https://jobright.ai/swan/job/applied/jobs-v3?token=live-secret', method: 'POST', status: 200,
      request: { cursor: 'private-account-cursor' }, response: { index, text: 'Long detail '.repeat(10000), password: 'fixture-password' },
    })));
    await recorder.close();
    const output = await readFile(join(directory, 'network.jsonl'), 'utf8');
    const rows = output.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.map(row => row.response.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(!output.includes('live-secret'));
    assert.ok(!output.includes('private-account-cursor'));
    assert.ok(!output.includes('fixture-password'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('browser recorder excludes credential, analytics, and unrelated requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-recorder-filter-'));
  let listener;
  const context = { on: (_, handler) => { listener = handler; }, off: () => {} };
  const recorder = new NetworkRecorder(directory);
  recorder.attach(context);
  for (const path of ['/swan/auth/login', '/swan/event/submit', '/swan/profile/info', '/static/locations/cities.json']) {
    listener({ request: () => ({ resourceType: () => 'fetch' }), url: () => `https://jobright.ai${path}` });
  }
  try { await recorder.close(); assert.equal(recorder.entries.length, 0); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
