import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { id: { type: 'string' } } });
const id = values.id;
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Supply --id with lowercase letters, numbers and hyphens.');
const directory = resolve('plugins', id);
await mkdir(directory);
const implementation = `import { UnsupportedError } from '../../src/core/errors.js';

export default {
  async authenticate(context) { throw new UnsupportedError('Implement ${id} authentication.'); },
  async listJobs(context, { excludeIds = [] } = {}) { throw new UnsupportedError('Implement ${id} job listing.'); },
  async getJobDetails(context, job) { throw new UnsupportedError('Implement ${id} detail extraction.'); },
  async markAsApplied(context, job) { throw new UnsupportedError('${id} status updates are not implemented.'); },
  async getApplicationStatus(context, job) { return 'unknown'; },
};
`;
await writeFile(join(directory, 'browser.js'), implementation);
await writeFile(join(directory, 'index.js'), `import browser from './browser.js';
export default {
  id: '${id}', name: '${id}',
  capabilities: { transports: ['browser'], authentication: 'browser', operations: ['listJobs', 'getJobDetails'] },
  transports: { browser },
};
`);
console.log(`Created plugins/${id}. Add ${id.toUpperCase().replaceAll('-', '_')}_EMAIL and _PASSWORD to your local .env. See README.md for the plugin contract.`);
