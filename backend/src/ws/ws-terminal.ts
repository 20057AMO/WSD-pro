/**
 * ws-terminal.ts
 * WSD-Pro — Interactive container terminal over WebSocket.
 * Protocol (client → server, JSON):  { type: "input", data } | { type: "resize", cols, rows }
 * Protocol (server → client): raw binary frames (terminal output) +
 *   JSON control frames: { type: "ready" } | { type: "exit" } | { type: "error", message }
 */
import { WebSocket } from 'ws';
import { startInteractiveShell, resizeExecSession, ExecSession } from '../services/docker-manager';

export async function handleTerminalSocket(ws: WebSocket, slug: string): Promise<void> {
  let session: ExecSession | null = null;
  try {
    session = await startInteractiveShell(slug);
  } catch (err: any) {
    sendJson(ws, { type: 'error', message: err?.message || 'Cannot attach terminal' });
    ws.close(1011, 'terminal error');
    return;
  }

  sendJson(ws, { type: 'ready' });

  // Terminal output → raw binary frames (TTY bytes, not multiplexed)
  session.stream.on('data', (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  session.stream.on('end', () => {
    sendJson(ws, { type: 'exit' });
    ws.close();
  });
  session.stream.on('error', () => {
    sendJson(ws, { type: 'exit' });
    ws.close();
  });

  ws.on('message', (data) => {
    if (!session) return;
    const raw = data.toString('utf8');
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        const cols = Math.max(2, Math.min(400, Number(msg.cols) || 80));
        const rows = Math.max(1, Math.min(200, Number(msg.rows) || 24));
        resizeExecSession(session, cols, rows).catch(() => {});
      } else if (msg.type === 'input' && typeof msg.data === 'string') {
        session.stream.write(msg.data);
      }
    } catch {
      // not JSON → treat as raw input
      session.stream.write(raw);
    }
  });

  ws.on('close', () => {
    cleanup(session);
    session = null;
  });
  ws.on('error', () => {
    cleanup(session);
    session = null;
  });
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function cleanup(session: ExecSession | null): void {
  try {
    if (session) session.stream.destroy();
  } catch { /* ignore */ }
}