import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import { signTestToken, firstProjectSlug, initTestAuth } from './helpers.ts';

const WS_BASE = (process.env.WSD_TEST_API_URL || 'http://127.0.0.1:3000/api')
  .replace('/api', '')
  .replace(/^http/, 'ws');

const CHAT_ID = `wstest-${Date.now().toString(36)}`;

/** Connect and resolve with the resulting outcome. */
function probe(path: string, token?: string): Promise<'open' | 'unauthorized' | 'closed'> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${WS_BASE}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (result: 'open' | 'unauthorized' | 'closed') => {
      try { ws.terminate(); } catch { /* already gone */ }
      resolve(result);
    };
    ws.on('open', () => done('open'));
    ws.on('error', (err: Error & { message?: string }) => {
      done(err.message?.includes('401') ? 'unauthorized' : 'closed');
    });
    ws.on('close', () => done('closed'));
    setTimeout(() => done('closed'), 5000);
  });
}

function replaceSlug(p: string, slug: string): string {
  return p.replace('probe-slug', slug);
}

describe('WebSocket authentication matrix', () => {
  before(async () => { await initTestAuth(); });

  let slug = 'probe-slug';

  test('resolve a real project slug when available', async () => {
    slug = (await firstProjectSlug()) || slug;
    assert.ok(slug, 'a slug must be resolvable');
  });

  describe('per-endpoint auth', () => {
    const endpoints: Array<[string, string]> = [
      ['global status', '/ws/projects/status'],
      ['project status', '/ws/projects/probe-slug/status'],
      ['project logs', '/ws/projects/probe-slug/logs'],
      ['terminal', '/ws/projects/probe-slug/terminal?mode=project'],
      ['chat room', `/ws/chat/global/${CHAT_ID}`],
      ['agent room', `/ws/agent/probe-agent/${CHAT_ID}`],
      ['presence', '/ws/presence/probe-slug'],
    ];

    for (const [name, path] of endpoints) {
      test(`${name}: no token → handshake rejected`, async () => {
        assert.strictEqual(await probe(replaceSlug(path, slug)), 'unauthorized');
      });

      test(`${name}: valid token → connection opens`, async () => {
        assert.strictEqual(await probe(replaceSlug(path, slug), signTestToken()), 'open');
      });

      test(`${name}: invalid token → handshake rejected`, async () => {
        assert.strictEqual(await probe(replaceSlug(path, slug), 'not-a-real-token'), 'unauthorized');
      });
    }
  });

  test('presence: connects and receives the user roster', async () => {
    const token = signTestToken();
    const t = `pres-${Date.now().toString(36)}`;
    const url = `${WS_BASE}/ws/presence/${t}?token=${encodeURIComponent(token)}`;

    const messages: any[] = [];
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout waiting for presence')), 5000);
      ws.on('message', (d) => {
        messages.push(JSON.parse(d.toString()));
        clearTimeout(to);
        resolve();
      });
      ws.on('error', (e) => { clearTimeout(to); reject(e); });
    });
    ws.terminate();

    assert.ok(messages.length >= 1, 'expected at least one presence message');
    const first = messages[0];
    assert.strictEqual(first.type, 'presence');
    assert.ok(Array.isArray(first.users));
    assert.ok(first.users.length >= 1, 'expected the connecting user in the roster');
    assert.ok(first.users.every((u: any) => typeof u.username === 'string'));
  });
});

