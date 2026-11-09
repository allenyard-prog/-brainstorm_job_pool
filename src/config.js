import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export function loadConfig(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    site: { type: 'string', default: 'jobright' }, transport: { type: 'string', default: 'browser' },
    headed: { type: 'boolean', default: false }, limit: { type: 'string' },
    'read-only': { type: 'boolean', default: false }, format: { type: 'string', default: 'json' },
    output: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  const command = positionals[0] ?? 'start';
  if (!['start', 'login', 'export', 'inspect', 'compare'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (!/^[a-z][a-z0-9-]*$/.test(values.site)) throw new Error('Invalid site ID.');
  if (!['browser', 'api'].includes(values.transport)) throw new Error('Transport must be browser or api.');
  const limit = values.limit == null ? Infinity : Number(values.limit);
  if (!(limit > 0) || (Number.isFinite(limit) && !Number.isInteger(limit))) throw new Error('Limit must be a positive integer.');
  const number = (key, fallback) => {
    const value = Number(process.env[key] ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
    return value;
  };
  return { command, site: values.site, transport: values.transport, headed: values.headed, limit, readOnly: values['read-only'],
    format: values.format, output: values.output, help: values.help,
    dataDir: resolve(process.env.DATA_DIR ?? 'data'), artifactsDir: resolve(process.env.ARTIFACTS_DIR ?? 'artifacts'),
    intervalMs: number('JOB_INTERVAL_MS', 2000), pollMs: number('EMPTY_POLL_MS', 30000), timeout: number('NAVIGATION_TIMEOUT_MS', 30000),
    credentials: { email: process.env[`${values.site.toUpperCase().replaceAll('-', '_')}_EMAIL`] ?? '', password: process.env[`${values.site.toUpperCase().replaceAll('-', '_')}_PASSWORD`] ?? '' },
  };
}
