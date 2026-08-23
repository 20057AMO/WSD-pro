import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { API_URL } from './helpers.ts';

/**
 * ════════════════════════════════════════════════════════════════
 *  PROVIDERS PAGE JOURNEY — gaps found by the live manual audit
 * ════════════════════════════════════════════════════════════════
 * Covers scenarios the other suites do NOT:
 *
 *   G1  create without key/host → structured `detection_required`
 *   G2  duplicate guards — same API key AND keyless same host+type
 *   G3  masked-key echo guard on POST and PUT (pure-bullet values)
 *   G4  chat/LLM area stays OPEN while the providers lock is ON
 *   G5  cross-session unlock-token replay rejected using REAL login
 *       tokens (login mints the jti that binds the unlock token)
 *   G6  progressive cooldown: once armed, even the CORRECT password
 *       gets 429 + Retry-After, and the event is audited
 *
 * Mutates users.json (lock on/off) → run against an ISOLATED server.
 * Self-skips unless WSD_TEST_ACCOUNT_PASSWORD is set.
 */

const accountPassword = process.env.WSD_TEST_ACCOUNT_PASSWORD || '';
const USERNAME = 'isolated';

let sessionA = ''; // real login token (carries jti)
let sessionB = '';
let ipBanned = false; // cooldown carries over in-memory between suite runs

/** Auth-scope calls share a 10/min budget across suites — wait out 429s. */
async function sensitive(url: string, init?: any): Promise<Response> {
  let res = await fetch(url, init);
  for (let guard = 0; res.status === 429 && guard < 4; guard += 1) {
    const ra = Number(res.headers.get('Retry-After')) || 60;
    await new Promise((r) => setTimeout(r, Math.min(ra, 65) * 1000));
    res = await fetch(url, init);
  }
  return res;
}

