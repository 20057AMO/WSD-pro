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
