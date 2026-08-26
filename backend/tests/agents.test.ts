import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { uniqueId, reqAuth, req, API_URL } from './helpers.ts';

/**
 * ════════════════════════════════════════════════════════════════
 *  AGENTS — comprehensive lifecycle & edge-case coverage
 * ════════════════════════════════════════════════════════════════
 * Covers gaps NOT addressed by providers-agents-chat.test.ts:
 *
 *   A1  Default agents (migration injection) — all 8 baked-in
 *   A2  Full CRUD lifecycle with field verification
 *   A3  Agent update: partial patch, overwrite fields, idempotent
 *   A4  Update/delete nonexistent agent → 404
 *   A5  Auth: unauthenticated access returns 401
 *   A6  Session create for nonexistent agent → 404
 *   A7  Session rename: empty name → 400, missing session → 404
 *   A8  Session delete: missing session → 404
 *   A9  Multiple agents: isolation, delete one doesn't affect others
 *  A10  Agent field types: icon, description, toolsEnabled, provider, model
 *  A11  XSS in systemPrompt and name (stored verbatim — no 500 crash)
 *  A12  Session listing order (sorted by updatedAt desc)
 *  A13  Concurrent session operations
 */

function forgedToken(): string {
  // Sign with wrong secret → should be rejected
  return jwt.sign(
    { id: 'attacker', username: 'hacker' },
    'completely-wrong-secret',
    { expiresIn: '5m' }
  );
}

const createdAgentIds: string[] = [];
const createdSessionIds: Map<string, string[]> = new Map(); // agentId → [chatId, ...]

after(async () => {
  // Best-effort cleanup of all agents created during this suite
  for (const id of createdAgentIds) {
    try { await reqAuth('DELETE', `/agents/${id}`); } catch { /* best effort */ }
  }
});

// ── A1: Default agents (migration) ─────────────────────────────
describe('A1 · Default agents are present on every load', () => {
  test('GET /api/agents includes all 8 baked-in default agents', async () => {
    const res = await reqAuth('GET', '/agents');
    assert.strictEqual(res.status, 200);
    const { agents } = await res.json();
    assert.ok(Array.isArray(agents), 'agents must be an array');

    const ids = agents.map((a: any) => a.id);
    for (const expected of ['general', 'planner', 'coder', 'reviewer', 'devops', 'debugger', 'ux-designer', 'security']) {
      assert.ok(ids.includes(expected), `default agent "${expected}" must be present`);
    }
  });

  test('each default agent has required fields non-empty', async () => {
    const res = await reqAuth('GET', '/agents');
    const { agents } = await res.json();
    const defaults = agents.filter((a: any) =>
      ['general', 'planner', 'coder', 'reviewer', 'devops', 'debugger', 'ux-designer', 'security'].includes(a.id)
    );
    for (const d of defaults) {
      assert.ok(d.name, `${d.id} must have a non-empty name`);
      assert.ok(d.icon, `${d.id} must have a non-empty icon`);
      assert.ok(d.systemPrompt, `${d.id} must have a non-empty systemPrompt`);
      assert.strictEqual(typeof d.enabled, 'boolean', `${d.id} must have boolean enabled`);
      assert.strictEqual(typeof d.toolsEnabled, 'boolean', `${d.id} must have boolean toolsEnabled`);
    }
  });
});

