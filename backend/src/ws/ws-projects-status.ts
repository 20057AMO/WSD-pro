/**
 * ws-projects-status.ts
 * Madar — Global project status broadcaster over WebSocket.
 * Uses a shared broadcaster: ONE listContainers per 4 s tick while ≥1 subscriber,
 * fanned out to all.  Per-connection timers eliminated.
 * Frames: { type:'ready', projects:[{ slug, status }] }
 *         { type:'update', slug, status }
 */
import { WebSocket } from 'ws';
import Docker from 'dockerode';

const docker = new Docker();
const POLL_MS = 4000;

interface ProjectStatus {
  slug: string;
  status: 'running' | 'stopped' | 'missing';
}

async function scanStatuses(): Promise<ProjectStatus[]> {
  try {
    const containers = await docker.listContainers({ all: true });
    const result: ProjectStatus[] = [];
    for (const c of containers) {
      const labels = c.Labels || {};
      if (labels['wsd.managed'] !== 'true') continue;
      const slug = labels['wsd.project'] || c.Names[0]?.replace(/^\//, '');
      result.push({
        slug,
        status: c.State === 'running' ? 'running' : 'stopped',
      });
    }
    return result;
  } catch {
    return [];
  }
}

// ── Shared broadcaster state ────────────────────────────────────

interface Broadcaster {
  timer: ReturnType<typeof setInterval> | null;
  subs: Set<WebSocket>;
  prev: ProjectStatus[];
  inFlight: boolean;
}

const broadcaster: Broadcaster = { timer: null, subs: new Set(), prev: [], inFlight: false };

// ── Broadcaster internals ──────────────────────────────────────

function sendToSub(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

async function tick(): Promise<void> {
  if (broadcaster.inFlight || broadcaster.subs.size === 0) return;
  broadcaster.inFlight = true;
  try {
    const current = await scanStatuses();
    if (broadcaster.subs.size === 0) return;
    if (broadcaster.prev.length === 0) {
      // First scan (or after reset) — send full list to every subscriber
      const msg = { type: 'ready', projects: current };
      for (const ws of broadcaster.subs) sendToSub(ws, msg);
    } else {
      for (const p of current) {
        const old = broadcaster.prev.find((x) => x.slug === p.slug);
        if (!old || old.status !== p.status) {
          const msg = { type: 'update', slug: p.slug, status: p.status };
          for (const ws of broadcaster.subs) sendToSub(ws, msg);
        }
      }
    }
    broadcaster.prev = current;
  } catch {
    // Swallow — next tick retries
  } finally {
    broadcaster.inFlight = false;
  }
}

function startTimer(): void {
  if (broadcaster.timer) return;
  broadcaster.timer = setInterval(tick, POLL_MS);
}

function stopTimer(): void {
  if (broadcaster.timer) { clearInterval(broadcaster.timer); broadcaster.timer = null; }
}

// ── Public entry point (same signature as before) ──────────────

export function handleProjectsStatusSocket(
  ws: WebSocket,
  onRelease: () => void,
): void {
  let closed = false;

  broadcaster.subs.add(ws);

  // A new subscriber must receive the current project list immediately (same
  // contract as the original per-connection 'ready' frame). If a snapshot is
  // already known, push it now; otherwise the scheduled tick will deliver it.
  if (broadcaster.prev.length > 0) {
    sendToSub(ws, { type: 'ready', projects: broadcaster.prev });
  }

  const cleanup = () => {
    if (closed) return;
    closed = true;
    broadcaster.subs.delete(ws);
    if (broadcaster.subs.size === 0) {
      stopTimer();
      broadcaster.prev = [];
    }
    if (ws.readyState === WebSocket.OPEN) ws.close();
    onRelease();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  // First subscriber's tick delivers the initial snapshot, then the interval
  // takes over.
  void tick().then(() => {
    if (!closed) startTimer();
  });
}

// ── Shutdown hook ──────────────────────────────────────────────

export function shutdownProjectsStatusBroadcaster(): void {
  stopTimer();
  for (const ws of broadcaster.subs) {
    try { ws.close(); } catch { /* already gone */ }
  }
  broadcaster.subs.clear();
  broadcaster.prev = [];
}
