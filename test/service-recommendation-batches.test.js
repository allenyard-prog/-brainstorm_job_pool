import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ServiceStore } from '../src/storage/service-store.js';
import { classificationRequest } from '../src/service/recommendations.js';
import { INPUT_BYTES, validateRequest } from '../src/ai/validation.js';
import { recommendationFixture, classificationInput } from './helpers/recommendation-fixture.js';

const resultsFor = (args, titleId) => ({
  results: classificationInput(args).jobs.map(job => ({ jobId: job.jobId, specializationId: titleId })),
});

test('23 filtered jobs use 10/10/3 requests, retain the captured set and count jobs rather than calls', async () => {
  const f = await recommendationFixture();
  try {
    const ids = Array.from({ length: 23 }, (_, index) => f.save(f.one, 'batch-' + index));
    f.save(f.two, 'outside-profile'); f.save(f.foreign, 'foreign');
    const run = await f.start({ connectionId: f.one.id });
    const after = f.save(f.one, 'after-enqueue');
    await f.app.recommendations.start();
    const done = await f.wait(run.id);
    assert.equal(done.total, 23); assert.equal(done.processed, 23); assert.equal(done.updated, 23);
    assert.deepEqual(f.source.requests.map(request => classificationInput(request).jobs.length), [10, 10, 3]);
    assert.deepEqual(f.source.requests.flatMap(request => classificationInput(request).jobs.map(job => job.jobId)), ids);
    assert.ok(f.source.requests.every(request => request.body.max_output_tokens === 2048));
    assert.equal((await f.command('GET', `/jobs/${after}`)).preferredTitleId, null);
    const db = new DatabaseSync(f.config.dbPath, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8); } finally { db.close(); }
  } finally { await f.close(); }
});

test('interleaved profiles never share a batch even with the same provider and model', async () => {
  const f = await recommendationFixture();
  try {
    await f.configure(f.two, 'openai', 'Independent second-profile rule.');
    const one = [], two = [];
    for (let index = 0; index < 11; index++) {
      one.push(f.save(f.one, 'one-' + index));
      if (index < 2) two.push(f.save(f.two, 'two-' + index));
    }
    const done = await f.run();
    assert.equal(done.updated, 13); assert.equal(f.source.requests.length, 3);
    for (const request of f.source.requests) {
      const { jobs, titles } = classificationInput(request);
      const firstProfile = one.includes(jobs[0].jobId), allowed = firstProfile ? one : two;
      assert.ok(jobs.every(job => allowed.includes(job.jobId)));
      assert.equal(titles[0].id, firstProfile ? f.first.id : f.otherTitle.id);
      assert.equal(request.body.instructions.includes('Independent second-profile rule.'), !firstProfile);
    }
  } finally { await f.close(); }
});

test('reordered results map by job ID and retain replacement, unchanged and no-match behavior', async () => {
  const f = await recommendationFixture();
  try {
    const ids = Array.from({ length: 4 }, (_, index) => f.save(f.one, 'order-' + index));
    for (const [index, title] of [[0, f.second.id], [2, f.second.id], [3, f.first.id]])
      await f.command('PATCH', `/jobs/${ids[index]}`, { preferredTitleId: title });
    const chosen = [f.first.id, f.second.id, null, f.first.id];
    f.choose(() => ({ results: ids.map((jobId, index) => ({ jobId, specializationId: chosen[index] })).reverse() }));
    const done = await f.run({ connectionId: f.one.id });
    assert.equal(done.updated, 2); assert.equal(done.unchanged, 1); assert.equal(done.unmatched, 1);
    for (const [index, expected] of [f.first.id, f.second.id, f.second.id, f.first.id].entries())
      assert.equal((await f.command('GET', `/jobs/${ids[index]}`)).preferredTitleId, expected);
  } finally { await f.close(); }
});

