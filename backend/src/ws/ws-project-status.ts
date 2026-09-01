/**
 * ws-project-status.ts
 * Madar — Push project status + stats over WebSocket.
 * Uses a shared per-room broadcaster: ONE Docker inspect+stats per 3 s tick,
 * fanned out to all subscribers.  Per-connection timers eliminated.
 * Frames: { type:'ready', status, stats } | { type:'update', status, stats } | { type:'error', message }.
 */
import { WebSocket } from 'ws';
import Docker from 'dockerode';

const docker = new Docker();
const POLL_MS = 3000;

interface StatusSnapshot {
  status: 'running' | 'stopped' | 'missing';
  stats: { running: boolean; cpuPct: number; memBytes: number; memLimit: number; memPct: number; startedAt: string | null } | null;
}

// ── Shared broadcaster state ────────────────────────────────────
interface Room {
  timer: ReturnType<typeof setInterval> | null;
  subs: Set<WebSocket>;
  prev: StatusSnapshot | null;
  inFlight: boolean;
}

const rooms = new Map<string, Room>();

// ── Pure helpers (exported for testing) ─────────────────────────

export async function inspectStatus(slug: string): Promise<StatusSnapshot> {
  try {
    const container = docker.getContainer(`wsd-${slug}`);
    const data = await container.inspect();
    const running = !!data.State?.Running;
    const status: StatusSnapshot['status'] = running ? 'running' : 'stopped';

    let stats: StatusSnapshot['stats'] = null;
    if (running) {
      try {
        const s = await container.stats({ stream: false }) as any;
        const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
        const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 1);
        const cpuCount = s.cpu_stats?.online_cpus ?? 1;
        const cpuPct = sysDelta > 0 ? +((cpuDelta / sysDelta) * cpuCount * 100).toFixed(1) : 0;
        const memBytes = s.memory_stats?.usage ?? 0;
        const memLimit = s.memory_stats?.limit ?? 1;
        stats = {
          running: true,
          cpuPct,
          memBytes,
          memLimit,
          memPct: +((memBytes / memLimit) * 100).toFixed(1),
          startedAt: data.State?.StartedAt || null,
        };
      } catch {
        stats = { running: true, cpuPct: 0, memBytes: 0, memLimit: 1, memPct: 0, startedAt: data.State?.StartedAt || null };
      }
    }

    return { status, stats };
  } catch {
    return { status: 'missing', stats: null };
  }
}

function snapshotEqual(a: StatusSnapshot, b: StatusSnapshot): boolean {
  if (a.status !== b.status) return false;
  if (a.stats === null && b.stats === null) return true;
  if (a.stats === null || b.stats === null) return false;
  return a.stats.cpuPct === b.stats.cpuPct && a.stats.memBytes === b.stats.memBytes && a.stats.memPct === b.stats.memPct;
}

// ── Broadcaster internals ──────────────────────────────────────

function sendToSub(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

async function tick(slug: string): Promise<void> {
  const room = rooms.get(slug);
  if (!room || room.inFlight || room.subs.size === 0) return; // singleflight + bail
  room.inFlight = true;
  try {
    const snap = await inspectStatus(slug);
    // Re-check after await — subs may have been drained
    if (room.subs.size === 0) return;
    if (!room.prev || !snapshotEqual(room.prev, snap)) {
      const msg = { type: room.prev ? 'update' : 'ready', status: snap.status, stats: snap.stats };
      for (const ws of room.subs) sendToSub(ws, msg);
      room.prev = snap;
    }
  } catch {
    // Swallow — next tick retries
  } finally {
    room.inFlight = false;
  }
}

function startTimer(slug: string): void {
  const room = rooms.get(slug);
  if (!room || room.timer) return;
  room.timer = setInterval(() => { void tick(slug); }, POLL_MS);
}

function stopTimer(slug: string): void {
  const room = rooms.get(slug);
  if (!room) return;
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
}

function removeSub(slug: string, ws: WebSocket): void {
  const room = rooms.get(slug);
  if (!room) return;
  room.subs.delete(ws);
  if (room.subs.size === 0) {
    stopTimer(slug);
    rooms.delete(slug);
  }
}

// ── Public entry point (same signature as before) ──────────────

export function handleProjectStatusSocket(
  ws: WebSocket,
  slug: string,
  onRelease: () => void,
): void {
  let closed = false;

  // Register subscriber
  let room = rooms.get(slug);
  if (!room) {
    room = { timer: null, subs: new Set(), prev: null, inFlight: false };
    rooms.set(slug, room);
  }
  room.subs.add(ws);

  // Every new subscriber must receive the current state immediately (same
  // contract as the original per-connection 'ready' frame). If a snapshot is
  // already known, push it; otherwise the scheduled tick will deliver it.
  if (room.prev) {
    sendToSub(ws, { type: 'ready', status: room.prev.status, stats: room.prev.stats });
  }

  // Wire disconnect → unsubscribe → possibly destroy room
  const cleanup = () => {
    if (closed) return;
    closed = true;
    removeSub(slug, ws);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    onRelease();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  // First subscriber's tick delivers the initial snapshot, then the interval
  // takes over. If a tick is already in-flight (from a sibling subscriber) the
  // singleflight guard skips overlapping work — we'll receive the next broadcast.
  void tick(slug).then(() => {
    if (!closed) startTimer(slug);
  });
}

// ── Shutdown hook — clears all timers ──────────────────────────

export function shutdownProjectStatusBroadcasters(): void {
  for (const [slug, room] of rooms) {
    stopTimer(slug);
    for (const ws of room.subs) {
      try { ws.close(); } catch { /* already gone */ }
    }
  }
  rooms.clear();
}