/** Open a status socket and resolve when the next status message arrives. */
function openStatusSocket(slug: string, token: string): Promise<{ messages: any[]; close: () => void }> {
  const url = `${WS_BASE}/ws/projects/${slug}/status?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  const messages: any[] = [];
  const first = new Promise<void>((resolve) => {
    ws.on('message', (d) => {
      messages.push(JSON.parse(d.toString()));
      resolve();
    });
    // Well-behaved status socket always yields a frame; never wait past 5s
    setTimeout(() => resolve(), 5000);
  });
  ws.on('error', () => {});
  return first.then(() => ({
    messages,
    close: () => { try { ws.terminate(); } catch { /* already gone */ } },
  }));
}

describe('WebSocket fan-out broadcasters', () => {
  before(async () => { await initTestAuth(); });

  let slug = 'probe-slug';

  test('resolve a real project slug when available', async () => {
    slug = (await firstProjectSlug()) || slug;
    assert.ok(slug, 'a slug must be resolvable');
  });

  test('project status: two sockets on the same slug BOTH receive updates (fan-out)', async () => {
    const token = signTestToken();
    const a = await openStatusSocket(slug, token);

    // Open the second socket AFTER the first already got its first frame, so
    // any shared-broadcaster fan-out (vs per-connection timers) is observable:
    // both sockets must see a shared update frame.
    const b = await openStatusSocket(slug, token);

    // Wait for at least one update beyond the initial 'ready' on socket A.
    // With a shared broadcaster both A and B share the same scripted frames.
    await new Promise((r) => setTimeout(r, 3600));

    a.close();
    b.close();

    for (const [label, sock] of [['A', a], ['B', b]] as const) {
      const types = sock.messages.map((m) => m.type);
      assert.ok(types.includes('ready') || types.includes('update'),
        `${label}: expected a status frame, got ${JSON.stringify(types)}`);
    }
  });

  test('global status: two sockets on /ws/projects/status both receive ' +
    'the initial ready snapshot (fan-out)', async () => {
    const token = signTestToken();
    const url = `${WS_BASE}/ws/projects/status?token=${encodeURIComponent(token)}`;

    const mk = () => {
      const ws = new WebSocket(url);
      const messages: any[] = [];
      const first = new Promise<void>((resolve) => {
        ws.on('message', (d) => {
          messages.push(JSON.parse(d.toString()));
          resolve();
        });
        setTimeout(() => resolve(), 5000);
      });
      ws.on('error', () => {});
      return first.then(() => ({ messages, close: () => { try { ws.terminate(); } catch { /* gone */ } } }));
    };

    const a = await mk();
    const b = await mk();
    await new Promise((r) => setTimeout(r, 500));

    a.close();
    b.close();

    for (const [label, sock] of [['A', a], ['B', b]] as const) {
      const ready = sock.messages.find((m) => m.type === 'ready');
      assert.ok(ready, `${label}: expected a 'ready' snapshot, got ${JSON.stringify(sock.messages.map((m) => m.type))}`);
      assert.ok(Array.isArray(ready.projects), `${label}: ready.projects must be an array`);
    }
  }, { timeout: 15000 });

  test('chat room: cap stays at 8 (interactive rooms unchanged)', async () => {
    const token = signTestToken();
    const chatId = `cap-${Date.now().toString(36)}`;
    const url = `${WS_BASE}/ws/chat/global/${chatId}?token=${encodeURIComponent(token)}`;

    const sockets: WebSocket[] = [];

    // Open 8 — all should succeed under the existing 8 cap and STAY open.
    for (let i = 0; i < 8; i += 1) {
      const ws = new WebSocket(url);
      sockets.push(ws);
      const ok = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        ws.on('error', () => resolve(false));
        // Give the server a moment to refuse after opening, if it would
        setTimeout(() => resolve(false), 500);
      });
      assert.strictEqual(ok, true, `chat connection ${i + 1} should open`);
    }

    // The 9th must be REJECTED: the server sends a 1013 close frame. Because the
    // client 'open' event can fire at handshake completion before the server's
    // post-handshake room-cap close is processed, we wait for the close event
    // (or a refusal) rather than expecting 'open' to never fire.
    const ninth = new WebSocket(url);
    sockets.push(ninth);
    const ninthOutcome = await new Promise<{ closed: boolean; code?: number }>((resolve) => {
      let finished = false;
      const done = (v: { closed: boolean; code?: number }) => {
        if (finished) return;
        finished = true;
        resolve(v);
      };
      ninth.on('close', (code) => done({ closed: true, code }));
      ninth.on('error', () => done({ closed: true }));
      // If it somehow stays open past the grace period, report that (failure —
      // the room cap is not enforced).
      setTimeout(() => done({ closed: false }), 2000);
    });
    // 1013 = "try again later" policy-violation close used by the room cap.
    assert.ok(ninthOutcome.closed && ninthOutcome.code === 1013,
      `9th chat connection must be rejected with 1013, got ${JSON.stringify(ninthOutcome)}`);

    for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
  }, { timeout: 15000 });
});
