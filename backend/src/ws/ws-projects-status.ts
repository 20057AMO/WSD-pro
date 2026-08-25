/**
 * ws-projects-status.ts
 * Madar — Global project status broadcaster over WebSocket.
 * Polls all containers every 4 s; only sends when any project's status or stats change.
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


export function handleProjectsStatusSocket(
  ws: WebSocket,
  onRelease: () => void,
): void {
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let prev: ProjectStatus[] = [];

  const send = (obj: unknown) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  };

  const tick = async () => {
    if (closed) return;
    const current = await scanStatuses();
    if (closed) return;

    if (prev.length === 0) {
      send({ type: 'ready', projects: current });
    } else {
      for (const p of current) {
        const old = prev.find((x) => x.slug === p.slug);
        if (!old || old.status !== p.status) {
          send({ type: 'update', slug: p.slug, status: p.status });
        }
      }
    }
    prev = current;
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
