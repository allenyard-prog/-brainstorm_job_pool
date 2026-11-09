import { AuthenticationError, UnsupportedError, UncertainWriteError, SystemicError, delay } from './errors.js';
import { sanitize } from './security.js';

export async function runJobs({ plugin, context, store, site, account, transport, signal, limit = Infinity, intervalMs = 2000, pollMs = 30000, readOnly = false, runId = null, onProgress }) {
  let phase = 'authenticating';
  const log = (event, fields = {}) => {
    context.log?.(event, fields);
    phase = event;
    onProgress?.({ event, phase, counters: { ...counters }, fields: sanitize(fields, Object.values(context.credentials ?? {})) });
  };
  const safeMessage = message => sanitize(message, Object.values(context.credentials ?? {}));
  const counters = { saved: 0, confirmed: 0, failed: 0 };
  const run = runId ?? store.startRun(site, account, transport);
  const heartbeat = onProgress ? setInterval(() => onProgress({ event: 'heartbeat', phase, counters: { ...counters }, fields: {} }), 1000) : null;
  const skipped = new Set();
  let status = 'completed';
  let failure = null;
  async function verify(job) {
    return plugin.getApplicationStatus({ ...context, signal: AbortSignal.timeout(15000), deadline: Date.now() + 15000 }, job);
  }
  try {
    log('authenticating');
    await plugin.authenticate(context);
    for (const job of store.pending(site, account)) {
      if (signal?.aborted) break;
      const result = await verify(job);
      if (result === 'applied') store.transition(job.databaseId, account, 'mark_confirmed', 'applied');
      else if (result === 'not_applied') store.transition(job.databaseId, account, 'saved', 'not_applied');
      else throw new UncertainWriteError(`Cannot reconcile pending job ${job.id}; no new changes will be sent.`);
    }
    while (!signal?.aborted && counters.saved < limit) {
      log('listing_jobs');
      const jobs = await plugin.listJobs(context, { signal, excludeIds: [...skipped, ...store.confirmedIds(site, account)] });
      if (signal?.aborted) break;
      let candidate = null;
      for (const job of jobs) {
        const state = store.state(site, account, job.id);
        if (!skipped.has(String(job.id)) && state?.state !== 'mark_confirmed') { candidate = job; break; }
      }
      if (!candidate) { log('waiting_for_jobs', { pollMs }); await delay(pollMs, signal); continue; }
      const jobId = String(candidate.id);
      try {
        let job;
        for (let attempt = 0; attempt < 3; attempt++) {
          signal?.throwIfAborted();
          log('extracting_job', { jobId });
          try { job = await plugin.getJobDetails(context, candidate); break; }
          catch (error) {
            if (signal?.aborted || error instanceof AuthenticationError || error instanceof UnsupportedError || error instanceof SystemicError) throw error;
            if (attempt === 2) throw error;
            await delay(intervalMs * (attempt + 1), signal);
          }
        }
        if (String(job.id) !== jobId) throw new SystemicError('Detail identity does not match the selected job.');
        const databaseId = store.saveJob(site, account, job);
        counters.saved++;
        log('job_saved', { jobId, title: job.title });
        if (readOnly) { skipped.add(jobId); await delay(intervalMs, signal); continue; }
        if (signal?.aborted) break;
        store.transition(databaseId, account, 'mark_pending');
        log('marking_applied', { jobId });
        let writeError;
        try { await plugin.markAsApplied(context, job); } catch (error) { writeError = error; }
        let result = 'unknown';
        log('verifying_applied', { jobId });
        try { result = await verify(job); } catch (error) { writeError ??= error; }
        if (result === 'applied') {
          store.transition(databaseId, account, 'mark_confirmed', 'applied');
          counters.confirmed++;
          log('job_marked_applied', { jobId });
        } else {
          const message = safeMessage(writeError?.message ?? `Status after update: ${result}`);
          if (result === 'not_applied') store.transition(databaseId, account, 'saved', result, message);
          else store.transition(databaseId, account, 'mark_pending', null, message);
          throw new UncertainWriteError(`Job ${jobId}: ${message}. Runner paused; update was not retried.`);
        }
      } catch (error) {
        if (signal?.aborted && !(error instanceof UncertainWriteError)) break;
        if (error instanceof AuthenticationError || error instanceof UnsupportedError || error instanceof UncertainWriteError || error instanceof SystemicError) throw error;
        skipped.add(jobId);
        counters.failed++;
        log('job_failed', { jobId, message: error.message });
        if (counters.failed >= 3 && counters.saved === 0) throw new SystemicError('Three jobs failed before any successful extraction.');
      }
      await delay(intervalMs, signal);
    }
    if (signal?.aborted) status = 'stopped';
  } catch (error) {
    status = signal?.aborted && !(error instanceof UncertainWriteError) ? 'stopped' : error instanceof AuthenticationError || error instanceof UncertainWriteError ? 'attention_required' : 'failed';
    failure = status === 'stopped' ? null : error;
    log('runner_paused', { message: error.message });
  } finally {
    clearInterval(heartbeat);
    store.finishRun(run, status, counters, safeMessage(failure?.message));
    log('run_finished', { status, ...counters });
  }
  if (failure) throw failure;
  return counters;
}