for (const variant of ['missing', 'duplicate', 'unexpected', 'foreign-job', 'foreign-title', 'missing-field', 'extra-field', 'bare-array']) {
  test(`invalid ${variant} batch results reject all ten jobs without partial saves or retries, then continue`, async () => {
    const f = await recommendationFixture();
    try {
      const ids = Array.from({ length: 21 }, (_, index) => f.save(f.one, 'invalid-batch-' + index));
      const foreign = f.save(f.foreign, 'foreign');
      let calls = 0;
      f.choose(args => {
        const data = resultsFor(args, f.first.id);
        if (++calls !== 1) return data;
        if (variant === 'missing') data.results.pop();
        if (variant === 'duplicate') data.results[1] = { ...data.results[0] };
        if (variant === 'unexpected') data.results[0].jobId = 999999;
        if (variant === 'foreign-job') data.results[0].jobId = foreign;
        if (variant === 'foreign-title') data.results[0].specializationId = f.otherTitle.id;
        if (variant === 'missing-field') delete data.results[0].jobId;
        if (variant === 'extra-field') data.results[0].explanation = 'Must not be accepted or persisted';
        return variant === 'bare-array' ? data.results : data;
      });
      const done = await f.run({ connectionId: f.one.id });
      assert.equal(done.processed, 21); assert.equal(done.failed, 10); assert.equal(done.updated, 11);
      assert.equal(f.source.requests.length, 3);
      assert.deepEqual(done.issues, [{ code: 'AI_INVALID_OUTPUT', count: 10 }]);
      const jobs = (await f.command('GET', `/jobs?connectionId=${f.one.id}&limit=100`)).items;
      for (const job of jobs) assert.equal(job.preferredTitleId, ids.indexOf(job.id) < 10 ? null : f.first.id);
      assert.equal((await f.command('GET', `/jobs/${foreign}`, undefined, 404)).error.code, 'NOT_FOUND');
      assert.ok(!JSON.stringify(f.source.logs).includes('Must not be accepted'));
    } finally { await f.close(); }
  });
}

test('UTF-8 input size splits requests before dispatch and preserves complete job context', async () => {
  const f = await recommendationFixture();
  try {
    const description = '汉'.repeat(40000), ids = [];
    for (let index = 0; index < 5; index++) ids.push(f.save(f.one, 'large-' + index, { details: { description: { text: description } } }));
    f.save(f.one, 'oversized', { details: { description: { text: 'x'.repeat(270000) } } });
    const done = await f.run({ connectionId: f.one.id });
    assert.equal(done.updated, 5); assert.equal(done.failed, 1);
    assert.deepEqual(done.issues, [{ code: 'INPUT_TOO_LARGE', count: 1 }]);
    assert.deepEqual(f.source.requests.map(request => classificationInput(request).jobs.length), [2, 2, 1]);
    for (const native of f.source.requests) {
      const { jobs, titles } = classificationInput(native);
      assert.ok(jobs.every(job => job.description === description));
      const request = classificationRequest({ model: { provider: 'openai', id: 'openai-fixture' }, prompt: 'Private rule: choose the best role.', titles },
        jobs.map(job => ({ id: job.jobId, title: job.title, company: job.company, details: { ...job, description: { text: job.description } } })));
      assert.ok(Buffer.byteLength(JSON.stringify(request)) <= INPUT_BYTES);
      assert.doesNotThrow(() => validateRequest(request, 'json'));
    }
    assert.deepEqual(f.source.requests.flatMap(request => classificationInput(request).jobs.map(job => job.jobId)), ids);
  } finally { await f.close(); }
});

