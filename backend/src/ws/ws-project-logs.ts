/**
 * ws-project-logs.ts
 * Madar — Live tail of a project container's logs over WebSocket.
 * Frames: { type: 'ready' } | { type: 'logs', data: string } | { type: 'error', message }.
 */
import { WebSocket } from 'ws';
import Docker from 'dockerode';

const docker = new Docker();

export function handleProjectLogsSocket(
  ws: WebSocket,
  slug: string,
  onRelease: () => void
): void {
  const container = docker.getContainer(`wsd-${slug}`);
  container
    .logs({ stdout: true, stderr: true, tail: 200, follow: true })
    .then((stream: any) => {
      if (ws.readyState !== WebSocket.OPEN) {
        stream.destroy();
        onRelease();
        return;
      }
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
        if (ws.readyState === WebSocket.OPEN) ws.close();
        onRelease();
      };
      stream.on('data', (chunk: Buffer) => {
        if (closed) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'logs', data: chunk.toString('utf8') }));
        }
      });
      stream.on('close', () => close());
      stream.on('end', () => close());
      stream.on('error', () => close());
      ws.on('close', () => close());
      ws.on('error', () => close());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ready' }));
      }
    })
    .catch((err: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: err?.statusCode === 404
              ? `Project container 'wsd-${slug}' not found.`
              : `Failed to tail logs: ${String(err?.message || err)}`,
          })
        );
        ws.close(1011, 'logs failed');
      }
      onRelease();
    });
}
