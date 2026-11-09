import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitize, safeUrl } from './security.js';

export class NetworkRecorder {
  constructor(directory, secrets = []) {
    this.directory = directory;
    this.secrets = secrets;
    this.entries = [];
    this.pending = new Set();
    this.phase = { action: 'navigation', jobId: null };
    this.failure = null;
    this.writes = Promise.resolve();
  }
  action(action, jobId = null) { this.phase = { action, jobId }; }
  attach(context) {
    this.listener = response => {
      const request = response.request();
      const url = new URL(response.url());
      if (!(url.hostname === 'jobright.ai' || url.hostname.endsWith('.jobright.ai') || url.hostname === '127.0.0.1')) return;
      if (!['fetch', 'xhr'].includes(request.resourceType())) return;
      if (!/^\/swan\/(recommend\/|job\/|filter\/)/.test(url.pathname)) return;
      // Authentication payloads and responses never enter diagnostics.
      if (/login|signin|sign-in|signup|token|session|profile|resume|user\/info/i.test(url.pathname)) return;
      const phase = { ...this.phase };
      const work = this.record(response, phase).catch(error => { this.failure = error; }).finally(() => this.pending.delete(work));
      this.pending.add(work);
    };
    context.on('response', this.listener);
    this.context = context;
  }
  async record(response, phase) {
    const request = response.request();
    let body = null;
    try { body = request.postDataJSON(); } catch { /* Non-JSON request bodies are intentionally omitted. */ }
    let data = null;
    if ((response.headers()['content-type'] ?? '').includes('json')) {
      try { data = await response.json(); } catch { /* Failed requests may have no response body. */ }
    }
    const entry = sanitize({ time: new Date().toISOString(), ...phase, method: request.method(), url: safeUrl(response.url()), status: response.status(), request: body,
      response: phase.jobId || ['list', 'verify', 'mark'].includes(phase.action) || new URL(response.url()).pathname.includes('/recommend/list/jobs') ? data : null,
      requestHeaderNames: Object.keys(request.headers()), responseHeaderNames: Object.keys(response.headers()) }, this.secrets);
    await this.append(entry);
  }
  async append(entry) {
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.shift();
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(join(this.directory, 'network.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    });
    this.writes = write.catch(error => { this.failure = error; });
    await write;
  }
  async flush() { await Promise.all([...this.pending]); await this.writes; if (this.failure) throw this.failure; }
  async api(exchange) {
    const entry = sanitize({ time: new Date().toISOString(), ...this.phase, transport: 'api', ...exchange, url: safeUrl(exchange.url) }, this.secrets);
    await this.append(entry);
  }
  async close() {
    if (this.listener) this.context.off('response', this.listener);
    await this.flush();
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, 'endpoint-catalog.json'), JSON.stringify(this.entries.map(({ response, ...entry }) => ({ ...entry, responseKeys: response && typeof response === 'object' ? Object.keys(response) : [] })), null, 2), { mode: 0o600 });
  }
}
