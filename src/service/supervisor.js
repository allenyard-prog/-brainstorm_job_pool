import { fork, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decryptCredentials } from './crypto.js';

export class Supervisor {
  constructor(db, config) { this.db = db; this.config = config; this.id = randomUUID(); this.children = new Map(); this.closing = false; this.ticking = false; this.lastError = null; }
  async start() {
    await this.db.call('recover');
    this.timer = setInterval(() => this.tick().catch(error => { this.lastError = error; }), this.config.tickMs);
    await this.tick();
  }
  async tick() {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      for (const [id, entry] of this.children) {
        const state = await this.db.call('control', id);
        if (state?.status === 'stop_requested') this.cancel(id);
        if (state?.heartbeat_at && Date.now() - Date.parse(state.heartbeat_at) > this.config.staleMs && ['starting','running'].includes(state.status)) {
          entry.interrupted = true; await this.kill(id);
        }
      }
      while (!this.closing && this.children.size < this.config.concurrency) {
        const run = await this.db.call('claim', this.id, this.config.concurrency);
        if (!run) break;
        try { await this.launch(run); }
        catch (error) { await this.db.call('endRun', run.id, 'failed', 'Unable to start worker.', 'WORKER_START_FAILED'); this.lastError = error; }
      }
    } finally { this.ticking = false; }
  }
  async launch(run) {
    const credentials = decryptCredentials(run.encrypted_credentials, this.config.key, `${run.user_id}:${run.site}:${run.account_key}`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|PLAYWRIGHT_BROWSERS_PATH|LOCALAPPDATA|APPDATA|USERPROFILE)$/i.test(key)));
    const child = fork(this.config.workerModule ?? fileURLToPath(new URL('./worker.js', import.meta.url)), [], { env, execArgv: [], windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','ignore','ignore','ipc'] });
    const entry = { child, ready: false, busy: false, forced: false, interrupted: false, credentials, exit: null };
    this.children.set(run.id, entry);
    entry.exit = new Promise(resolve => {
      const finished = () => {
        if (entry.exited) return;
        entry.exited = true;
        clearTimeout(entry.stopTimer);
        this.children.delete(run.id);
        const update = entry.busy ? this.db.call('defer', run.id) : this.db.call('endRun', run.id, entry.forced ? 'stopped' : 'interrupted', entry.forced ? 'Worker exceeded the stop allowance.' : 'Worker exited unexpectedly.', entry.forced ? 'FORCED_STOP' : 'WORKER_INTERRUPTED', entry.forced);
        update.catch(error => { this.lastError = error; }).finally(resolve);
      };
      child.once('exit', finished);
      child.once('close', finished);
    });
    child.on('error', error => { this.lastError = error; });
    child.on('message', message => {
      if (message.type === 'ready') {
        entry.ready = true;
        child.send({ type: 'start', payload: { run, credentials, dbPath: this.config.dbPath, dataDir: this.config.dataDir, artifactsDir: this.config.artifactsDir, settings: this.config.workerSettings } }, error => { if (error) this.lastError = error; });
        if (entry.cancelled) this.cancel(run.id);
      }
      if (message.type === 'busy') entry.busy = true;
    });
    if (!Number.isInteger(child.pid)) throw new Error('Worker process could not be spawned.');
    await this.db.call('workerPid', run.id, this.id, child.pid);
  }
  cancel(id) {
    const entry = this.children.get(id);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.ready && entry.child.connected) entry.child.send({ type: 'stop' }, () => {});
    entry.stopTimer ??= setTimeout(() => this.kill(id).catch(error => { this.lastError = error; }), this.config.stopGraceMs);
  }
  async kill(id) {
    const entry = this.children.get(id);
    if (!entry || entry.child.exitCode !== null || !entry.child.pid) return;
    entry.forced = !entry.interrupted;
    const pid = entry.child.pid; // Only process handles spawned and retained by this supervisor are eligible.
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && entry.child.exitCode === null) reject(error); else resolve();
      }));
    } else { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  async close() {
    this.closing = true; clearInterval(this.timer);
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 10));
    // Cancellation must still work if the API's database thread has failed.
    for (const [id] of this.children) this.cancel(id);
    await Promise.all([...this.children.values()].map(entry => entry.exit));
  }
}
