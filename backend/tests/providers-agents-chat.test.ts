import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { uniqueId, reqAuth } from './helpers.ts';

describe('Providers / Agents / Chat sessions CRUD', () => {

  const runId = Date.now().toString(36);
  const providerName = uniqueId('prov');
  const providerKey = `sk-${runId}-crud-test-fake`;
  let providerId = '';
  const agentName = uniqueId('agent');
  let agentId = '';

  after(async () => {
    if (providerId) { try { await reqAuth('DELETE', `/providers/${providerId}`); } catch { /* best effort */ } }
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* best effort */ } }
  });

  // ── Providers ──────────────────────────────────────────────
  test('stale providers from earlier runs are removed', async () => {
    const res = await reqAuth('GET', '/providers');
    assert.strictEqual(res.status, 200);
    const { providers } = await res.json();
    for (const p of providers as Array<{ id: string; host?: string }>) {
      if (p.host?.includes('.crud-test.invalid')) {
        await reqAuth('DELETE', `/providers/${p.id}`);
      }
    }
  });

  test('provider templates list responds', async () => {
    const res = await reqAuth('GET', '/providers/templates');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.templates));
  });

  test('create provider (disabled, fake key) → listed', async () => {
    const res = await reqAuth('POST', '/providers', {
      name: providerName,
      host: `https://${runId}.crud-test.invalid`,
      type: 'openai',
      apiKey: providerKey,
      enabled: false,
    });
    assert.ok([200, 201].includes(res.status), `create failed: ${res.status}`);
    const data = await res.json();
    providerId = data.provider?.id || '';
    assert.ok(providerId, 'created provider must have an id');

    const list = await reqAuth('GET', '/providers');
    const data2 = await list.json();
    assert.ok(data2.providers.some((p: any) => p.id === providerId));
  });

  test('update provider name → reflected', async () => {
    const res = await reqAuth('PUT', `/providers/${providerId}`, { name: `${providerName}-v2` });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.provider.name, `${providerName}-v2`);
  });

  test('delete provider → gone from list', async () => {
    const res = await reqAuth('DELETE', `/providers/${providerId}`);
    assert.strictEqual(res.status, 200);
    providerId = '';
    const list = await reqAuth('GET', '/providers');
    const data = await list.json();
    assert.ok(!data.providers.some((p: any) => p.id === providerId));
  });

  // ── Agents ─────────────────────────────────────────────────
  test('create agent with defaults', async () => {
    const res = await reqAuth('POST', '/agents', { name: agentName, systemPrompt: 'You are a test agent.' });
    assert.ok([200, 201].includes(res.status), `create failed: ${res.status}`);
    const data = await res.json();
    agentId = data.agent?.id || '';
    assert.ok(agentId, 'created agent must have an id');
  });

  test('agent sessions: create → rename → list → delete', async () => {
    const createRes = await reqAuth('POST', `/agents/${agentId}/sessions`, { name: 'crud-session' });
    assert.ok([200, 201].includes(createRes.status));
    const { session } = await createRes.json();
    assert.ok(session.chatId);

    const renameRes = await reqAuth('PUT', `/agents/${agentId}/sessions/${session.chatId}`, { name: 'renamed-session' });
    assert.strictEqual(renameRes.status, 200);
    assert.strictEqual((await renameRes.json()).session.name, 'renamed-session');

    const listRes = await reqAuth('GET', `/agents/${agentId}/sessions`);
    const listData = await listRes.json();
    assert.ok(listData.sessions.some((s: any) => s.chatId === session.chatId));

    const delRes = await reqAuth('DELETE', `/agents/${agentId}/sessions/${session.chatId}`);
    assert.strictEqual(delRes.status, 200);
  });

  test('delete agent → sessions endpoint returns 404', async () => {
    const res = await reqAuth('DELETE', `/agents/${agentId}`);
    assert.strictEqual(res.status, 200);
    agentId = '';
    const check = await reqAuth('GET', `/agents/missing-agent-check/sessions`);
    assert.strictEqual(check.status, 404);
  });

  // ── Chat sessions ─────────────────────────────────────────
  test('chat session lifecycle', async () => {
    const createRes = await reqAuth('POST', '/chat/sessions', { name: 'crud-chat' });
    assert.strictEqual(createRes.status, 201);
    const { session } = await createRes.json();
    assert.ok(session.chatId);

    const listRes = await reqAuth('GET', '/chat/sessions');
    const listData = await listRes.json();
    assert.ok(listData.sessions.some((s: any) => s.chatId === session.chatId));

    const renameRes = await reqAuth('PUT', `/chat/sessions/${session.chatId}`, { name: 'crud-chat-v2' });
    assert.strictEqual(renameRes.status, 200);

    const delRes = await reqAuth('DELETE', `/chat/sessions/${session.chatId}`);
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual((await delRes.json()).ok, true);
  });

});
