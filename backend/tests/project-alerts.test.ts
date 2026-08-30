/**
 * project-alerts.test.ts
 * Pure unit coverage for the container-crash classifier (classifyCrash) —
 * the offline heart of the crash detector. No server, no Docker.
 *
 * Contract:
 *  - An explicit UI stop (requestedStop) never alarms, whatever the exit code.
 *  - OOM kill → crash reason 'oom' (fire-once).
 *  - Non-zero hard exit while stopped → crash reason 'exited' (fire-once).
 *  - A clean exit (0) is never a crash.
 *  - A running container whose start epoch / RestartCount moved without a
 *    stop/start/recreate → 'restart' (silent auto-restart detection).
 *  - Re-fire only on a NEW start epoch, so an ongoing cycle never spams.
 *  - First observation of a running container with restart history → 'restart'.
 *  - The persisted watch always tracks the latest state, even on clean runs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyCrash, type ClassifyInput, type InspectStateExcerpt } from '../src/services/alerts-core.ts';

const RUNNING = (over: Partial<InspectStateExcerpt> = {}): InspectStateExcerpt => ({
  status: 'running',
  running: true,
  exitCode: 0,
  oomKilled: false,
  restartCount: 0,
  startedAt: '2026-08-30T10:00:01.000Z',
  ...over,
});

const STOPPED = (over: Partial<InspectStateExcerpt> = {}): InspectStateExcerpt =>
  RUNNING({ status: 'exited', running: false, ...over });

const NOW = '2026-08-30T12:00:00.000Z';

function classify(input: Omit<ClassifyInput, 'now'>) {
  return classifyCrash({ now: NOW, ...input });
}

describe('classifyCrash — explicit stop is never a crash', () => {
  test('requestedStop masks even a non-zero exit', () => {
    const r = classify({ state: STOPPED({ exitCode: 137 }), requestedStop: true, watch: null, alreadyCrashed: false });
    assert.strictEqual(r.crash, null);
    assert.strictEqual(r.fire, false);
    assert.deepStrictEqual(r.watch, { restartCount: 0, startedAt: RUNNING().startedAt });
  });

  test('requestedStop masks an OOM-killed container', () => {
    const r = classify({ state: RUNNING({ oomKilled: true }), requestedStop: true, watch: null, alreadyCrashed: false });
    assert.strictEqual(r.crash, null, 'OOM while stopped is expected, not a crash');
  });
});

describe('classifyCrash — OOM kill', () => {
  test('running OOM container → crash "oom", fire-once', () => {
    const r = classify({ state: RUNNING({ oomKilled: true, exitCode: 137 }), requestedStop: false, watch: null, alreadyCrashed: false });
    assert.ok(r.crash);
    assert.strictEqual(r.crash!.reason, 'oom');
    assert.strictEqual(r.crash!.exitCode, 137);
    assert.strictEqual(r.crash!.at, NOW);
    assert.strictEqual(r.fire, true);
  });

  test('already flagged → still classifies but does NOT re-fire', () => {
    const r = classify({ state: RUNNING({ oomKilled: true }), requestedStop: false, watch: null, alreadyCrashed: true, crashReason: 'oom' });
    assert.strictEqual(r.crash!.reason, 'oom');
    assert.strictEqual(r.fire, false);
  });
});

describe('classifyCrash — hard exits', () => {
  test('stopped with exit code 137 → crash "exited"', () => {
    const r = classify({ state: STOPPED({ exitCode: 137 }), requestedStop: false, watch: null, alreadyCrashed: false });
    assert.ok(r.crash);
    assert.strictEqual(r.crash!.reason, 'exited');
    assert.strictEqual(r.crash!.exitCode, 137);
    assert.strictEqual(r.fire, true);
  });

  test('clean exit 0 is never a crash', () => {
    const r = classify({ state: STOPPED({ exitCode: 0 }), requestedStop: false, watch: null, alreadyCrashed: false });
    assert.strictEqual(r.crash, null);
    assert.strictEqual(r.fire, false);
  });

  test('stopped with no exit code number is not treated as a hard exit', () => {
    const r = classify({ state: STOPPED({ exitCode: null }), requestedStop: false, watch: null, alreadyCrashed: false });
    assert.strictEqual(r.crash, null);
  });
});

describe('classifyCrash — silent auto-restart detection', () => {
  test('running container whose startedAt moved (no stop/start) → crash "restart"', () => {
    const r = classify({
      state: RUNNING({ startedAt: '2026-08-30T10:05:00.000Z', restartCount: 1 }),
      requestedStop: false,
      watch: { restartCount: 0, startedAt: '2026-08-30T10:00:01.000Z' },
      alreadyCrashed: false,
    });
    assert.ok(r.crash);
    assert.strictEqual(r.crash!.reason, 'restart');
    assert.strictEqual(r.crash!.restarted, 1);
    assert.strictEqual(r.crash!.startedAt, '2026-08-30T10:05:00.000Z');
    assert.strictEqual(r.fire, true);
  });

  test('RestartCount bump with unchanged startedAt still counts as a moved epoch', () => {
    const r = classify({
      state: RUNNING({ restartCount: 2 }),
      requestedStop: false,
      watch: { restartCount: 1, startedAt: RUNNING().startedAt },
      alreadyCrashed: false,
    });
    assert.ok(r.crash);
    assert.strictEqual(r.crash!.reason, 'restart');
    assert.strictEqual(r.fire, true);
  });

  test('fresh cycle re-fires when the crash record references an OLD epoch', () => {
    const r = classify({
      state: RUNNING({ startedAt: '2026-08-30T11:00:00.000Z' }),
      requestedStop: false,
      watch: { restartCount: 1, startedAt: '2026-08-30T10:00:01.000Z' },
      alreadyCrashed: true,
      crashReason: 'restart',
      crashStartedAt: '2026-08-30T10:59:59.000Z',
    });
    assert.strictEqual(r.fire, true, 'new start epoch after recovery must alert again');
  });

  test('same epoch as the flagged crash never re-fires (no spam during one cycle)', () => {
    const r = classify({
      state: RUNNING({ startedAt: '2026-08-30T11:00:00.000Z' }),
      requestedStop: false,
      watch: { restartCount: 1, startedAt: '2026-08-30T10:00:01.000Z' },
      alreadyCrashed: true,
      crashStartedAt: '2026-08-30T11:00:00.000Z',
    });
    assert.strictEqual(r.fire, false);
  });
});

describe('classifyCrash — first observation', () => {
  test('running container with pre-existing restart history → crash "restart"', () => {
    const r = classify({ state: RUNNING({ restartCount: 3 }), requestedStop: false, watch: null, alreadyCrashed: false });
    assert.ok(r.crash);
    assert.strictEqual(r.crash!.reason, 'restart');
    assert.strictEqual(r.crash!.restarted, 3);
    assert.strictEqual(r.fire, true);
  });

  test('clean running container on first observation → no crash', () => {
    const r = classify({ state: RUNNING(), requestedStop: false, watch: null, alreadyCrashed: false });
    assert.strictEqual(r.crash, null);
    assert.strictEqual(r.fire, false);
  });

  test('watch is always refreshed to the live state (even when clean)', () => {
    const state = RUNNING({ restartCount: 7, startedAt: '2026-08-30T09:00:00.000Z' });
    const r = classify({ state, requestedStop: false, watch: null, alreadyCrashed: false });
    assert.deepStrictEqual(r.watch, { restartCount: 7, startedAt: '2026-08-30T09:00:00.000Z' });
  });
});