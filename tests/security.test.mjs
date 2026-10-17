import test from 'node:test';
import assert from 'node:assert/strict';
import { guardMutationRequest, readJsonObject, readFormDataLimited, RequestValidationError } from '../lib/security/request.ts';
import { normalizeNickname, validateSignup, validSigninInput } from '../lib/auth/validation.ts';
import { canChangeMemberRole, validRosterRows } from '../lib/auth/permissions.ts';
import { newSessionToken, hashSessionToken, sessionCookieOptions, SESSION_TOKEN_PATTERN } from '../lib/auth/tokens.ts';
import { validBootstrapToken } from '../lib/auth/bootstrap.ts';

const origin = 'https://centuri.example';
const jsonRequest = (body, headers = {}) => new Request(`${origin}/api/dkp`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body,
});

test('mutations reject cross-site, sibling-subdomain, null and prefix origins', () => {
  for (const supplied of ['https://attacker.example', 'https://sibling.centuri.example', 'null', `${origin}.attacker.example`]) {
    assert.equal(guardMutationRequest(jsonRequest('{}', { origin: supplied, 'sec-fetch-site': 'same-site' })).status, 403);
  }
  assert.equal(guardMutationRequest(jsonRequest('{}')), null);
});

test('missing origin requires same-origin browser metadata; forwarded host cannot authorize', () => {
  const request = new Request(`${origin}/api/dkp`, { method: 'POST', headers: { 'x-forwarded-host': 'attacker.example' } });
  assert.equal(guardMutationRequest(request).status, 403);
  assert.equal(guardMutationRequest(new Request(`${origin}/api/dkp`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })), null);
  assert.equal(guardMutationRequest(jsonRequest('{}', { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' })).status, 403);
});

test('canonical APP_ORIGIN supports reverse proxies without trusting request headers', () => {
  const previous = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = origin;
  try {
    assert.equal(guardMutationRequest(new Request('http://internal:3000/api/dkp', { method: 'POST', headers: { origin } })), null);
    assert.equal(guardMutationRequest(new Request('http://internal:3000/api/dkp', { method: 'POST', headers: { origin: 'http://internal:3000' } })).status, 403);
  } finally {
    if (previous === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous;
  }
});

test('JSON reader rejects malformed documents and non-object payloads', async () => {
  for (const body of ['{', 'null', '[]', '"string"', '1']) {
    await assert.rejects(readJsonObject(jsonRequest(body)), (error) => error instanceof RequestValidationError && error.status === 400);
  }
  assert.deepEqual(await readJsonObject(jsonRequest('{"action":"bid"}')), { action: 'bid' });
  await assert.rejects(readJsonObject(jsonRequest('{}', { 'content-type': 'text/plain' })), (error) => error.status === 415);
});

test('body size limit applies to declared and chunked bytes, including forged small content-length', async () => {
  await assert.rejects(readJsonObject(jsonRequest('{}', { 'content-length': '10000' }), { maxBytes: 64 }), (error) => error.status === 413);
  const bytes = new TextEncoder().encode(JSON.stringify({ oversized: 'x'.repeat(256) }));
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 20)); controller.enqueue(bytes.slice(20)); controller.close();
  } });
  const request = new Request(`${origin}/api/dkp`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': '2' }, body: stream, duplex: 'half' });
  await assert.rejects(readJsonObject(request, { maxBytes: 64 }), (error) => error.status === 413);
});

test('multipart parser validates type and enforces total encoded body limit', async () => {
  await assert.rejects(readFormDataLimited(jsonRequest('{}')), (error) => error.status === 415);
  const form = new FormData(); form.append('name', 'Loot'); form.append('images', new Blob(['x'.repeat(200)]), 'item.webp');
  await assert.rejects(readFormDataLimited(new Request(`${origin}/api/auction/items`, { method: 'POST', body: form }), 100), (error) => error.status === 413);
  const parsed = await readFormDataLimited(new Request(`${origin}/api/auction/items`, { method: 'POST', body: form }));
  assert.equal(parsed.get('name'), 'Loot');
});

