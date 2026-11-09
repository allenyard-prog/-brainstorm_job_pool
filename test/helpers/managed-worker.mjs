import { join } from 'node:path';
import { ServiceStore } from '../../src/storage/service-store.js';
import { acquireLock } from '../../src/core/lock.js';

let store, run, release, heartbeat, ended = false, mode;
async function finish(status) {
  if (ended) return; ended = true; clearInterval(heartbeat);
  store?.endRun(run.id, status);
  await release?.(); store?.close();
  if (process.connected) process.disconnect();
}
process.on('message', async message => {
  if (message.type === 'stop') { if (mode !== 'ignore-stop') await finish('stopped'); return; }
  if (message.type !== 'start') return;
  const payload = message.payload; run = payload.run; mode = payload.credentials.password;
  store = new ServiceStore(payload.dbPath, { connectionId: run.connection_id, userId: run.user_id });
  try { release = await acquireLock(join(payload.dataDir, 'locks', `${run.site}-${run.account_key}.lock`)); }
  catch { store.close(); process.send({ type: 'busy' }, () => process.disconnect()); return; }
  store.workerStarted(run.id);
  heartbeat = setInterval(() => store.progress(run.id, 'fixture_waiting', { saved: 0, confirmed: 0, failed: 0 }), 50);
  if (mode === 'crash') process.exit(2);
  if (mode === 'pending') {
    if (store.pending(run.site, run.account_key).length) { await finish('attention_required'); return; }
    const id = store.saveJob(run.site, run.account_key, { id: 'uncertain', url: 'https://fixture.test/job', title: 'Uncertain job', details: { description: { text: 'Persist before an uncertain update.' } } });
    store.transition(id, run.account_key, 'mark_pending');
    store.addEvent(run.id, 'simulated_external_write', {});
    process.exit(2);
  }
  if (mode === 'complete') {
    const id = store.saveJob(run.site, run.account_key, { id: 'fixture', url: 'https://fixture.test/job', title: 'Fixture Engineer', company: 'Fixture Corp', details: { description: { text: 'Long detail '.repeat(10000) }, extra: { password: 'should-not-leak' } }, raw: { sessionToken: 'should-not-leak', retained: true } });
    store.transition(id, run.account_key, 'mark_pending'); store.transition(id, run.account_key, 'mark_confirmed', 'applied');
    store.progress(run.id, 'completed', { saved: 1, confirmed: 1, failed: 0 });
    await finish('completed');
  }
});
process.on('disconnect', () => { if (!ended) finish('interrupted').catch(() => process.exit(1)); });
process.send({ type: 'ready' });
