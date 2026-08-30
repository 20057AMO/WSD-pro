/**
 * alerts-core.ts
 * Madar — Pure container-crash classification rules for the background alert
 * sweeper.
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * janitor-core.ts / snapshots-schedule.ts): no dockerode/fs imports, just
 * plain types + one pure function, so the crash-decision rules are
 * deterministically unit-testable without a container.
 */

/** The subset of docker inspect State the classifier reasons about. */
export interface InspectStateExcerpt {
  status: string;
  running: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  restartCount: number;
  startedAt: string;
}

/** Crash record persisted into project meta and surfaced in the UI. */
export interface CrashInfo {
  at: string;
  reason: 'exited' | 'oom' | 'restart';
  exitCode?: number;
  /** restart count recorded for a silent auto-restart crash. */
  restarted?: number;
  startedAt?: string;
}

/** Last-observed container epoch, persisted so deltas are detectable. */
export interface CrashWatch {
  restartCount: number;
  startedAt: string;
}

/** Wired inputs to the pure crash classifier. */
export interface ClassifyInput {
  state: InspectStateExcerpt;
  /** true when an explicit UI stop was requested for this container. */
  requestedStop: boolean;
  /** last-known container state, or null on first observation. */
  watch: CrashWatch | null;
  /** whether a crash is ALREADY flagged for this project. */
  alreadyCrashed: boolean;
  /** the flagged crash's reason (restart dedupe). */
  crashReason?: CrashInfo['reason'];
  /** the flagged crash's start epoch (restart re-fire detection). */
  crashStartedAt?: CrashInfo['startedAt'];
  now?: string;
}

export interface ClassifyResult {
  crash: CrashInfo | null;
  /** true when the crash is NEW and must be persisted + notified once. */
  fire: boolean;
  /** the watch to persist — always refreshed, even on clean states. */
  watch: CrashWatch;
}

/**
 * Pure classification. Never inspects anything — takes plain state + meta
 * excerpts so the rules are offline-testable.
 */
export function classifyCrash(input: ClassifyInput): ClassifyResult {
  const now = input.now || new Date().toISOString();
  const state = input.state;
  const watch: CrashWatch = {
    restartCount: state.restartCount || 0,
    startedAt: state.startedAt || '',
  };

  // Explicit UI stop — the exit is expected, never a crash.
  if (input.requestedStop) {
    return { crash: null, fire: false, watch };
  }

  // OOM-killed by the cgroup memory cap — even though unless-stopped will
  // bring it back, the user must know the app hit its memory limit.
  if (state.oomKilled) {
    return {
      crash: { at: now, reason: 'oom', exitCode: state.exitCode ?? undefined },
      fire: !input.alreadyCrashed,
      watch,
    };
  }

  // Hard exit with a non-zero code while nobody asked it to stop (e.g. the
  // container was docker-killed / the app aborted and never auto-restarted).
  if (!state.running && typeof state.exitCode === 'number' && state.exitCode !== 0) {
    return {
      crash: { at: now, reason: 'exited', exitCode: state.exitCode },
      fire: !input.alreadyCrashed,
      watch,
    };
  }

  // Silent restart: the container is running again but its start epoch
  // and/or restart counter moved while we performed no stop/start/recreate.
  const epochMoved =
    !!input.watch &&
    (input.watch.startedAt !== state.startedAt ||
      (input.watch.restartCount ?? 0) !== state.restartCount);
  if (state.running && epochMoved) {
    const crash: CrashInfo = {
      at: now,
      reason: 'restart',
      restarted: state.restartCount || 0,
      startedAt: state.startedAt || undefined,
    };
    // Re-fire only when this is a NEW start epoch the current crash record
    // has never referenced — silent-restart regressions after recovery still
    // alert, but one ongoing OOM/restart cycle never spams.
    const freshCycle =
      !input.alreadyCrashed ||
      (!!input.crashStartedAt && input.crashStartedAt !== state.startedAt && !!state.startedAt);
    return { crash, fire: freshCycle, watch };
  }

  // First observation of a running container that already carries restart
  // history we could not have caused (our create/start paths reset it to 0).
  if (state.running && !input.watch && state.restartCount > 0) {
    return {
      crash: { at: now, reason: 'restart', restarted: state.restartCount || 0, startedAt: state.startedAt || undefined },
      fire: !input.alreadyCrashed,
      watch,
    };
  }

  // Clean running container (or a gracefully-stopped / empty watched one).
  return { crash: null, fire: false, watch };
}