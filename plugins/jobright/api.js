import { authenticate, origin } from './auth.js';
import { request } from './http.js';
import { normalizeApiJob } from './normalize.js';
import { AuthenticationError, SystemicError, UnsupportedError, delay } from '../../src/core/errors.js';

async function read(context, path, options) {
  for (let attempt = 0; ; attempt++) {
    try { return await request(context, path, options); }
    catch (error) {
      if (error instanceof AuthenticationError || error instanceof UnsupportedError || error instanceof SystemicError || attempt >= 2 || context.signal?.aborted) throw error;
      await delay(500 * (attempt + 1), context.signal);
    }
  }
}

export default {
  authenticate,
  async listJobs(context, { excludeIds = [] } = {}) {
    context.recorder?.action('list');
    const excluded = new Set(excludeIds);
    const pages = new Set();
    for (let position = 0; ; position += 20) {
      const result = await read(context, '/swan/recommend/list/jobs', { params: { refresh: position === 0, sortCondition: 0, position, count: 20, syncRerank: false } });
      if (!Array.isArray(result?.jobList)) throw new UnsupportedError('Jobright recommendation response no longer contains jobList.');
      if (result.jobList.some(raw => !raw.jobResult?.jobId || !raw.jobResult?.jobTitle)) throw new UnsupportedError('Jobright recommendation job identity changed.');
      const jobs = result.jobList.map(raw => ({ id: String(raw.jobResult.jobId), url: `${origin(context)}/jobs/info/${raw.jobResult.jobId}`, raw }));
      if (jobs.some(job => !excluded.has(job.id))) return jobs;
      if (jobs.length < 20) return [];
      const signature = jobs.map(job => job.id).join(',');
      if (pages.has(signature)) throw new UnsupportedError('Jobright recommendation pagination did not advance.');
      pages.add(signature);
    }
  },
  async getJobDetails(context, job) {
    if (!job.raw?.jobResult) throw new UnsupportedError('The API job payload is missing.');
    context.recorder?.action('detail', job.id);
    return normalizeApiJob(job.raw, origin(context));
  },
  async markAsApplied(context, job) {
    context.recorder?.action('mark', job.id);
    const result = await request(context, '/swan/job/apply', { method: 'POST', data: { jobId: String(job.id), source: 0 } });
    if (result !== true) throw new UnsupportedError('Jobright did not return the captured successful application-status response.');
  },
  async getApplicationStatus(context, job) {
    context.recorder?.action('verify', job.id);
    let cursor = null;
    const cursors = new Set();
    try {
      while (!context.signal?.aborted) {
        const result = await read(context, '/swan/job/applied/jobs-v3', { method: 'POST', data: { cursor, pageSize: 20, applyStatus: 0 } });
        if (!Array.isArray(result?.list) || typeof result.hasMore !== 'boolean') throw new UnsupportedError('Jobright Applied-list response changed.');
        if (result.list.some(row => String(row.jobResult?.jobId) === String(job.id))) return 'applied';
        if (!result.hasMore) return 'unknown';
        if (!result.cursor || cursors.has(result.cursor)) throw new UnsupportedError('Jobright Applied-list cursor did not advance.');
        cursors.add(result.cursor); cursor = result.cursor;
      }
    } catch (error) { if (!context.signal?.aborted) throw error; }
    return 'unknown';
  },
};