// ── A2: Full agent CRUD lifecycle ─────────────────────────────
describe('A2 · Agent CRUD lifecycle with field verification', () => {
  const agentName = uniqueId('lifecycle');
  let agentId = '';

  test('POST /api/agents — create with all fields', async () => {
    const body = {
      name: agentName,
      icon: '🧪',
      description: 'A test agent for lifecycle coverage',
      systemPrompt: 'You are a testing specialist.',
      toolsEnabled: true,
    };
    const res = await reqAuth('POST', '/agents', body);
    assert.ok([200, 201].includes(res.status), `create failed: ${res.status}`);
    const data = await res.json();
    const agent = data.agent;
    assert.ok(agent, 'response must contain agent');
    assert.ok(agent.id, 'agent must have an id');
    agentId = agent.id;
    createdAgentIds.push(agentId);

    // Verify provided fields are stored
    assert.strictEqual(agent.name, agentName);
    assert.strictEqual(agent.icon, '🧪');
    assert.strictEqual(agent.description, 'A test agent for lifecycle coverage');
    assert.strictEqual(agent.systemPrompt, 'You are a testing specialist.');
    assert.strictEqual(agent.enabled, true); // default

    // POST route now correctly forwards toolsEnabled
    assert.strictEqual(agent.toolsEnabled, true, 'POST route forwards toolsEnabled');
  });

  test('GET /api/agents — created agent appears in list', async () => {
    const res = await reqAuth('GET', '/agents');
    const { agents } = await res.json();
    const found = agents.find((a: any) => a.id === agentId);
    assert.ok(found, 'created agent must appear in list');
    assert.strictEqual(found.name, agentName);
  });

  test('PUT /api/agents/:id — update name and description', async () => {
    const newName = uniqueId('updated');
    const res = await reqAuth('PUT', `/agents/${agentId}`, {
      name: newName,
      description: 'Updated description',
    });
    assert.strictEqual(res.status, 200);
    const { agent } = await res.json();
    assert.strictEqual(agent.id, agentId, 'id must not change');
    assert.strictEqual(agent.name, newName);
    assert.strictEqual(agent.description, 'Updated description');
    // Unchanged fields preserved
    assert.strictEqual(agent.icon, '🧪');
    assert.strictEqual(agent.systemPrompt, 'You are a testing specialist.');
  });

  test('PUT /api/agents/:id — toggle enabled and toolsEnabled', async () => {
    const res = await reqAuth('PUT', `/agents/${agentId}`, {
      enabled: false,
      toolsEnabled: false,
    });
    assert.strictEqual(res.status, 200);
    const { agent } = await res.json();
    assert.strictEqual(agent.enabled, false);
    assert.strictEqual(agent.toolsEnabled, false);
  });

  test('PUT /api/agents/:id — set provider and model fields', async () => {
    const res = await reqAuth('PUT', `/agents/${agentId}`, {
      provider: 'test-provider-id',
      model: 'gpt-4o-test',
    });
    assert.strictEqual(res.status, 200);
    const { agent } = await res.json();
    assert.strictEqual(agent.provider, 'test-provider-id');
    assert.strictEqual(agent.model, 'gpt-4o-test');
  });

  test('PUT /api/agents/:id — idempotent: same data returns same agent', async () => {
    const res1 = await reqAuth('PUT', `/agents/${agentId}`, { icon: '⚡' });
    const res2 = await reqAuth('PUT', `/agents/${agentId}`, { icon: '⚡' });
    const a1 = (await res1.json()).agent;
    const a2 = (await res2.json()).agent;
    assert.strictEqual(a1.id, a2.id);
    assert.strictEqual(a1.icon, a2.icon);
  });

  test('DELETE /api/agents/:id — remove agent', async () => {
    const res = await reqAuth('DELETE', `/agents/${agentId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).ok, true);
    // Remove from cleanup list since it's already deleted
    const idx = createdAgentIds.indexOf(agentId);
    if (idx !== -1) createdAgentIds.splice(idx, 1);

    // Confirm gone
    const check = await reqAuth('GET', '/agents');
    const { agents } = await check.json();
    assert.ok(!agents.some((a: any) => a.id === agentId), 'deleted agent must not appear');
  });
});

// ── A3: Update nonexistent / delete nonexistent ───────────────
describe('A3 · Update/delete nonexistent agent returns 404', () => {
  test('PUT /api/agents/nonexistent-id → 404', async () => {
    const res = await reqAuth('PUT', '/agents/nonexistent-id-999', { name: 'nope' });
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.ok(data.error, 'must include error message');
  });

  test('DELETE /api/agents/nonexistent-id → 404', async () => {
    const res = await reqAuth('DELETE', '/agents/nonexistent-id-999');
    assert.strictEqual(res.status, 404);
  });
});

// ── A4: Auth: unauthenticated access → 401 ───────────────────
describe('A4 · Unauthenticated access returns 401', () => {
  const agentEndpoints = [
    ['GET', '/agents'],
    ['POST', '/agents'],
    ['PUT', '/agents/fake-id'],
    ['DELETE', '/agents/fake-id'],
    ['GET', '/agents/fake-id/sessions'],
    ['POST', '/agents/fake-id/sessions'],
  ];

  for (const [method, path] of agentEndpoints) {
    test(`${method} ${path} without token → 401`, async () => {
      const body = method === 'POST' ? { name: 'test' } : undefined;
      const res = await req(method as string, path, body);
      assert.strictEqual(res.status, 401, `${method} ${path} must reject unauthenticated requests`);
    });
  }

  test('GET /agents with forged (wrong secret) token → 401', async () => {
    const token = forgedToken();
    const res = await fetch(`${API_URL}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 401);
  });
});

