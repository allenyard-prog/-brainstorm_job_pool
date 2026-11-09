import { resolve } from 'node:path';
import { encryptionKey } from './crypto.js';

export function serviceConfig(overrides = {}) {
  const positive = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const config = {
    host: '127.0.0.1', port: positive('SERVICE_PORT', 3000),
    dataDir: resolve(process.env.DATA_DIR ?? 'data'), artifactsDir: resolve(process.env.ARTIFACTS_DIR ?? 'artifacts'),
    key: overrides.key ?? encryptionKey(process.env.SERVICE_ENCRYPTION_KEY), concurrency: positive('WORKER_CONCURRENCY', 2),
    tickMs: 500, stopGraceMs: 30000, staleMs: 30000, sessionMs: 86400000,
    secureCookies: false,
    workerSettings: { channel: process.env.BROWSER_CHANNEL, intervalMs: positive('JOB_INTERVAL_MS', 2000), pollMs: positive('EMPTY_POLL_MS', 30000), timeout: positive('NAVIGATION_TIMEOUT_MS', 30000) },
    ...overrides,
  };
  config.dbPath ??= resolve(config.dataDir, 'jobs.sqlite');
  config.origin ??= `http://${config.host}:${config.port}`;
  config.allowedOrigins ??= [config.origin];
  return config;
}