test('authentication rejects query injection and bounds new passwords by UTF-8 bytes', () => {
  for (const value of [{ $ne: null }, ['Chief'], null, 3]) {
    assert.notEqual(validateSignup(value, 'password123'), null);
    assert.equal(validSigninInput(value, 'password123'), false);
  }
  assert.notEqual(validateSignup('Chief', { $ne: null }), null);
  assert.notEqual(validateSignup('Chief', 'short'), null);
  assert.equal(validateSignup('Chief', '😀'.repeat(18)), null);
  assert.notEqual(validateSignup('Chief', '😀'.repeat(19)), null);
  assert.notEqual(validateSignup('Chief', 'password\0hidden'), null);
  assert.equal(validSigninInput('Legacy member', 'old'), true);
  assert.equal(normalizeNickname('  ＣＨＩＥＦ '), 'chief');
});

test('role policy prevents self changes, privilege escalation, unknown roles and final-Chief demotion', () => {
  assert.equal(canChangeMemberRole('general', 'clansman', 'chief', false, 2), false);
  assert.equal(canChangeMemberRole('general', 'general', 'clansman', false, 2), false);
  assert.equal(canChangeMemberRole('guardian', 'clansman', 'guardian', false, 2), false);
  assert.equal(canChangeMemberRole('chief', 'general', 'clansman', true, 2), false);
  assert.equal(canChangeMemberRole('chief', 'chief', 'general', false, 1), false);
  assert.equal(canChangeMemberRole('chief', 'unknown', 'clansman', false, 2), false);
  assert.equal(canChangeMemberRole('chief', 'general', 'chief', false, 1), true);
  assert.equal(canChangeMemberRole('chief', 'chief', 'general', false, 2), true);
  assert.equal(canChangeMemberRole('general', 'clansman', 'guardian', false, 1), true);
  assert.equal(canChangeMemberRole('general', 'guardian', 'clansman', false, 1), true);
});

test('roster bounds reject duplicates, coercion and out-of-range selections', () => {
  for (const rows of [[], [3, 3], ['3'], [2], [1001], [3.5], null]) assert.equal(validRosterRows(rows), false);
  assert.equal(validRosterRows([3, 1000]), true);
});

test('session tokens are random 256-bit opaque values and persistence uses only a hash', () => {
  const tokens = new Set(Array.from({ length: 128 }, newSessionToken));
  assert.equal(tokens.size, 128);
  for (const token of tokens) {
    assert.match(token, SESSION_TOKEN_PATTERN);
    assert.equal(Buffer.from(token, 'base64url').byteLength, 32);
    assert.match(hashSessionToken(token), /^[a-f0-9]{64}$/);
    assert.notEqual(hashSessionToken(token), token);
  }
});

test('public signup cannot claim the first Chief without the private configured setup token', () => {
  const secret = 'test-only-bootstrap-value-with-strong-length-123456';
  assert.equal(validBootstrapToken(undefined, secret), false);
  assert.equal(validBootstrapToken(secret, undefined), false);
  assert.equal(validBootstrapToken('short', 'short'), false);
  assert.equal(validBootstrapToken({ $ne: null }, secret), false);
  assert.equal(validBootstrapToken(secret+'x', secret), false);
  assert.equal(validBootstrapToken(secret, secret), true);
});

test('production session cookie is host-bound and cannot be set by sibling subdomains', () => {
  assert.deepEqual(sessionCookieOptions(true), { name: '__Host-centuri-session', httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
  assert.equal(Object.hasOwn(sessionCookieOptions(true), 'domain'), false);
  assert.equal(sessionCookieOptions(false).name, 'centuri-session');
  assert.equal(sessionCookieOptions(false).secure, false);
});