const h = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${sessionA}`,
  ...extra,
});

async function realLogin(password: string): Promise<string> {
  const res = await sensitive(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password }),
  });
  assert.strictEqual(res.status, 200, 'real login must succeed');
  const data = await res.json();
  assert.ok(data.token && !data.requires2fa, 'expected a direct session token');
  return data.token as string;
}

describe('Providers page journey — regression for live-audit gaps', () => {

  const KEY = `tstj-key-${Date.now().toString(36)}`;
  const LOCK_PW = `tstj-lock-${Date.now().toString(36)}`;
  const createdIds: string[] = [];

  after(async () => {
    if (!accountPassword) return;
    try {
      // remove every TSTJ provider (best effort, unlocked state assumed)
      const list = await fetch(`${API_URL}/providers`, { headers: h() });
      if (list.ok) {
        const { providers } = await list.json();
        for (const p of providers ?? []) {
          if (String(p.id).startsWith('tstj-')) {
            await fetch(`${API_URL}/providers/${p.id}`, { method: 'DELETE', headers: h() });
          }
        }
      }
      // restore open state
      await sensitive(`${API_URL}/auth/providers-password`, {
        method: 'DELETE',
        headers: { ...h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountPassword }),
      });
    } catch { /* best-effort */ }
  });

  test('PRECONDITION: account exists and two real logins succeed', async (t) => {
    if (!accountPassword || ipBanned) return t.skip('WSD_TEST_ACCOUNT_PASSWORD not set or cooldown ban active');
    const st = await fetch(`${API_URL}/auth/status`);
    const { hasUser } = await st.json();
    if (!hasUser) {
      const setup = await sensitive(`${API_URL}/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: accountPassword }),
      });
      assert.strictEqual(setup.status, 200, 'fresh isolated server needs the account');
    }
    sessionA = await realLogin(accountPassword);
    sessionB = await realLogin(accountPassword);
    assert.notStrictEqual(sessionA, sessionB, 'each login mints an independent session');

    // Canary: the 15-min unlock cooldown lives in server memory, so a ban
    // armed by an earlier run of this suite survives restarts of the TESTS
    // (not the server). Detect it up front and skip the lock sections —
    // restart the isolated server to re-run the full journey.
    const canary = await fetch(`${API_URL}/providers/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'canary' }),
    });
    if (canary.status === 429) ipBanned = true;
  });

  // ── G1 ────────────────────────────────────────────────────────
  describe('G1 · detection_required', () => {
    test('create without key and host returns structured guidance', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: 'tstj-g1', enabled: true }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'detection_required');
      assert.ok(Array.isArray(data.tried) && data.tried.length > 5, 'lists attempted services');
    });
  });

  // ── G2 ────────────────────────────────────────────────────────
  describe('G2 · duplicate guards', () => {
    test('same API key is rejected and names the existing provider', async (t) => {
      if (!accountPassword) return t.skip();
      const first = await fetch(`${API_URL}/providers`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: 'tstj-dup-first', host: 'https://api.openai.com/v1', type: 'openai', apiKey: KEY }),
      });
      assert.strictEqual(first.status, 201);
      createdIds.push('tstj-dup-first');

      const dup = await fetch(`${API_URL}/providers`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: 'tstj-dup-second', host: 'https://api.openai.com/v1', type: 'openai', apiKey: KEY }),
      });
      assert.strictEqual(dup.status, 409);
      assert.match((await dup.json()).error, /tstj-dup-first/);
      createdIds.push('tstj-dup-second');
    });

    test('keyless provider on an occupied host+type is rejected', async (t) => {
      if (!accountPassword) return t.skip();
      const body = { type: 'ollama', apiKey: '' };
      const a = await fetch(`${API_URL}/providers`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...body, name: 'tstj-keyless-a', host: 'http://localhost:11434' }),
      });
      assert.strictEqual(a.status, 201);
      createdIds.push('tstj-keyless-a');

      const b = await fetch(`${API_URL}/providers`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...body, name: 'tstj-keyless-b', host: 'http://localhost:11434' }),
      });
      assert.strictEqual(b.status, 409);
      createdIds.push('tstj-keyless-b');
    });
  });

  // ── G3 ────────────────────────────────────────────────────────
  describe('G3 · masked-key echo guard', () => {
    test('POST with pure bullets is rejected', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: 'tstj-echo-post', host: 'https://api.openai.com/v1', type: 'openai', apiKey: '\u2022\u2022\u2022\u2022' }),
      });
      assert.strictEqual(res.status, 400);
      assert.match((await res.json()).error, /masked/i);
    });

    test('PUT with pure bullets is rejected — real key survives', async (t) => {
      if (!accountPassword) return t.skip();
      const res = await fetch(`${API_URL}/providers/tstj-dup-first`, {
        method: 'PUT',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: 'tstj-dup-first', apiKey: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + KEY.slice(-4).replace(/[^\u2022]/g, '\u2022') }),
      });
      assert.strictEqual(res.status, 400);
      const meta = await (await fetch(`${API_URL}/providers`, { headers: h() })).json();
      const card = (meta.providers ?? []).find((p: any) => p.id === 'tstj-dup-first');
      assert.ok(card, 'provider still present');
      assert.strictEqual(card.apiKeyMasked.endsWith(KEY.slice(-4)), true, 'original key untouched');
    });
  });

  // ── Lock ON from here ─────────────────────────────────────────
  describe('enable lock', () => {
    test('two-step enable issues a session-bound unlock token', async (t) => {
      if (!accountPassword || ipBanned) return t.skip('no credentials or cooldown ban from an earlier run — restart isolated server');
      const res = await sensitive(`${API_URL}/auth/providers-password`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ accountPassword, newPassword: LOCK_PW }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.enabled, true);
      assert.strictEqual(data.expiresInSec, 1800);
      assert.ok(data.unlockToken, 'current session must stay open');
    });
  });

  // ── G4 ────────────────────────────────────────────────────────
  describe('G4 · chat stays open while locked', () => {
    test('chat sessions list/create/delete work without any unlock header', async (t) => {
      if (!accountPassword || ipBanned) return t.skip('no credentials or cooldown ban from an earlier run — restart isolated server');
      const list = await fetch(`${API_URL}/chat/sessions`, { headers: h() });
      assert.strictEqual(list.status, 200);

      const created = await fetch(`${API_URL}/chat/sessions`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: 'tstj-locked-chat' }),
      });
      assert.ok([200, 201].includes(created.status), `chat create got ${created.status}`);
      const chat = await created.json();

      const models = await fetch(`${API_URL}/chat/models`, { headers: h() });
      assert.strictEqual(models.status, 200);

      const id = chat.chatId ?? chat.id;
      if (id) {
        const del = await fetch(`${API_URL}/chat/sessions/${id}`, { method: 'DELETE', headers: h() });
        assert.ok(del.status === 200 || del.status === 404);
      }
    });
  });

  // ── G5 ────────────────────────────────────────────────────────
  describe('G5 · cross-session replay of REAL login tokens', () => {
    test('unlock token bound to session A is refused under session B', async (t) => {
      if (!accountPassword || ipBanned) return t.skip('no credentials or cooldown ban from an earlier run — restart isolated server');
      const un = await fetch(`${API_URL}/providers/unlock`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: LOCK_PW }),
      });
      assert.strictEqual(un.status, 200);
      const tokA = (await un.json()).unlockToken;

      const stolen = await fetch(`${API_URL}/providers`, {
        headers: { Authorization: `Bearer ${sessionB}`, 'X-Providers-Unlock': tokA },
      });
      assert.strictEqual(stolen.status, 403, 'replayed token must die outside its session');

      const own = await fetch(`${API_URL}/providers/unlock`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: LOCK_PW }),
      });
      assert.strictEqual(own.status, 200, 'B can unlock with its own session');

      const legit = await fetch(`${API_URL}/providers`, {
        headers: { Authorization: `Bearer ${sessionB}`, 'X-Providers-Unlock': (await own.json()).unlockToken },
      });
      assert.strictEqual(legit.status, 200);
    });
  });

  // ── G6 ────────────────────────────────────────────────────────
  describe('G6 · progressive cooldown arms on the 5th failure', () => {
    test('five wrong unlocks arm the ban; CORRECT password then gets 429 + Retry-After', async (t) => {
      if (!accountPassword || ipBanned) return t.skip('no credentials or cooldown ban from an earlier run — restart isolated server');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${API_URL}/providers/unlock`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionA}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: `wrong-${i}` }),
        });
        statuses.push(res.status);
      }
      assert.deepStrictEqual(statuses, [401, 401, 401, 401, 401]);

      const correctDuringBan = await fetch(`${API_URL}/providers/unlock`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: LOCK_PW }),
      });
      assert.strictEqual(correctDuringBan.status, 429, 'IP-based ban ignores password correctness');
      assert.ok(correctDuringBan.headers.get('retry-after'), 'Retry-After present');

      const audit = await (await fetch(`${API_URL}/auth/audit?limit=20`, { headers: h() })).json();
      assert.ok(
        (audit.entries ?? []).some((e: any) => e.event === 'providers-unlock-cooldown'),
        'cooldown must be audited'
      );
    });
  });

  // ── restore open state ────────────────────────────────────────
  describe('disable lock', () => {
    test('account re-auth turns the lock off', async (t) => {
      if (!accountPassword || ipBanned) return t.skip('no credentials or cooldown ban from an earlier run — restart isolated server');
      const res = await sensitive(`${API_URL}/auth/providers-password`, {
        method: 'DELETE',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ accountPassword }),
      });
      assert.strictEqual(res.status, 200);
      const lock = await (await fetch(`${API_URL}/providers-lock`, { headers: h() })).json();
      assert.strictEqual(lock.enabled, false);
    });
  });
});
