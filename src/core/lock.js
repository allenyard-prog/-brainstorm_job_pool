import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await file.close(); }
      return async () => {
        let current;
        try { current = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (current.token === token) await unlink(path);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new Error('Another runner is initializing or holds an unreadable account lock.'); }
      try { process.kill(previous.pid, 0); } catch (check) {
        if (check.code === 'ESRCH') { await unlink(path); continue; }
        throw check;
      }
      throw new Error('Another runner already holds the account lock.');
    }
  }
  throw new Error('Unable to acquire runner lock.');
}
