import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, safeUrl, accountKey } from '../src/core/security.js';

test('diagnostics redact nested credentials, tokens, emails, and known secret values', () => {
  const result = sanitize({ password: 'p', nested: [{ authorization: 'Bearer abc', title: 'my-secret', text: 'someone@example.com' }] }, ['my-secret']);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('my-secret'));
  assert.ok(!serialized.includes('someone@example.com'));
  assert.ok(!serialized.includes('Bearer abc'));
  assert.ok(!safeUrl('https://example.test/api?token=abc&page=1').includes('token=abc'));
  assert.equal(accountKey(' A@EXAMPLE.COM '), accountKey('a@example.com'));
});
test('plain-text HTTP errors redact cookies, authorization headers and query tokens', () => {
  const message = sanitize('Request failed\nCookie: session=private-cookie\nAuthorization: Basic private-auth\nhttps://example.test/?token=private-token&job=123');
  for (const secret of ['private-cookie','private-auth','private-token']) assert.ok(!message.includes(secret));
  assert.ok(message.includes('job=123'));
});

test('Playwright errors are stored without terminal escape sequences',()=>{
  assert.equal(sanitize('Call log: \u001b[2mwaiting for document\u001b[22m'),'Call log: waiting for document');
});
