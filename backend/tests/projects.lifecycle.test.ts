import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { uniqueId, reqAuth, initTestAuth } from './helpers.ts';

describe('Project lifecycle (real Docker container)', () => {
  before(async () => { await initTestAuth(); });

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

  // The container bind-mounts ./workspaces, so the host-side path must be
  // gone too after deletion (files are no longer kept by design).
  test('workspace files are removed from disk', async () => {
    const hostDir = path.resolve(import.meta.dirname!, '..', '..', 'workspaces', slug);
    assert.strictEqual(
      fs.existsSync(hostDir),
      false,
      `expected workspace dir to be deleted: ${hostDir}`,
    );
  });

});

describe('Project duplicate (real Docker container)', () => {
  before(async () => { await initTestAuth(); });

  const srcSlug = uniqueId('dup-src');
  const copySlug = uniqueId('dup-copy');
  let srcCreated = false;
  let copyCreated = false;

  after(async () => {
    if (copyCreated) { try { await reqAuth('DELETE', `/projects/${copySlug}`); } catch { /* best effort */ } }
    if (srcCreated) { try { await reqAuth('DELETE', `/projects/${srcSlug}`); } catch { /* best effort */ } }
  });

  test('create the source project (201)', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'Duplicate Source',
      slug: srcSlug,
      description: 'source for duplicate tests',
      ports: [8091],
    });
    assert.strictEqual(res.status, 201, `create source failed: ${res.status}`);
    srcCreated = true;
  });

  test('seed a workspace file and a developer note on the source', async () => {
    const wf = await reqAuth('PUT', `/projects/${srcSlug}/file?path=marker.txt`, { content: 'duplicate-me' });
    assert.strictEqual(wf.status, 200, `write file: ${wf.status}`);
    const notes = await reqAuth('PUT', `/projects/${srcSlug}/notes`, {
      items: [{ id: 'd1', text: 'carry this goal', kind: 'goal', done: false, createdAt: new Date().toISOString() }],
    });
    assert.strictEqual(notes.status, 200, `save notes: ${notes.status}`);
  });

  test('duplicate creates a new project (201)', async () => {
    const res = await reqAuth('POST', `/projects/${srcSlug}/duplicate`, {
      name: 'Copied Project',
      slug: copySlug,
      description: 'a copy',
      ports: [8092],
    });
    const data = await res.json();
    assert.strictEqual(res.status, 201, `duplicate failed: ${res.status} -> ${JSON.stringify(data)}`);
    assert.strictEqual(data.project.slug, copySlug);
    assert.strictEqual(data.project.status, 'running');
    copyCreated = true;
  });

  test('duplicate applies the provided fresh ports', async () => {
    const res = await reqAuth('GET', `/projects/${copySlug}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.project.ports.includes(8092), 'the provided ports should be applied');
  });

  test('duplicate copies the workspace file', async () => {
    const res = await reqAuth('GET', `/projects/${copySlug}/file?path=marker.txt`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(String(data.content ?? data.text ?? data).trim(), 'duplicate-me');
  });

  test('duplicate copies the developer note', async () => {
    const res = await reqAuth('GET', `/projects/${copySlug}/notes`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const texts = data.items.map((n: any) => n.text);
    assert.ok(texts.includes('carry this goal'), 'note should be copied to the duplicate');
  });

  test('the source project is left untouched', async () => {
    const src = await reqAuth('GET', `/projects/${srcSlug}`);
    const srcData = await src.json();
    assert.strictEqual(srcData.project.slug, srcSlug);
    const files = await reqAuth('GET', `/projects/${srcSlug}/file?path=marker.txt`);
    const fd = await files.json();
    assert.strictEqual(String(fd.content ?? fd.text ?? fd).trim(), 'duplicate-me');
  });

  test('duplicating a nonexistent project returns 404', async () => {
    const res = await reqAuth('POST', `/projects/nope-missing-project/duplicate`, { name: 'x', ports: [8099] });
    assert.strictEqual(res.status, 404);
  });

  test('delete removes both projects', async () => {
    const c = await reqAuth('DELETE', `/projects/${copySlug}`);
    assert.strictEqual(c.status, 200);
    copyCreated = false;
    const s = await reqAuth('DELETE', `/projects/${srcSlug}`);
    assert.strictEqual(s.status, 200);
    srcCreated = false;
  });
});
