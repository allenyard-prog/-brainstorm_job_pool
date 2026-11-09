import { Worker } from 'node:worker_threads';

export class AsyncStore {
  constructor(path) {
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.worker = new Worker(new URL('./db-worker.js', import.meta.url), { workerData: { path } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', message => {
        if (message.ready) { resolve(); return; }
        const pending = this.pending.get(message.id);
        if (!pending) return; this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error)); else pending.resolve(message.result);
      });
      this.worker.on('error', error => { reject(error); this.fail(error); });
      this.worker.on('exit', code => { const error = new Error(`Database worker exited (${code}).`); reject(error); this.fail(error); });
    });
  }
  fail(error) { this.closed = true; for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  async call(method, ...args) {
    await this.ready;
    if (this.closed) throw new Error('Database worker is unavailable.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, args }); });
  }
  async close() { this.closed = true; await this.worker.terminate(); }
}