test('empty or wholly ineligible sets complete without calling AI, and stale queued selections are omitted', async () => {
  const f = await recommendationFixture();
  try {
    const empty = await f.run({ q: 'absent' });
    assert.equal(empty.total, 0); assert.equal(empty.processed, 0);
    for (let index = 0; index < 12; index++) f.save(f.blank, 'blank-' + index);
    const skipped = await f.run({ connectionId: f.blank.id });
    assert.equal(skipped.skipped, 12); assert.equal(f.source.requests.length, 0);
    await f.app.recommendations.close();
    // A fresh coordinator claims only after this explicit manual change.
    const ids = Array.from({ length: 3 }, (_, index) => f.save(f.one, 'stale-' + index));
    const run = await f.start({ connectionId: f.one.id });
    await f.command('PATCH', `/jobs/${ids[0]}`, { preferredTitleId: f.second.id });
    const { RecommendationCoordinator } = await import('../src/service/recommendations.js');
    const coordinator = new RecommendationCoordinator(f.app.db, f.app.ai);
    try {
      await coordinator.start(); const done = await f.wait(run.id);
      assert.equal(done.skipped, 1); assert.equal(done.updated, 2);
      assert.deepEqual(classificationInput(f.source.requests[0]).jobs.map(job => job.jobId), ids.slice(1));
    } finally { await coordinator.close(); }
  } finally { await f.close(); }
});

test('manual edits and archived titles skip only affected results while other batch selections commit', async () => {
  const f = await recommendationFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const ids = Array.from({ length: 3 }, (_, index) => f.save(f.one, 'late-' + index));
    f.choose(async args => {
      const data = resultsFor(args, f.first.id);
      data.results[2].specializationId = f.second.id;
      await gate; return data;
    });
    await f.app.recommendations.start(); const run = await f.start({ connectionId: f.one.id });
    await f.source.waitFor(1);
    await f.command('PATCH', `/jobs/${ids[0]}`, { preferredTitleId: f.second.id });
    await f.command('PATCH', `/connections/${f.one.id}/titles/${f.first.id}`, { isArchived: true });
    release(); const done = await f.wait(run.id);
    assert.equal(done.skipped, 2); assert.equal(done.updated, 1); assert.equal(done.failed, 0);
    assert.equal((await f.command('GET', `/jobs/${ids[0]}`)).preferredTitleId, f.second.id);
    assert.equal((await f.command('GET', `/jobs/${ids[1]}`)).preferredTitleId, null);
    assert.equal((await f.command('GET', `/jobs/${ids[2]}`)).preferredTitleId, f.second.id);
  } finally { release(); await f.close(); }
});

test('a manual edit made during an earlier request omits that job from a later size-split request', async () => {
  const f = await recommendationFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const ids = Array.from({ length: 3 }, (_, index) => f.save(f.one, 'waiting-large-' + index,
      { details: { description: { text: '汉'.repeat(40000) } } }));
    let count = 0;
    f.choose(async args => { if (++count === 1) await gate; return resultsFor(args, f.first.id); });
    await f.app.recommendations.start(); const run = await f.start({ connectionId: f.one.id });
    await f.source.waitFor(1);
    await f.command('PATCH', `/jobs/${ids[2]}`, { preferredTitleId: f.second.id });
    release(); const done = await f.wait(run.id);
    assert.equal(done.updated, 2); assert.equal(done.skipped, 1); assert.equal(f.source.requests.length, 1);
    assert.equal((await f.command('GET', `/jobs/${ids[2]}`)).preferredTitleId, f.second.id);
  } finally { release(); await f.close(); }
});

