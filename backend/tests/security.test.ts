import { test, describe } from 'node:test';
import assert from 'node:assert';
import { uniqueId, reqAuth, signTestToken, API_URL, firstProjectSlug } from './helpers.ts';

describe('Security hardening', () => {

  const slug = uniqueId('sec');

  test('file read rejects path traversal', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/file?path=${encodeURIComponent('../../etc/passwd')}`);
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
  });

  test('files listing rejects traversal paths', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/files?path=${encodeURIComponent('../')}`);
    if (res.status === 200) {
      const data = await res.json();
      const text = JSON.stringify(data);
      assert.ok(!text.includes('../'), 'listing must not leak parent paths');
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `unexpected ${res.status}`);
    }
  });

  test('traversal upload path is sanitized, never escapes workspace', async () => {
    const target = await firstProjectSlug();
    if (!target) return; // nothing to probe against

    const form = new FormData();
    form.append('paths', JSON.stringify({ 'evil.txt': '../../escaped-by-upload.txt' }));
    form.append('files', new Blob([new Uint8Array([1, 2, 3])]), 'evil.txt');
    const res = await fetch(`${API_URL}/projects/${target}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signTestToken()}` },
      body: form,
    });

    if (res.status === 201) {
      const data = await res.json();
      for (const f of data.files || []) {
        assert.ok(!f.path.includes('..'), `uploaded path escaped workspace: ${f.path}`);
        // cleanup whatever landed
        await reqAuth('DELETE', `/projects/${target}/file?path=${encodeURIComponent(f.path)}`);
      }
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `unexpected ${res.status}`);
    }
  });

  test('unknown API route returns 404', async () => {
    const res = await reqAuth('GET', '/definitely-not-a-real-route');
    assert.strictEqual(res.status, 404);
  });

  test('malformed Authorization header is rejected', async () => {
    for (const value of ['', 'Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'Bearer a.b.c']) {
      const res = await fetch(`${API_URL}/projects`, {
        headers: value ? { Authorization: value } : {},
      });
      assert.strictEqual(res.status, 401, `expected 401 for "${value}", got ${res.status}`);
    }
  });

});

