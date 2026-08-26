import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { API_URL, JWT_SECRET, signTestToken, authHeaders, req, reqAuth, initTestAuth } from './helpers.ts';

describe('Auth & access control', () => {
  before(async () => { await initTestAuth(); });

  test('GET /auth/status is public and reports hasUser', async () => {
    const res = await req('GET', '/auth/status');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.hasUser, 'boolean');
  });

  test('protected endpoints reject requests without a token', async () => {
    for (const path of ['/projects', '/providers', '/agents', '/server/info']) {
      const res = await req('GET', path);
      assert.strictEqual(res.status, 401, `expected 401 for ${path}, got ${res.status}`);
    }
  });

  test('login rejects wrong credentials with 401', async () => {
    const res = await req('POST', '/auth/login', { username: 'no-such-user-xyz', password: 'wrong-pass' });
    assert.strictEqual(res.status, 401);
  });

  test('tokens signed with the wrong secret are rejected', async () => {
    const forged = jwt.sign({ id: 'attacker', username: 'attacker' }, 'completely-wrong-secret', { expiresIn: '1h' });
    const res = await fetch(`${API_URL}/projects`, { headers: { Authorization: `Bearer ${forged}` } });
    assert.strictEqual(res.status, 401);
  });

  test('tampered token signatures are rejected', async () => {
    const valid = signTestToken();
    const tampered = valid.slice(0, -3) + (valid.endsWith('aaa') ? 'bbb' : 'aaa');
    const res = await fetch(`${API_URL}/projects`, { headers: { Authorization: `Bearer ${tampered}` } });
    assert.strictEqual(res.status, 401);
  });

  test('expired tokens are rejected', async () => {
    const expired = jwt.sign({ id: 'test-user', username: 'test' }, JWT_SECRET, { expiresIn: '-10s' });
    const res = await fetch(`${API_URL}/projects`, { headers: { Authorization: `Bearer ${expired}` } });
    assert.strictEqual(res.status, 401);
  });

  test('a correctly signed token grants access', async () => {
    const res = await reqAuth('GET', '/projects');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects));
  });

  test('audit log endpoint returns entries array (newest first)', async () => {
    // generate one real event so the log is non-deterministically empty-safe
    await req('POST', '/auth/login', { username: 'no-such-user-xyz', password: 'x' });
    const res = await reqAuth('GET', '/auth/audit');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.entries));
    if (data.entries.length > 1) {
      assert.ok(
        new Date(data.entries[0].ts).getTime() >= new Date(data.entries[data.entries.length - 1].ts).getTime(),
        'entries must be newest-first'
      );
    }
  });

  test('setup refuses to run when a user already exists', async () => {
    const statusRes = await req('GET', '/auth/status');
    const { hasUser } = await statusRes.json();
    if (!hasUser) return; // nothing to verify on a fresh install
    const res = await req('POST', '/auth/setup', { username: 'hijacker', password: 'pass1234' });
    assert.ok([400, 403, 409].includes(res.status), `expected rejection, got ${res.status}`);
  });

  test('optional real login works when WSD_TEST_USER/WSD_TEST_PASS are set', async (t) => {
    const user = process.env.WSD_TEST_USER;
    const pass = process.env.WSD_TEST_PASS;
    if (!user || !pass) return t.skip('WSD_TEST_USER / WSD_TEST_PASS not set');
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.token, 'login response must include a token');
  });

});
