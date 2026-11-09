import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './storage/database.js';
import { logger, accountKey, sanitize } from './core/security.js';
import { acquireLock } from './core/lock.js';
import { openBrowser } from './core/browser-manager.js';
import { NetworkRecorder } from './core/network-recorder.js';
import { loadPlugin } from './core/plugin-registry.js';
import { runJobs } from './core/runner.js';
import { compareJobs } from './core/compare.js';

async function main() {
  const config = loadConfig();
  if (config.help) {
    console.log('Commands: login, start, inspect, compare, export\nOptions: --site jobright --transport browser|api --headed --limit N --read-only --format json|csv --output PATH\nStop: Ctrl+C. API mode never silently falls back to scraping.');
    return;
  }
  const log = logger(Object.values(config.credentials));
  const store = new Store(join(config.dataDir, 'jobs.sqlite'));
  if (config.command === 'export') {
    try {
      if (!['json', 'csv'].includes(config.format)) throw new Error('Export format must be json or csv.');
      const jobs = store.jobs(config.site);
      let output = JSON.stringify(jobs, null, 2);
      if (config.format === 'csv') {
        const columns = ['site', 'source_job_id', 'url', 'title', 'company', 'first_seen_at', 'last_scraped_at', 'details', 'raw'];
        const quote = v => `"${String(typeof v === 'object' ? JSON.stringify(v) : v ?? '').replaceAll('"', '""')}"`;
        output = [columns.join(','), ...jobs.map(job => columns.map(key => quote(job[key])).join(','))].join('\r\n');
      }
      const path = resolve(config.output ?? join(config.dataDir, `jobs-${config.site}.${config.format}`));
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, output, { mode: 0o600 });
      log('exported', { count: jobs.length, path });
    } finally { store.close(); }
    return;
  }
  const account = accountKey(config.credentials.email);
  const controller = new AbortController();
  const stop = () => { log('stop_requested'); controller.abort(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let release, browser;
  try {
    if (!config.credentials.email || !config.credentials.password) throw new Error('Configure site EMAIL and PASSWORD in .env before login or execution.');
    release = await acquireLock(join(config.dataDir, 'locks', `${config.site}-${account}.lock`));
    const plugin = await loadPlugin(config.site, config.command === 'login' || config.command === 'inspect' ? 'browser' : config.transport, { write: config.command === 'start' && !config.readOnly });
    const directory = join(config.artifactsDir, `${config.site}-${account}`, new Date().toISOString().replaceAll(':', '-'));
    const recorder = new NetworkRecorder(directory, Object.values(config.credentials));
    browser = await openBrowser({ sessionPath: join(config.dataDir, 'sessions', `${config.site}-${account}.json`), headed: config.headed, timeout: config.timeout, recorder, channel: process.env.BROWSER_CHANNEL });
    const context = { ...browser, http: browser.context.request, recorder, credentials: config.credentials, config, log, signal: controller.signal, account };
    if (config.command === 'login') {
      await plugin.authenticate(context);
      log('login_succeeded');
    } else if (config.command === 'compare') {
      const browserPlugin = await loadPlugin(config.site, 'browser');
      const apiPlugin = await loadPlugin(config.site, 'api');
      await browserPlugin.authenticate(context);
      const jobs = await apiPlugin.listJobs(context);
      if (!jobs.length) throw new Error('No recommendation is available for comparison.');
      const candidate = jobs.find(job => job.raw?.jobResult?.jobLocations?.length > 1) ?? jobs[0];
      const apiJob = await apiPlugin.getJobDetails(context, candidate);
      const browserJob = await browserPlugin.getJobDetails(context, candidate);
      const comparison = compareJobs(browserJob, apiJob);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'comparison.json'), JSON.stringify(sanitize({ ...comparison, browser: browserJob, api: apiJob }, Object.values(config.credentials)), null, 2));
      log('transport_comparison', comparison);
      if (!comparison.matches) throw new Error(`Browser/API fields differ: ${comparison.differences.join(', ')}`);
    } else if (config.command === 'inspect') {
      await plugin.authenticate(context);
      const jobs = await plugin.listJobs(context, {});
      const job = jobs[0] ? await plugin.getJobDetails(context, jobs[0]) : null;
      await recorder.flush();
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'inspection.json'), JSON.stringify(sanitize({ jobs, job }, Object.values(config.credentials)), null, 2));
      log('inspection_saved', { count: jobs.length, directory });
    } else {
      await runJobs({ plugin, context, store, site: config.site, account, transport: config.transport, signal: controller.signal, limit: config.limit, intervalMs: config.intervalMs, pollMs: config.pollMs, readOnly: config.readOnly });
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { await browser?.close(); } finally {
      try { await release?.(); } finally { store.close(); }
    }
  }
}

main().catch(error => {
  logger([process.env.JOBRIGHT_EMAIL, process.env.JOBRIGHT_PASSWORD])('fatal', { type: error.constructor.name, message: error.message });
  process.exitCode = 1;
});
