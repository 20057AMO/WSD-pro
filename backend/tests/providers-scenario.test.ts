import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { signTestToken, API_URL } from './helpers.ts';

/**
 * ════════════════════════════════════════════════════════════════
 *  SCENARIO SUITE — Providers lock user journey (end-to-end)
 * ════════════════════════════════════════════════════════════════
 * Simulates the exact browser call sequence a real user produces:
 *
 *   A. First visit, no lock configured
 *      → page loads openly, welcome modal state (enabled=false)
 *   B. Settings: enable the lock (two-step flow)
 *      → wrong account password rejected, correct one enables
 *   C. Visit Providers while locked
 *      → management API locked (403), pickers stay open (200)
 *   D. Unlock journey on the page
 *      → wrong password 401 · correct password → 30-min token · works
 *   E. Change the lock password from Settings (re-auth)
 *      → old unlock tokens die instantly, new password unlocks
 *   F. Disable the lock entirely (re-auth)
 *      → page opens freely again
 *
 * Mutates users.json — run against an ISOLATED server only.
 * Self-skips unless WSD_TEST_ACCOUNT_PASSWORD is set.
 */
describe('Scenario: Providers lock journey', () => {

  const accountPassword = process.env.WSD_TEST_ACCOUNT_PASSWORD || '';
  const LOCK_V1 = `journey-${Date.now().toString(36)}-v1`;
  const LOCK_V2 = `${LOCK_V1}-v2`;

  // session state carried across steps like one real browser tab
  let auth = '';
  let unlockTokenV1 = '';
  let unlockTokenV2 = '';

  const h = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${auth || signTestToken()}`,
    ...extra,
  });

  after(async () => {
    if (!accountPassword) return;
    try {
      await fetch(`${API_URL}/auth/providers-password`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${signTestToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword }),
      });
    } catch { /* best-effort cleanup */ }
  });

  test('PRECONDITION: signed-in session exists', async (t) => {
    if (!accountPassword) return t.skip('WSD_TEST_ACCOUNT_PASSWORD not set');
    auth = signTestToken();
    const res = await fetch(`${API_URL}/providers-lock`, { headers: h() });
    assert.strictEqual(res.status, 200);
  });

  // ── Scenario A ────────────────────────────────────────────────
  describe('A · first visit — no lock configured', () => {
    test('page status reports enabled=false → welcome modal would show', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers-lock`, { headers: h() });
      const data = await res.json();
      assert.strictEqual(data.enabled, false, 'precondition: lock must be off');
    });

    test('management list opens without any unlock', async (t) => {
    if (!accountPassword) return t.skip('requires isolated server');
    void t;      const res = await fetch(`${API_URL}/providers`, { headers: h() });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray((await res.json()).providers));
    });
  });

  // ── Scenario B ────────────────────────────────────────────────
  describe('B · Settings: enable the lock', () => {
    test('missing account password → 400/401', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: LOCK_V1 }),
      });
      assert.ok([400, 401].includes(res.status));
    });

    test('wrong account password in ReAuth step → 401', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword: 'wrong-acct-pw', newPassword: LOCK_V1 }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('correct account password → lock enabled', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword, newPassword: LOCK_V1 }),
      });
      assert.strictEqual(res.status, 200);
      const check = await fetch(`${API_URL}/providers-lock`, { headers: h() });
      assert.strictEqual((await check.json()).enabled, true);
    });

    test('short providers password (<6) rejected by policy', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword, newPassword: 'abc1' }),
      });
      assert.strictEqual(res.status, 400);
    });
  });

  // ── Scenario C ────────────────────────────────────────────────
  describe('C · visiting Providers while locked', () => {
    test('status endpoint now says enabled=true → unlock modal would show', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers-lock`, { headers: h() });
      assert.strictEqual((await res.json()).enabled, true);
    });

    test('management list blocked with providers_locked', async (t) => {
    if (!accountPassword) return t.skip('requires isolated server');
    void t;      const res = await fetch(`${API_URL}/providers`, { headers: h() });
      assert.strictEqual(res.status, 403);
      assert.strictEqual((await res.json()).error, 'providers_locked');
    });

    test('create attempt also blocked', async (t) => {
    if (!accountPassword) return t.skip('requires isolated server');
    void t;      const res = await fetch(`${API_URL}/providers`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sneaky', host: 'https://x.invalid', type: 'openai' }),
      });
      assert.strictEqual(res.status, 403);
    });

    test('picker options stay reachable (Agents modal keeps working)', async () => {
      const res = await fetch(`${API_URL}/providers/options`, { headers: h() });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray((await res.json()).providers));
    });

    test('templates stay reachable', async () => {
      const res = await fetch(`${API_URL}/providers/templates`, { headers: h() });
      assert.strictEqual(res.status, 200);
    });
  });

  // ── Scenario D ────────────────────────────────────────────────
  describe('D · unlock journey on the page', () => {
    test('wrong providers password → 401 and no token issued', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers/unlock`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'not-the-lock-pw' }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('correct providers password → 30-minute scoped token', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers/unlock`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: LOCK_V1 }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.unlockToken);
      assert.strictEqual(data.expiresInSec, 1800, 'unlock must last exactly 30 minutes');
      unlockTokenV1 = data.unlockToken;
    });

    test('token unlocks management endpoints', async (t) => {
    if (!accountPassword) return t.skip('requires isolated server');
    void t;      const res = await fetch(`${API_URL}/providers`, {
        headers: h({ 'X-Providers-Unlock': unlockTokenV1 }),
      });
      assert.strictEqual(res.status, 200);
    });

    test('token does NOT authorize other sensitive ops (scoped)', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/logout-all`, {
        method: 'POST',
        headers: { ...h(), 'X-Providers-Unlock': unlockTokenV1, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword: LOCK_V1 }),
      });
      assert.strictEqual(res.status, 401, 'providers-unlock must never act as account re-auth');
    });
  });

  // ── Scenario E ────────────────────────────────────────────────
  describe('E · change the lock password (re-auth required)', () => {
    test('changing with wrong account password fails', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword: 'nope', newPassword: LOCK_V2 }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('changing with correct account password succeeds', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword, newPassword: LOCK_V2 }),
      });
      assert.strictEqual(res.status, 200);
    });

    test('old unlock token is dead instantly (version bump)', async (t) => {
    if (!accountPassword) return t.skip('requires isolated server');
    void t;      const res = await fetch(`${API_URL}/providers`, {
        headers: h({ 'X-Providers-Unlock': unlockTokenV1 }),
      });
      assert.strictEqual(res.status, 403);
    });

    test('old providers password no longer unlocks', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers/unlock`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: LOCK_V1 }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('new providers password unlocks; new token works', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers/unlock`, {
        method: 'POST',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: LOCK_V2 }),
      });
      assert.strictEqual(res.status, 200);
      unlockTokenV2 = (await res.json()).unlockToken;

      const list = await fetch(`${API_URL}/providers`, {
        headers: h({ 'X-Providers-Unlock': unlockTokenV2 }),
      });
      assert.strictEqual(list.status, 200);
    });

    test('audit trail recorded the lock changes', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/audit`, { headers: h() });
      const entries = (await res.json()).entries as Array<{ event: string }>;
      const lockEvents = entries.filter((e) => e.event === 'providers-lock-change');
      assert.ok(lockEvents.length >= 2, `expected ≥2 lock-change events, got ${lockEvents.length}`);
    });
  });

  // ── Scenario F ────────────────────────────────────────────────
  describe('F · disable the lock entirely', () => {
    test('disable requires account re-auth', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'DELETE',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword: 'wrong-again' }),
      });
      assert.strictEqual(res.status, 401);
    });

    test('correct re-auth disables → even the newest token becomes useless-but-page-open', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/auth/providers-password`, {
        method: 'DELETE',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword }),
      });
      assert.strictEqual(res.status, 200);

      const status = await fetch(`${API_URL}/providers-lock`, { headers: h() });
      assert.strictEqual((await status.json()).enabled, false);
    });

    test('management list opens again WITHOUT any unlock token', async (t) => {
    if (!accountPassword) return t.skip('requires isolated server');
    void t;      const res = await fetch(`${API_URL}/providers`, { headers: h() });
      assert.strictEqual(res.status, 200);
    });

    test('welcome-modal state returns (enabled=false)', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers-lock`, { headers: h() });
      assert.strictEqual((await res.json()).enabled, false);
    });
  });

});