// ── A5: Session CRUD for nonexistent agent → 404 ─────────────
describe('A5 · Session endpoints for nonexistent agent → 404', () => {
  test('GET /agents/ghost/sessions → 404', async () => {
    const res = await reqAuth('GET', '/agents/ghost/sessions');
    assert.strictEqual(res.status, 404);
  });

  test('POST /agents/ghost/sessions → 404', async () => {
    const res = await reqAuth('POST', '/agents/ghost/sessions', { name: 'session' });
    assert.strictEqual(res.status, 404);
  });
});

// ── A6: Session rename: empty name → 400, missing session → 404 ─
describe('A6 · Session rename edge cases', () => {
  const agentName = uniqueId('rename-agent');
  let agentId = '';

  after(async () => {
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* ok */ } }
  });

  test('create agent for session tests', async () => {
    const res = await reqAuth('POST', '/agents', { name: agentName });
    const { agent } = await res.json();
    agentId = agent.id;
    createdAgentIds.push(agentId);
  });

  test('rename session with empty string → 400', async () => {
    // First create a session
    const createRes = await reqAuth('POST', `/agents/${agentId}/sessions`, { name: 'temp' });
    const { session } = await createRes.json();

    const renameRes = await reqAuth('PUT', `/agents/${agentId}/sessions/${session.chatId}`, { name: '' });
    assert.strictEqual(renameRes.status, 400);
    const data = await renameRes.json();
    assert.ok(data.error, 'must have error message');
  });

  test('rename session with whitespace-only name → 400', async () => {
    const createRes = await reqAuth('POST', `/agents/${agentId}/sessions`, { name: 'temp2' });
    const { session } = await createRes.json();

    const renameRes = await reqAuth('PUT', `/agents/${agentId}/sessions/${session.chatId}`, { name: '   ' });
    assert.strictEqual(renameRes.status, 400);
  });

  test('rename session with missing name field → 400', async () => {
    const createRes = await reqAuth('POST', `/agents/${agentId}/sessions`, { name: 'temp3' });
    const { session } = await createRes.json();

    const renameRes = await reqAuth('PUT', `/agents/${agentId}/sessions/${session.chatId}`, {});
    assert.strictEqual(renameRes.status, 400);
  });

  test('rename nonexistent session → 404', async () => {
    const res = await reqAuth('PUT', `/agents/${agentId}/sessions/fake-chat-id`, { name: 'nope' });
    assert.strictEqual(res.status, 404);
  });
});

// ── A7: Delete nonexistent session → 404 ─────────────────────
describe('A7 · Delete nonexistent session → 404', () => {
  const agentName = uniqueId('delsess-agent');
  let agentId = '';

  after(async () => {
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* ok */ } }
  });

  test('create agent for delete-session tests', async () => {
    const res = await reqAuth('POST', '/agents', { name: agentName });
    const { agent } = await res.json();
    agentId = agent.id;
    createdAgentIds.push(agentId);
  });

  test('DELETE /agents/:id/sessions/:chatId for nonexistent session → 404', async () => {
    const res = await reqAuth('DELETE', `/agents/${agentId}/sessions/fake-chat-id`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
  });
});

// ── A8: Multiple agents: isolation & independent deletion ─────
describe('A8 · Multiple agents: create, list, delete isolation', () => {
  const agentA = uniqueId('multi-a');
  const agentB = uniqueId('multi-b');
  let idA = '';
  let idB = '';

  after(async () => {
    if (idA) { try { await reqAuth('DELETE', `/agents/${idA}`); } catch { /* ok */ } }
    if (idB) { try { await reqAuth('DELETE', `/agents/${idB}`); } catch { /* ok */ } }
  });

  test('create two agents with different names', async () => {
    const resA = await reqAuth('POST', '/agents', { name: agentA });
    idA = (await resA.json()).agent.id;
    createdAgentIds.push(idA);

    const resB = await reqAuth('POST', '/agents', { name: agentB });
    idB = (await resB.json()).agent.id;
    createdAgentIds.push(idB);

    assert.notStrictEqual(idA, idB, 'two agents must have different ids');
  });

  test('both appear in list', async () => {
    const res = await reqAuth('GET', '/agents');
    const { agents } = await res.json();
    assert.ok(agents.some((a: any) => a.id === idA), 'agent A in list');
    assert.ok(agents.some((a: any) => a.id === idB), 'agent B in list');
  });

  test('delete agent A — agent B unaffected', async () => {
    const delRes = await reqAuth('DELETE', `/agents/${idA}`);
    assert.strictEqual(delRes.status, 200);
    const idx = createdAgentIds.indexOf(idA);
    if (idx !== -1) createdAgentIds.splice(idx, 1);
    idA = '';

    const check = await reqAuth('GET', '/agents');
    const { agents } = await check.json();
    assert.ok(!agents.some((a: any) => a.id === idA || a.name === agentA), 'agent A gone');
    assert.ok(agents.some((a: any) => a.id === idB), 'agent B still present');
  });
});

