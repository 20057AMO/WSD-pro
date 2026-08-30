/**
 * project-alerts.ts
 * Madar — Container-crash detection.
 *
 * A dedicated background sweep inspects every live project's container and
 * distinguishes an EXPLICIT stop from a CRASH. Because projects are created
 * with RestartPolicy:unless-stopped, hard crashes (non-zero exit, OOM kill)
 * silently auto-restart — so the detector compares RestartCount/StartedAt
 * deltas against meta.crashWatch and flags a crash even when the container
 * is already running again.
 *
 * Detection is server-authoritative and WebSocket-independent: the /ws
 * status broadcaster only ticks while a subscriber is connected, but a crash
 * must be caught with zero browsers open. On detection: persist meta.crash
 * (surfaced as a red chip/banner), record an audit entry and fire the
 * `crash` webhook. Fire-once per incident — an explicit start/recreate
 * clears the flag; a NEW restart cycle after recovery fires again.
 *
 * The pure classifyCrash() rule is unit-testable without Docker (mirrors
 * the janitor-core / snapshots-schedule import-free pattern).
 */
import Docker from 'dockerode';
import type { CrashInfo } from './projects-meta';
import { loadMeta, listMetaSlugs, saveMeta, setCrashState, setCrashWatch } from './projects-meta';
import { recordAudit } from './audit-store';
import { dispatchWebhook } from './webhook-sender';
import { classifyCrash, type InspectStateExcerpt } from './alerts-core';

export type {
  CrashInfo,
  CrashWatch,
  InspectStateExcerpt,
  ClassifyInput,
  ClassifyResult,
} from './alerts-core';
export { classifyCrash } from './alerts-core';

const docker = new Docker();

export const ALERT_SWEEP_MS = Math.max(5_000, Number(process.env.WSD_ALERT_SWEEP_MS) || 10_000);

/** Inspect one project container; null when it no longer exists. */
async function getContainerState(slug: string): Promise<InspectStateExcerpt | null> {
  try {
    const data = await docker.getContainer(`wsd-${slug}`).inspect();
    // dockerode's State type omits RestartCount — it actually lives at the
    // inspect top level next to State, so read it via the raw record.
    const st = (data.State || {}) as Record<string, unknown>;
    const raw = data as unknown as Record<string, unknown>;
    const restartCount = typeof raw.RestartCount === 'number' ? raw.RestartCount : 0;
    return {
      status: String(st.Status ?? ''),
      running: Boolean(st.Running),
      exitCode: typeof st.ExitCode === 'number' ? st.ExitCode : null,
      oomKilled: Boolean(st.OOMKilled),
      restartCount,
      startedAt: String(st.StartedAt ?? ''),
    };
  } catch {
    return null;
  }
}

// ── Sweep ────────────────────────────────────────────────────────────────

let sweeping = false;

/**
 * One sweep pass: classify every live project, fire once per NEW crash.
 * Singleflight — overlapping sweeps (slow inspect passes) are skipped, never
 * queued, so a thundering sweep can't double-fire or pile up.
 */
export async function sweepProjectAlerts(): Promise<string[]> {
  if (sweeping) return [];
  sweeping = true;
  const fired: string[] = [];
  try {
    for (const slug of listMetaSlugs()) {
      try {
        const state = await getContainerState(slug);
        if (!state) continue; // container gone — janitor/'missing' territory, not a crash
        const meta = loadMeta(slug);
        if (!meta) continue;
        const res = classifyCrash({
          state,
          requestedStop: meta.requestedStop === true,
          watch: meta.crashWatch || null,
          alreadyCrashed: !!meta.crash,
          crashReason: meta.crash?.reason,
          crashStartedAt: meta.crash?.startedAt,
        });
        if (res.crash && res.fire) {
          setCrashState(slug, res.crash);
          recordAudit('container-crash', true);
          dispatchWebhook('crash', {
            event: 'crash',
            slug,
            name: meta.name || slug,
            at: res.crash.at,
            reason: res.crash.reason,
            exitCode: res.crash.exitCode,
            oomKilled: res.crash.reason === 'oom',
          });
          fired.push(slug);
        }
        setCrashWatch(slug, res.watch);
      } catch (err: any) {
        console.warn(`[alerts] inspect failed for ${slug}:`, err?.message || err);
      }
    }
  } finally {
    sweeping = false;
  }
  return fired;
}

/**
 * Clear crash/requestedStop and re-seed the watch from the live container,
 * called by explicit start/recreate/create so the next crash is never
 * mistaken for the previous one.
 */
export async function resetCrashState(slug: string): Promise<void> {
  const meta = loadMeta(slug);
  if (!meta) return;
  delete meta.crash;
  delete meta.requestedStop;
  const state = await getContainerState(slug);
  if (state) meta.crashWatch = { restartCount: state.restartCount, startedAt: state.startedAt };
  else delete meta.crashWatch;
  saveMeta(slug, meta);
}

// ── Automation loop (mirrors project-snapshots-auto's boot pattern) ─────

let deferTimer: NodeJS.Timeout | null = null;

/** Defer one sweep shortly (used at boot). */
export function scheduleAlertSweep(delayMs = 5000): void {
  if (deferTimer) clearTimeout(deferTimer);
  deferTimer = setTimeout(() => {
    deferTimer = null;
    void sweepProjectAlerts();
  }, Math.max(250, delayMs));
}

/** Boot the crash detector (from index.ts). */
export function startAlertsAutomation(): void {
  const iv = setInterval(() => void sweepProjectAlerts(), ALERT_SWEEP_MS);
  iv.unref?.();
  console.log(`[Madar] Crash alerts: sweep interval ${Math.round(ALERT_SWEEP_MS / 1000)}s`);
  scheduleAlertSweep();
}