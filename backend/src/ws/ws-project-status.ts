/**
 * ws-project-status.ts
 * WSD-Pro — Push project status + stats over WebSocket.
 * Polls container inspect every 3 s; only sends when status or stats change.
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

async function inspectStatus(slug: string): Promise<StatusSnapshot> {
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

export function handleProjectStatusSocket(
  ws: WebSocket,
  slug: string,
  onRelease: () => void,
): void {
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let prev: StatusSnapshot | null = null;

  const send = (obj: unknown) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  };

  const tick = async () => {
    if (closed) return;
    const snap = await inspectStatus(slug);
    if (closed) return;
    if (!prev || !snapshotEqual(prev, snap)) {
      send({ type: prev ? 'update' : 'ready', status: snap.status, stats: snap.stats });
      prev = snap;
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    onRelease();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  tick().then(() => {
    if (!closed) timer = setInterval(tick, POLL_MS);
  });
}
