import { test, describe } from 'node:test';
import assert from 'node:assert';

const API_URL = 'http://127.0.0.1:3000/api';
let token = '';
let testProjectSlug = 'smoke-test-project-' + Date.now();

describe('WSD-Pro API Smoke Tests', () => {

  test('GET /health - should return status ok', async () => {
    const res = await fetch(`${API_URL}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
  });

  test('POST /auth/login - should authenticate admin and return a token', async () => {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    
    assert.strictEqual(res.status, 200, `Expected 200 OK, got ${res.status}`);
    const data = await res.json();
    assert.ok(data.token, 'Token should be returned');
    token = data.token;
  });

  test('GET /projects - should list projects successfully', async () => {
    const res = await fetch(`${API_URL}/projects`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects), 'Expected projects array');
  });

  test('POST /projects - should create a new test project', async () => {
    const res = await fetch(`${API_URL}/projects`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
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
    const res = await fetch(`${API_URL}/projects/${testProjectSlug}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.slug, testProjectSlug);
  });

  test('DELETE /projects/:slug - should clean up the test project', async () => {
    const res = await fetch(`${API_URL}/projects/${testProjectSlug}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
  });

});
