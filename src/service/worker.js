import { join } from 'node:path';
import { ServiceStore } from '../storage/service-store.js';
import { acquireLock } from '../core/lock.js';
import { openBrowser } from '../core/browser-manager.js';
import { NetworkRecorder } from '../core/network-recorder.js';
import { loadPlugin } from '../core/plugin-registry.js';
import { runJobs } from '../core/runner.js';
import { AuthenticationError, UncertainWriteError } from '../core/errors.js';
import { sanitize } from '../core/security.js';

const controller = new AbortController();
let browser, orphanTimer, orphaned = false, finishing = false;
process.on('message', message => { if (message.type === 'stop') controller.abort(); });
process.on('disconnect', () => {
  if (finishing) return;
  orphaned = true;
  controller.abort();
  orphanTimer = setTimeout(async () => { await Promise.race([browser?.close(), new Promise(resolve => setTimeout(resolve, 2000))]).catch(() => {}); process.exit(1); }, 30000);
  orphanTimer.unref();
});
process.once('message', message => { if (message.type === 'start') execute(message.payload).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); }); });
process.send?.({ type: 'ready' });

async function execute(payload) {
  const { run, credentials, dbPath, dataDir, artifactsDir, settings } = payload;
  const store = new ServiceStore(dbPath, { connectionId: run.connection_id, userId: run.user_id });
  const safe = value => sanitize(value, Object.values(credentials));
  let release, busy = false, heartbeat;
  const progress = ({ event, phase, counters, fields }) => {
    store.progress(run.id, phase, counters);
    if (event !== 'heartbeat') store.addEvent(run.id, event, safe(fields));
    if (!['starting','running'].includes(store.control(run.id)?.status)) controller.abort();
  };
  try {
    try { release = await acquireLock(join(dataDir, 'locks', `${run.site}-${run.account_key}.lock`)); }
    catch (error) {
      if (error.message.includes('Another runner')) { busy = true; process.send?.({ type: 'busy' }); return; }
      throw error;
    }
    if (store.control(run.id)?.status === 'stop_requested') controller.abort();
    controller.signal.throwIfAborted();
    store.workerStarted(run.id);
    const counters = { saved: 0, confirmed: 0, failed: 0 };
    heartbeat = setInterval(() => {
      const state = store.control(run.id);
      if (!['starting','running'].includes(state?.status)) controller.abort();
      // Collection progress is maintained by the runner; authentication also needs a heartbeat.
      if (run.kind === 'authentication') store.progress(run.id, 'authenticating', counters);
    }, 1000);
    const plugin = await loadPlugin(run.site, run.transport, { write: run.kind === 'collection' && !JSON.parse(run.options_json).readOnly });
    const recorder = new NetworkRecorder(join(artifactsDir, run.user_id, run.connection_id, run.id), Object.values(credentials));
    browser = await openBrowser({ sessionPath: join(dataDir, 'sessions', run.user_id, run.connection_id, 'session.json'), headed: run.kind === 'authentication' && !!JSON.parse(run.options_json).headed, timeout: settings.timeout, recorder, channel: settings.channel });
    const context = { ...browser, http: browser.context.request, recorder, credentials,
      config: { ...settings }, signal: controller.signal, account: run.account_key,
      log: () => {},
    };
    if (run.kind === 'authentication') {
      store.connectionStatus(run.connection_id, 'authenticating');
      await plugin.authenticate(context);
      store.connectionStatus(run.connection_id, 'ready');
      store.endRun(run.id, controller.signal.aborted ? 'stopped' : 'completed');
    } else {
      const originalAuthenticate = plugin.authenticate;
      const wrapped = { ...plugin, authenticate: async ctx => { await originalAuthenticate(ctx); store.connectionStatus(run.connection_id, 'ready'); } };
      const options = JSON.parse(run.options_json);
      await runJobs({ plugin: wrapped, context, store, site: run.site, account: run.account_key, transport: run.transport,
        signal: controller.signal, runId: run.id, limit: options.limit ?? Infinity, readOnly: options.readOnly,
        intervalMs: settings.intervalMs, pollMs: settings.pollMs, onProgress: progress });
    }
  } catch (error) {
    const attention = error instanceof AuthenticationError || error instanceof UncertainWriteError;
    if (error instanceof AuthenticationError) store.connectionStatus(run.connection_id, 'attention_required');
    store.endRun(run.id, controller.signal.aborted && !attention ? 'stopped' : attention ? 'attention_required' : 'failed', safe(error.message), error.constructor.name);
    store.addEvent(run.id, 'worker_error', { message: safe(error.message) });
  } finally {
    clearInterval(heartbeat); clearTimeout(orphanTimer);
    try { await browser?.close(); }
    catch (error) { store.addEvent(run.id, 'cleanup_error', { message: safe(error.message) }); }
    finally {
      try {
        if (orphaned) {
          const changed = store.db.prepare("UPDATE runs SET status='interrupted',ended_at=?,error='Worker lost its supervisor.',error_code='SUPERVISOR_DISCONNECTED' WHERE id=? AND (status IN ('starting','running') OR (status='stopped' AND stop_requested_at IS NULL))").run(new Date().toISOString(), run.id);
          if (changed.changes) store.addEvent(run.id, 'interrupted', { errorCode: 'SUPERVISOR_DISCONNECTED' });
        }
        await release?.();
      } finally { store.close(); }
    }
    finishing = true;
    if (process.connected) process.send({ type: 'finished', busy }, () => process.disconnect());
  }
}
