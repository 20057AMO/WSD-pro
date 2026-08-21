import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { uniqueId, reqAuth } from './helpers.ts';

describe('Project lifecycle (real Docker container)', () => {

  const slug = uniqueId('lc-test');
  let created = false;

  after(async () => {
    if (!created) return;
    try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
  });

  test('create → 201 with a running container', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'Lifecycle Test Project',
      slug,
      description: 'Temporary project for lifecycle testing',
    });
    assert.strictEqual(res.status, 201, `create failed: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.project.slug, slug);
    assert.strictEqual(data.project.status, 'running');
    created = true;
  });

  test('get by slug returns the project', async () => {
    const res = await reqAuth('GET', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.slug, slug);
  });

  test('env update persists a variable', async () => {
    const res = await reqAuth('PUT', `/projects/${slug}/env`, { env: { WSD_TEST_VAR: 'lifecycle' } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const env = data.project?.env || data.env || {};
    assert.strictEqual(env.WSD_TEST_VAR, 'lifecycle');
  });

  test('files listing responds', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/files`);
    assert.strictEqual(res.status, 200);
  });

  test('scripts listing returns an object', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/scripts`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.scripts === 'object');
  });

  test('logs respond with a string body', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/logs?tail=20`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.logs, 'string');
  });

  test('stats respond', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/stats`);
    assert.ok([200, 404].includes(res.status), `unexpected stats status ${res.status}`);
  });

  test('ports check responds with checks array', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/ports/check`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.checks));
  });

  test('stop → status becomes stopped', async () => {
    const res = await reqAuth('POST', `/projects/${slug}/stop`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.status, 'stopped');
  });

  test('start → status becomes running again', async () => {
    const res = await reqAuth('POST', `/projects/${slug}/start`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.status, 'running');
  });

  test('delete removes the project', async () => {
    const res = await reqAuth('DELETE', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    created = false;
  });

  test('deleted project is gone (404)', async () => {
    const res = await reqAuth('GET', `/projects/${slug}`);
    assert.strictEqual(res.status, 404);
  });

});