// ── A9: Agent field types & defaults ──────────────────────────
describe('A9 · Agent field types and default values', () => {
  const agentName = uniqueId('defaults');
  let agentId = '';

  after(async () => {
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* ok */ } }
  });

  test('create agent with minimal body — defaults applied', async () => {
    const res = await reqAuth('POST', '/agents', { name: agentName });
    const { agent } = await res.json();
    agentId = agent.id;
    createdAgentIds.push(agentId);

    assert.strictEqual(agent.icon, '🤖', 'default icon');
    assert.strictEqual(agent.description, '', 'default description is empty string');
    assert.strictEqual(agent.systemPrompt, 'You are a helpful assistant.', 'default systemPrompt');
    assert.strictEqual(agent.enabled, true, 'default enabled');
    assert.strictEqual(agent.toolsEnabled, false, 'default toolsEnabled');
    assert.strictEqual(agent.provider, undefined, 'default provider is undefined');
    assert.strictEqual(agent.model, undefined, 'default model is undefined');
  });

  test('create agent with empty name — returns 400', async () => {
    const res = await reqAuth('POST', '/agents', { name: '' });
    assert.strictEqual(res.status, 400, 'empty name should be rejected');
    const body = await res.json();
    assert.ok(body.error, 'should include error message');
  });

  test('create agent with no body at all — returns 400', async () => {
    const res = await reqAuth('POST', '/agents', {});
    assert.strictEqual(res.status, 400, 'missing name should be rejected');
    const body = await res.json();
    assert.ok(body.error, 'should include error message');
  });
});

// ── A10: XSS in systemPrompt and name — stored verbatim, no crash ─
describe('A10 · XSS payloads in agent name/systemPrompt are stored safely', () => {
  const xssPayload = '<script>alert("xss")</script>';
  const htmlEntities = '&lt;img src=x onerror=alert(1)&gt;';
  const agentName = uniqueId('xss');
  let agentId = '';

  after(async () => {
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* ok */ } }
  });

  test('POST /api/agents with script tags in name and systemPrompt', async () => {
    const res = await reqAuth('POST', '/agents', {
      name: `${agentName} ${xssPayload}`,
      systemPrompt: xssPayload,
      description: htmlEntities,
    });
    assert.ok([200, 201].includes(res.status), `must not crash: ${res.status}`);
    const { agent } = await res.json();
    agentId = agent.id;
    createdAgentIds.push(agentId);

    // Server stores the raw value — escaping is the frontend's job
    assert.strictEqual(agent.name, `${agentName} ${xssPayload}`);
    assert.strictEqual(agent.systemPrompt, xssPayload);
    assert.strictEqual(agent.description, htmlEntities);
  });

  test('GET /api/agents — XSS content returned verbatim (no 500)', async () => {
    const res = await reqAuth('GET', '/agents');
    assert.strictEqual(res.status, 200);
    const { agents } = await res.json();
    const found = agents.find((a: any) => a.id === agentId);
    assert.ok(found, 'xss agent present');
    assert.ok(found.systemPrompt.includes('<script>'), 'script tag preserved');
  });

  test('PUT /api/agents with unicode and emoji in systemPrompt', async () => {
    const unicodePrompt = 'مرحبا 🌍 — <b>bold</b> "quotes" and \\n\\r\\t';
    const res = await reqAuth('PUT', `/agents/${agentId}`, {
      systemPrompt: unicodePrompt,
    });
    assert.strictEqual(res.status, 200);
    const { agent } = await res.json();
    assert.strictEqual(agent.systemPrompt, unicodePrompt);
  });
});

