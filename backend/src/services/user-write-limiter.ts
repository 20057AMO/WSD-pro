/**
 * user-write-limiter.ts
 * Madar — Per-user write rate limiter (in-memory, fixed window).
 *
 * Protects NAT-shared deployments and runaway agents: HTTP routes apply it as
 * Express middleware (see index.ts `userWriteLimiter`), and the WebSocket chat
 * / agent handlers call `checkUserWrite` on every `prompt` message. In both
 * cases the budget is keyed on the authenticated USER id, so many real users
 * behind one public IP never starve each other — while a single runaway user
 * is capped regardless of how many IPs they rotate through.
 *
 * Pure logic is import-free so node --test can load it directly.
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 120;

const buckets = new Map<string, { count: number; resetAt: number }>();

function keyFor(userId?: string | null, ip?: string | null): string {
  if (userId) return `u:${userId}`;
  return `ip:${ip || 'unknown'}`;
}

/**
 * Check whether the given user (falling back to IP) is within write budget.
 * Returns 0 when allowed (and consumes one slot), or the seconds to wait
 * before retrying when over budget. Counter is NOT consumed on rejection.
 */
export function checkUserWrite(userId?: string | null, ip?: string | null, windowMs?: number, max?: number): number {
  const win = windowMs ?? DEFAULT_WINDOW_MS;
  const cap = max ?? DEFAULT_MAX;
  const key = keyFor(userId, ip);
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + win });
    return 0;
  }
  // Over budget — leave the counter unchanged.
  if (entry.count > cap) {
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }
  entry.count += 1;
  if (entry.count > cap) {
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }
  return 0;
}

/** Clear stale buckets (call on an interval to bound memory). */
export function sweepUserWriteBuckets(): void {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

/** Reset all buckets — used by tests. */
export function resetUserWriteBuckets(): void {
  buckets.clear();
}
