import { randomBytes, scrypt, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, parameters);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [, salt, digest] = (encoded ?? '').split('$');
  // Unknown users still perform the same expensive derivation.
  const key = await derive(password, salt ?? '00000000000000000000000000000000', 64, parameters);
  const expected = Buffer.from(digest ?? '00'.repeat(64), 'hex');
  return !!digest && expected.length === key.length && timingSafeEqual(expected, key);
}
export function encryptionKey(value) {
  if (!/^[a-fA-F0-9]{64}$/.test(value ?? '')) throw new Error('SERVICE_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters. Run service:init first.');
  return Buffer.from(value, 'hex');
}
export function encryptCredentials(credentials, key, owner = '') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(owner));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: ciphertext.toString('hex') });
}
export function decryptCredentials(encoded, key, owner = '') {
  const envelope = JSON.parse(encoded);
  if (envelope.v !== 1) throw new Error('Unsupported credentials envelope.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()]).toString('utf8'));
}
export function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|authorization|cookie|credential|session/i.test(key) ? '[REDACTED]' : scrubSecrets(item)]));
}
