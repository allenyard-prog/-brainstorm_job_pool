import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs, parseEnv } from 'node:util';
import { appendFile, mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ServiceStore } from '../src/storage/service-store.js';
import { encryptionKey, hashPassword, encryptCredentials, verifyPassword } from '../src/service/crypto.js';
import { accountKey } from '../src/core/security.js';
import { acquireLock } from '../src/core/lock.js';

async function hiddenPassword(prompt) {
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or set SERVICE_ADMIN_PASSWORD for unattended initialization.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  try {
    return await new Promise((resolvePassword, reject) => {
      let password = '';
      const onData = chunk => {
        for (const character of chunk) {
          if (character === '\r' || character === '\n') { process.stdin.off('data', onData); process.stdout.write('\n'); resolvePassword(password); return; }
          if (character === '\u0003') { process.stdin.off('data', onData); reject(new Error('Initialization cancelled.')); return; }
          if (character === '\u007f' || character === '\b') password = password.slice(0, -1); else password += character;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); }
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, 'import-legacy': { type: 'boolean', default: false } } });
  let email = values.email;
  if (!email) { const reader = createInterface({ input: process.stdin, output: process.stdout }); try { email = await reader.question('Administrator email: '); } finally { reader.close(); } }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '')) throw new Error('Enter a valid administrator email.');
  const password = process.env.SERVICE_ADMIN_PASSWORD ?? await hiddenPassword('Administrator password (at least 12 characters): ');
  if (password.length < 12 || password.length > 256) throw new Error('Administrator password must contain 12 to 256 characters.');
  if (!process.env.SERVICE_ADMIN_PASSWORD && password !== await hiddenPassword('Confirm administrator password: ')) throw new Error('Passwords do not match.');
  const dataDir = resolve(process.env.DATA_DIR ?? 'data');
  const release = await acquireLock(join(dataDir, 'service.lock'));
  let store;
  try {
    store = new ServiceStore(join(dataDir, 'jobs.sqlite'));
    if (!process.env.SERVICE_ENCRYPTION_KEY) {
      try { process.env.SERVICE_ENCRYPTION_KEY = parseEnv(await readFile(resolve('.env'), 'utf8')).SERVICE_ENCRYPTION_KEY ?? ''; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!process.env.SERVICE_ENCRYPTION_KEY) {
      if (store.db.prepare('SELECT count(*) AS n FROM connections').get().n) throw new Error('Restore the original SERVICE_ENCRYPTION_KEY before initializing an existing encrypted database.');
      const key = randomBytes(32).toString('hex');
      await appendFile(resolve('.env'), `\nSERVICE_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
      process.env.SERVICE_ENCRYPTION_KEY = key;
    }
    const key = encryptionKey(process.env.SERVICE_ENCRYPTION_KEY);
    const existing = store.findUser(email);
    let user;
    if (existing && values['import-legacy'] && existing.role === 'admin' && await verifyPassword(password, existing.password_hash)) user = existing;
    else user = store.createUser({ email, passwordHash: await hashPassword(password), role: 'admin', bootstrap: true });
    if (values['import-legacy']) {
      const imports = [];
      for (const site of await readdir(resolve('plugins'))) {
        if (!/^[a-z][a-z0-9-]*$/.test(site)) continue;
        const prefix = site.toUpperCase().replaceAll('-', '_');
        const credentials = { email: process.env[`${prefix}_EMAIL`], password: process.env[`${prefix}_PASSWORD`] };
        if (!credentials.email || !credentials.password) continue;
        const account = accountKey(credentials.email);
        imports.push({ site, accountKey: account, label: credentials.email, encryptedCredentials: encryptCredentials(credentials, key, `${user.id}:${site}:${account}`) });
      }
      for (const connection of store.claimLegacy(user.id, imports)) {
        const destination = join(dataDir, 'sessions', user.id, connection.id);
        await mkdir(destination, { recursive: true });
        try { await copyFile(join(dataDir, 'sessions', `${connection.site}-${connection.accountKey}.json`), join(destination, 'session.json')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    console.log('Administrator created. Start the backend with npm run service.');
  } finally { store?.close(); await release(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
