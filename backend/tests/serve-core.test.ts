/**
 * serve-core.test.ts
 * Pure unit coverage for the static-site serve pure rules (sanitizeServeConfig
 * / buildServeCmd / serveUrl / deriveServeState). No server, no Docker —
 * fully offline, mirroring project-limits-core.test.ts / project-alerts.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  HttpError,
  sanitizeServeConfig,
  buildServeCmd,
  serveUrl,
  deriveServeState,
  type ServeConfig,
} from '../src/services/serve-core.ts';

describe('sanitizeServeConfig — port resolution', () => {
  test('explicit valid published port is honored', () => {
    const cfg = sanitizeServeConfig({ enabled: true, port: 8080 }, undefined, [8080, 8081]);
    assert.deepStrictEqual(cfg, { enabled: true, port: 8080 });
  });

  test('junk port (not an integer) → 400', () => {
    assert.throws(
      () => sanitizeServeConfig({ enabled: true, port: 'abc' }, undefined, [8080]),
      (e: any) => e instanceof HttpError && e.statusCode === 400 && /not a published port/i.test(e.message)
    );
  });

  test('port 0 → 400', () => {
    assert.throws(
      () => sanitizeServeConfig({ enabled: true, port: 0 }, undefined, [8080]),
      (e: any) => e instanceof HttpError && e.statusCode === 400 && /not a published port/i.test(e.message)
    );
  });

  test('published int but not a real published port → 400', () => {
    assert.throws(
      () => sanitizeServeConfig({ enabled: true, port: 9999 }, undefined, [8080, 8081]),
      (e: any) => e instanceof HttpError && e.statusCode === 400 && /9999 is not a published port/i.test(e.message)
    );
  });

  test('no input port → first published port', () => {
    const cfg = sanitizeServeConfig({ enabled: true }, undefined, [8080, 8081]);
    assert.deepStrictEqual(cfg, { enabled: true, port: 8080 });
  });

  test('prev.port preserved when still published', () => {
    const prev: ServeConfig = { enabled: true, port: 8081 };
    const cfg = sanitizeServeConfig({ enabled: true }, prev, [8080, 8081]);
    assert.strictEqual(cfg.port, 8081, 'keeps the prior non-first port');
  });

  test('prev.port falls back to first published when dropped from the set', () => {
    const prev: ServeConfig = { enabled: true, port: 8081 };
    const cfg = sanitizeServeConfig({ enabled: true }, prev, [8080, 8082]);
    assert.strictEqual(cfg.port, 8080, 'prev port no longer published → first');
  });

  test('empty publishedPorts → 400', () => {
    assert.throws(
      () => sanitizeServeConfig({ enabled: true }, undefined, []),
      (e: any) => e instanceof HttpError && e.statusCode === 400 && /No ports published/i.test(e.message)
    );
    assert.throws(
      () => sanitizeServeConfig(undefined, undefined, []),
      (e: any) => e instanceof HttpError && e.statusCode === 400 && /No ports published/i.test(e.message)
    );
  });

  test('null/empty-string explicit port treated as absent (falls to default)', () => {
    const cfg = sanitizeServeConfig({ enabled: true, port: null }, { enabled: true, port: 8081 }, [8080, 8081]);
    assert.strictEqual(cfg.port, 8081);
    const cfg2 = sanitizeServeConfig({ enabled: true, port: '' }, undefined, [8080]);
    assert.strictEqual(cfg2.port, 8080);
  });
});

describe('buildServeCmd', () => {
  test('exact argv — no shell chars, literal -d /workspace', () => {
    assert.deepStrictEqual(buildServeCmd(8080), ['python3', '-m', 'http.server', '8080', '-d', '/workspace']);
    assert.deepStrictEqual(buildServeCmd(8081), ['python3', '-m', 'http.server', '8081', '-d', '/workspace']);
  });
});

describe('serveUrl', () => {
  test('string and number hostPort', () => {
    assert.strictEqual(serveUrl('localhost', '8080'), 'http://localhost:8080');
    assert.strictEqual(serveUrl('10.0.0.5', 8080), 'http://10.0.0.5:8080');
  });
});

describe('deriveServeState', () => {
  const cfg: ServeConfig = { enabled: true, port: 8080 };

  test('disabled → active false (config-only), no port/hostPort/url', () => {
    const s = deriveServeState({ enabled: false, port: 8080 }, [8080], null);
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.active, false);
    assert.strictEqual(s.port, undefined, 'disabled exposes no port');
    assert.strictEqual(s.hostPort, undefined);
    assert.strictEqual(s.url, undefined);
  });

  test('undefined meta serve → disabled + inactive', () => {
    const s = deriveServeState(undefined, [8080], null);
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.active, false);
  });

  test('probe null → active false (config-only)', () => {
    const s = deriveServeState(cfg, [8080], null);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.active, false);
    assert.strictEqual(s.port, 8080);
    assert.strictEqual(s.hostPort, '8080', 'port maps 1:1 to host port');
    assert.strictEqual(s.url, 'http://localhost:8080');
    assert.strictEqual(s.error, null);
  });

  test('probe ok → active true, no error', () => {
    const s = deriveServeState(cfg, [8080], { active: true, httpCode: 200, status: 'open' });
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.error, null);
  });

  test('probe refused → active false + error reflects it', () => {
    const s = deriveServeState(cfg, [8080], { active: false, httpCode: null, status: 'refused' });
    assert.strictEqual(s.active, false);
    assert.strictEqual(s.error, 'refused');
  });

  test('configured port not in published set → hostPort/url omitted (still enabled)', () => {
    const s = deriveServeState({ enabled: true, port: 9999 }, [8080], null);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.port, 9999);
    assert.strictEqual(s.hostPort, undefined);
    assert.strictEqual(s.url, undefined);
  });
});
