import { AuthenticationError, UnsupportedError, SystemicError } from '../../src/core/errors.js';
import { origin } from './auth.js';

export async function request(context, path, { method = 'GET', params, data } = {}) {
  context.signal?.throwIfAborted();
  const url = new URL(path, origin(context));
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  const response = await context.http.fetch(url.toString(), {
    method, ...(data === undefined ? {} : { data }),
    headers: { accept: 'application/json', origin: origin(context), referer: `${origin(context)}/jobs/recommend` },
    timeout: Math.max(1, Math.min(15000, (context.deadline ?? (Date.now() + 15000)) - Date.now())), maxRetries: 0,
  });
  try {
    const status = response.status();
    if ([401, 403].includes(status)) throw new AuthenticationError(`Jobright authentication rejected (${status}).`);
    if (status === 429) throw new SystemicError('Jobright rate limit reached. Runner paused.');
    if (!response.ok()) throw new Error(`Jobright API ${url.pathname} returned HTTP ${status}.`);
    let body;
    try { body = await response.json(); } catch { throw new UnsupportedError(`Jobright API ${url.pathname} no longer returns JSON.`); }
    if (body.success !== true) {
      if (/login|auth|sign.?in|session|expired/i.test(String(body.errorMsg))) throw new AuthenticationError('Jobright session expired.');
      throw new UnsupportedError(`Jobright API ${url.pathname} rejected the operation (code ${body.errorCode}).`);
    }
    await context.recorder?.api({ method, url: url.toString(), status, request: data ?? null, response: body });
    return body.result;
  } finally { await response.dispose(); }
}
