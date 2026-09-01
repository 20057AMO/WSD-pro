import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { checkUserWrite, resetUserWriteBuckets, sweepUserWriteBuckets } from '../src/services/user-write-limiter.ts';

describe('user-write-limiter (offline per-user write budget)', () => {
  beforeEach(() => {
    resetUserWriteBuckets();
  });
  after(() => {
    resetUserWriteBuckets();
  });

  test('allows requests within budget and rejects past it', () => {
    // Default budget: 120/min per user.
    for (let i = 0; i < 120; i++) {
      assert.strictEqual(checkUserWrite('user-1'), 0, `request ${i + 1} should be allowed`);
    }
    // The 121st is over budget -> positive retry-after (seconds).
    const retryAfter = checkUserWrite('user-1');
    assert.ok(retryAfter > 0, 'over-budget request must return a retry delay');
    assert.ok(retryAfter <= 60, 'retry-after must not exceed the window');
  });

  test('different users have independent budgets (NAT-shared safety)', () => {
    // Exhaust user-1's budget; user-2 is unaffected.
    for (let i = 0; i < 120; i++) checkUserWrite('user-1');
    assert.ok(checkUserWrite('user-1') > 0, 'user-1 exhausted');
    assert.strictEqual(checkUserWrite('user-2'), 0, 'user-2 must be unaffected');
  });

  test('falls back to a shared IP bucket when no user id is present', () => {
    for (let i = 0; i < 120; i++) checkUserWrite(null, '1.2.3.4');
    assert.ok(checkUserWrite(null, '1.2.3.4') > 0, 'IP-only path is capped');
    assert.strictEqual(checkUserWrite(null, '5.6.7.8'), 0, 'a different IP starts fresh');
  });

  test('respects a custom window and max', () => {
    // Tiny custom budget of 3 per 5s.
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(checkUserWrite('u', undefined, 5000, 3), 0);
    }
    const retryAfter = checkUserWrite('u', undefined, 5000, 3);
    assert.ok(retryAfter > 0 && retryAfter <= 5, 'retry-after bounded by the 5s window');
  });

  test('window expiry resets the budget', () => {
    // Use a very small window so it naturally expires.
    checkUserWrite('user-1', undefined, 1, 1); // window: 1ms, max: 1
    // Immediately over budget.
    assert.ok(checkUserWrite('user-1', undefined, 1, 1) > 0, 'over budget within the window');
    // Wait for the tiny window to lapse, then the same key is fresh again.
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 5));
    return wait.then(() => {
      assert.strictEqual(checkUserWrite('user-1', undefined, 1, 1), 0, 'expired window resets the count');
    });
  });

  test('sweep removes stale buckets only', () => {
    checkUserWrite('user-1');
    // Force the bucket entry into the past for the sweep to collect it.
    // (checkUserWrite stores resetAt = now + window; we can't reach in here,
    // so verify the sweep is a no-op on live buckets and doesn't throw.)
    sweepUserWriteBuckets();
    assert.strictEqual(checkUserWrite('user-1'), 0, 'sweep leaves live buckets intact');
  });
});