test('mid-batch persistence failure rolls back every title, revision, item state and counter', async () => {
  const f = await recommendationFixture();
  try {
    const ids = Array.from({ length: 10 }, (_, index) => f.save(f.one, 'atomic-' + index));
    const run = await f.start({ connectionId: f.one.id }), store = new ServiceStore(f.config.dbPath);
    try {
      store.claimRecommendation();
      assert.throws(() => store.nextRecommendationBatch(f.users.alice.id, run.id), error => error.statusCode === 404);
      assert.throws(() => store.nextRecommendationBatch(f.users.admin.id, run.id, 11), /batch size/);
      const batch = store.nextRecommendationBatch(f.users.admin.id, run.id);
      assert.deepEqual(batch.map(job => job.id), ids);
      store.db.exec(`CREATE TRIGGER fail_batch BEFORE UPDATE OF preferred_title_id ON jobs WHEN NEW.id=${ids[5]} BEGIN SELECT RAISE(ABORT,'Fixture persistence failure'); END;`);
      assert.throws(() => store.finishRecommendationBatch(f.users.admin.id, run.id, ids.map(jobId => ({ jobId, specializationId: f.first.id }))), /Fixture persistence failure/);
      const progress = store.recommendation(f.users.admin.id, run.id);
      assert.equal(progress.updated, 0); assert.equal(progress.processed, 0);
      assert.ok(store.db.prepare('SELECT preferred_title_id,preferred_title_revision FROM jobs').all().every(job => job.preferred_title_id === null && job.preferred_title_revision === 0));
      assert.ok(store.db.prepare('SELECT status FROM ai_recommendation_jobs').all().every(item => item.status === 'working'));
    } finally { store.close(); }
  } finally { await f.close(); }
});

test('persistence failure terminates processing after one generation and never dispatches later batches', async () => {
  const f = await recommendationFixture();
  try {
    const ids = Array.from({ length: 21 }, (_, index) => f.save(f.one, 'failure-' + index));
    const store = new ServiceStore(f.config.dbPath);
    try { store.db.exec(`CREATE TRIGGER fail_batch BEFORE UPDATE OF preferred_title_id ON jobs WHEN NEW.id=${ids[5]} BEGIN SELECT RAISE(ABORT,'Fixture failure'); END;`); }
    finally { store.close(); }
    await f.app.recommendations.start(); const run = await f.start({ connectionId: f.one.id });
    const done = await f.wait(run.id, ['failed']);
    assert.equal(done.errorCode, 'RECOMMENDATION_ERROR'); assert.equal(done.updated, 0); assert.equal(done.failed, 10);
    assert.equal(f.source.requests.length, 1);
    assert.ok((await f.command('GET', `/jobs?connectionId=${f.one.id}&limit=100`)).items.every(job => job.preferredTitleId === null));
  } finally { await f.close(); }
});

test('Stop aborts a ten-job request without saving it or scheduling the remainder', async () => {
  const f = await recommendationFixture();
  try {
    Array.from({ length: 12 }, (_, index) => f.save(f.one, 'cancel-' + index));
    f.source.mode('openai', 'held'); await f.app.recommendations.start();
    const run = await f.start({ connectionId: f.one.id }); await f.source.waitFor(1);
    assert.equal(classificationInput(f.source.requests[0]).jobs.length, 10);
    assert.equal((await f.request('GET', '/health')).statusCode, 200);
    await f.command('GET', '/jobs');
    await f.command('POST', `/ai/recommendations/${run.id}/stop`);
    const done = await f.wait(run.id, ['stopped']);
    assert.equal(done.updated, 0); assert.equal(done.skipped, 10); assert.equal(done.processed, 10);
    assert.equal(f.source.requests.length, 1);
  } finally { await f.close(); }
});

test('malformed JSON rejects a complete batch and rate limits stop after the submitted batch', async () => {
  const f = await recommendationFixture();
  try {
    Array.from({ length: 12 }, (_, index) => f.save(f.one, 'error-' + index));
    f.source.mode('openai', 'invalid-json');
    const invalid = await f.run({ connectionId: f.one.id });
    assert.equal(invalid.failed, 12); assert.equal(invalid.updated, 0); assert.equal(f.source.requests.length, 2);
    f.source.mode('openai', 'http-429');
    await f.app.recommendations.start(); const run = await f.start({ connectionId: f.one.id });
    const failed = await f.wait(run.id, ['failed']);
    assert.equal(failed.errorCode, 'AI_RATE_LIMIT'); assert.equal(failed.failed, 10);
    assert.equal(f.source.requests.length, 3);
  } finally { await f.close(); }
});
