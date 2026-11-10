import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

const sensitive = /password|passwd|secret|token|authorization|cookie|email|phone|resume|linkedin|user.?id|account|profile|session|credential|^user$|^impId$|^cursor$/i;
export const accountKey = email => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24);
export function sanitize(value, secrets = []) {
  if (Array.isArray(value)) return value.map(v => sanitize(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sensitive.test(key) ? '[REDACTED]' : sanitize(v, secrets)]));
  if (typeof value !== 'string') return value;
  let text = stripVTControlCharacters(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|set-cookie|x-[\w-]*token)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|session[_-]?token|token|password|passwd|secret)=([^\s&"'<>]+)/gi, '$1=[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
}
export function safeUrl(input) {
  const url = new URL(input);
  for (const key of url.searchParams.keys()) if (sensitive.test(key)) url.searchParams.set(key, '[REDACTED]');
  return url.toString();
}
export function logger(secrets = []) {
  return (event, fields = {}) => process.stderr.write(JSON.stringify(sanitize({ time: new Date().toISOString(), event, ...fields }, secrets)) + '\n');
}
