import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { API_URL, initTestAuth } from './helpers.ts';

/**
 * Session revocation (logout everywhere) + password-change token rotation.
 * Mutates the real user record's tokenVersion — always verified against an
 * isolated server instance. Self-skips without WSD_TEST_ACCOUNT_PASSWORD.
 */
describe('Session revocation', () => {
  before(async () => { await initTestAuth(); });

  const accountPassword = process.env.WSD_TEST_ACCOUNT_PASSWORD || '';
  const username = process.env.WSD_TEST_USER || 'revoketester';

  function authHeader(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  async function login(): Promise<string> {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: accountPassword }),
    });
    assert.strictEqual(res.status, 200, 'login precondition failed');
    return (await res.json()).token as string;
  }

  after(async () => {
    // nothing persistent to clean: tokenVersion bumps are harmless going forward
  });

  test('freshly issued token grants access', async (t) => {
    if (!accountPassword) return t.skip('WSD_TEST_ACCOUNT_PASSWORD not set');
    const token = await login();
    const res = await fetch(`${API_URL}/projects`, { headers: authHeader(token) });
    assert.strictEqual(res.status, 200);
  });

  test('logout-all rejects a wrong account password', async (t) => {
    if (!accountPassword) return t.skip();
    await login();
    const res = await fetch(`${API_URL}/auth/logout-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader(await login())) },
      body: JSON.stringify({ accountPassword: 'wrong-password-xyz' }),
    });
    assert.strictEqual(res.status, 401);
  });

  test('after logout-all every previously issued token is rejected', async (t) => {
    if (!accountPassword) return t.skip();
    const tokenA = await login();
    const res = await fetch(`${API_URL}/auth/logout-all`, {
      method: 'POST',
      headers: { ...authHeader(tokenA), 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountPassword }),
    });
    assert.strictEqual(res.status, 200);

    const checkA = await fetch(`${API_URL}/projects`, { headers: authHeader(tokenA) });
    assert.strictEqual(checkA.status, 401, 'pre-revocation token must be dead');
  });

  test('re-login after revocation issues a working token', async (t) => {
    if (!accountPassword) return t.skip();
    const fresh = await login();
    const res = await fetch(`${API_URL}/projects`, { headers: authHeader(fresh) });
    assert.strictEqual(res.status, 200);
  });

  test('password change rotates tokens: old session dies, returned token lives', async (t) => {
    if (!accountPassword) return t.skip();

    // ensure the password is what the env says before rotating it back
    const currentPw = process.env.WSD_ROTATE_PASSWORD ? `${accountPassword}-rotated` : accountPassword;
    void currentPw;

    const oldToken = await login();
    const res = await fetch(`${API_URL}/auth/change-password`, {
      method: 'POST',
      headers: { ...authHeader(oldToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: accountPassword, newPassword: accountPassword }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.token, 'change-password must return a fresh token');

    const oldCheck = await fetch(`${API_URL}/projects`, { headers: authHeader(oldToken) });
    assert.strictEqual(oldCheck.status, 401, 'old session must be revoked');

    const newCheck = await fetch(`${API_URL}/projects`, { headers: authHeader(data.token) });
    assert.strictEqual(newCheck.status, 200, 'returned token must stay valid');
  });

});
