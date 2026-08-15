import { test, describe } from 'node:test';
import assert from 'node:assert';

const API_URL = 'http://127.0.0.1:3000/api';
let testProjectSlug = 'smoke-test-project-' + Date.now();

describe('WSD-Pro API Smoke Tests', () => {

  test('GET /health - should return status ok', async () => {
    const res = await fetch(`${API_URL}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
  });

  test('GET /projects - should list projects without auth', async () => {
    const res = await fetch(`${API_URL}/projects`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects), 'Expected projects array');
  });

  test('GET /chat/info - should return the chat model', async () => {
    const res = await fetch(`${API_URL}/chat/info`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.model, 'string');
  });

  test('GET /ide/status - should report the unified IDE', async () => {
    const res = await fetch(`${API_URL}/ide/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.ide.port, 'number');
    assert.strictEqual(typeof data.ide.password, 'string');
  });

  test('POST /projects - should create a new test project', async () => {
    const res = await fetch(`${API_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke Test Project',
        slug: testProjectSlug,
        description: 'Temporary project for smoke testing',
      })
    });
    assert.strictEqual(res.status, 201, `Failed to create project: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.project.slug, testProjectSlug);
    assert.strictEqual(data.project.status, 'running');
  });

  test('GET /projects/:slug - should fetch the created project', async () => {
    const res = await fetch(`${API_URL}/projects/${testProjectSlug}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.slug, testProjectSlug);
  });

  test('DELETE /projects/:slug - should clean up the test project', async () => {
    const res = await fetch(`${API_URL}/projects/${testProjectSlug}`, {
      method: 'DELETE',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
  });

});
