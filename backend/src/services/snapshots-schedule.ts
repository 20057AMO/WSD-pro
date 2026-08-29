/**
 * snapshots-schedule.ts
 * Madar — Pure scheduling rules for automated snapshots.
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * janitor-core.ts): no fs/docker imports, just constants + one pure function,
 * so the interval/retention decisions are deterministically unit-testable.
 */

/** Allowed snapshot intervals in minutes (kept finite so the scheduler and
 * the UI agree). 1h · 3h · 6h · 12h · 24h · 7d. */
export const SNAPSHOT_INTERVALS = [60, 180, 360, 720, 1440, 10080];
export const MAX_KEEP = 20;
export const DEFAULT_SCHEDULE = { enabled: false, intervalMin: 1440, keep: 5 };

export interface SnapScheduleLike {
  enabled: boolean;
  intervalMin: number;
  keep: number;
}

/**
 * Merge untrusted input onto the current schedule, preferring previous config
 * (then defaults) for any value that fails validation.
 */
export function sanitizeSchedule(
  input: Record<string, unknown>,
  current?: SnapScheduleLike | null,
): SnapScheduleLike {
  const prev = current || DEFAULT_SCHEDULE;
  const enabled =
    typeof input?.enabled === 'boolean' ? input.enabled : prev.enabled;
  const intervalMin =
    typeof input?.intervalMin === 'number' && SNAPSHOT_INTERVALS.includes(input.intervalMin)
      ? input.intervalMin
      : prev.intervalMin;
  const keep =
    Number.isInteger(input?.keep) && Number(input.keep) >= 1 && Number(input.keep) <= MAX_KEEP
      ? Number(input.keep)
      : prev.keep;
  return { enabled, intervalMin, keep };
}

interface DueInput {
  slug: string;
  schedule?: SnapScheduleLike | null;
  lastSnapshotAt?: string | null;
}

/** Pure "which projects are due right now" — gap since last snapshot vs interval. */
export function computeDueSnapshots(projects: DueInput[], now: number): string[] {
  const due: string[] = [];
  for (const p of projects) {
    if (!p.schedule?.enabled) continue;
    const last = p.lastSnapshotAt ? new Date(p.lastSnapshotAt).getTime() : 0;
    const gapMs = (p.schedule.intervalMin || DEFAULT_SCHEDULE.intervalMin) * 60_000;
    if (now - last >= gapMs) due.push(p.slug);
  }
  return due;
}