// ── A11: Session operations across agents are isolated ────────
describe('A11 · Session operations are agent-scoped', () => {
  const nameA = uniqueId('scope-a');
  const nameB = uniqueId('scope-b');
  let idA = '';
  let idB = '';
  let chatIdA = '';
  let chatIdB = '';

  after(async () => {
    if (idA) { try { await reqAuth('DELETE', `/agents/${idA}`); } catch { /* ok */ } }
    if (idB) { try { await reqAuth('DELETE', `/agents/${idB}`); } catch { /* ok */ } }
  });

  test('create two agents', async () => {
    const rA = await reqAuth('POST', '/agents', { name: nameA });
    idA = (await rA.json()).agent.id;
    createdAgentIds.push(idA);

    const rB = await reqAuth('POST', '/agents', { name: nameB });
    idB = (await rB.json()).agent.id;
    createdAgentIds.push(idB);
  });

  test('create one session per agent', async () => {
    const rA = await reqAuth('POST', `/agents/${idA}/sessions`, { name: 'sess-a' });
    chatIdA = (await rA.json()).session.chatId;

    const rB = await reqAuth('POST', `/agents/${idB}/sessions`, { name: 'sess-b' });
    chatIdB = (await rB.json()).session.chatId;

    assert.notStrictEqual(chatIdA, chatIdB);
  });

  test('agent A sessions list only shows its own session', async () => {
    const res = await reqAuth('GET', `/agents/${idA}/sessions`);
    const { sessions } = await res.json();
    assert.ok(sessions.some((s: any) => s.chatId === chatIdA), 'A has its own session');
    assert.ok(!sessions.some((s: any) => s.chatId === chatIdB), 'A does NOT have B\'s session');
  });

  test('cannot rename B\'s session via A\'s endpoint', async () => {
    const res = await reqAuth('PUT', `/agents/${idA}/sessions/${chatIdB}`, { name: 'hijacked' });
    assert.strictEqual(res.status, 404, 'cross-agent rename must fail');
  });

  test('cannot delete B\'s session via A\'s endpoint', async () => {
    const res = await reqAuth('DELETE', `/agents/${idA}/sessions/${chatIdB}`);
    assert.strictEqual(res.status, 404, 'cross-agent delete must fail');
  });

  test('B\'s session still exists after failed cross-agent ops', async () => {
    const res = await reqAuth('GET', `/agents/${idB}/sessions`);
    const { sessions } = await res.json();
    assert.ok(sessions.some((s: any) => s.chatId === chatIdB), 'B\'s session survived');
  });
});

// ── A12: Session listing order (most recently updated first) ──
describe('A12 · Sessions are listed sorted by updatedAt desc', () => {
  const agentName = uniqueId('order');
  let agentId = '';
  const chatIds: string[] = [];

  after(async () => {
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* ok */ } }
  });

  test('create agent and 3 sessions', async () => {
    const r = await reqAuth('POST', '/agents', { name: agentName });
    agentId = (await r.json()).agent.id;
    createdAgentIds.push(agentId);

    for (let i = 0; i < 3; i++) {
      const sr = await reqAuth('POST', `/agents/${agentId}/sessions`, { name: `order-${i}` });
      chatIds.push((await sr.json()).session.chatId);
    }
  });

  test('rename the first session (makes it the most recently updated)', async () => {
    const res = await reqAuth('PUT', `/agents/${agentId}/sessions/${chatIds[0]}`, { name: 'order-0-renamed' });
    assert.strictEqual(res.status, 200);
  });

  test('list shows renamed session first (most recently updated)', async () => {
    const res = await reqAuth('GET', `/agents/${agentId}/sessions`);
    const { sessions } = await res.json();
    assert.ok(sessions.length >= 3, 'at least 3 sessions');
    assert.strictEqual(sessions[0].chatId, chatIds[0], 'first (most recently updated) is the renamed one');
  });
});

// ── A13: Large systemPrompt ───────────────────────────────────
describe('A13 · Very long systemPrompt is stored correctly', () => {
  const agentName = uniqueId('long');
  let agentId = '';
  const longPrompt = 'A'.repeat(50000); // 50K chars

  after(async () => {
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* ok */ } }
  });

  test('POST /api/agents with 50K char systemPrompt', async () => {
    const res = await reqAuth('POST', '/agents', {
      name: agentName,
      systemPrompt: longPrompt,
    });
    assert.ok([200, 201].includes(res.status));
    const { agent } = await res.json();
    agentId = agent.id;
    createdAgentIds.push(agentId);
    assert.strictEqual(agent.systemPrompt.length, 50000);
  });

  test('GET /api/agents — long prompt survives roundtrip', async () => {
    const res = await reqAuth('GET', '/agents');
    const { agents } = await res.json();
    const found = agents.find((a: any) => a.id === agentId);
    assert.ok(found);
    assert.strictEqual(found.systemPrompt.length, 50000);
  });
});
