/**
 * ws-terminal.ts
 * WSD-Pro — Interactive container terminal over WebSocket.
 * Protocol (client → server, JSON):  { type: "input", data } | { type: "resize", cols, rows }
 * Protocol (server → client): raw binary frames (terminal output) +
 *   JSON control frames: { type: "ready" } | { type: "exit" } | { type: "error", message }
 */
import { WebSocket } from 'ws';
import { startInteractiveShell, resizeExecSession, ExecSession } from '../services/docker-manager';

const MAX_TERMINAL_PAYLOAD = 65536;

function normalizeTerminalMessage(raw: unknown): { type: 'input' | 'resize'; value?: string; cols?: number; rows?: number } | null {
  let text: string;

  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString('utf8');
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(String(part)))).toString('utf8');
  } else if (raw && typeof raw === 'object' && 'byteLength' in raw && 'slice' in raw) {
    const view = raw as Uint8Array;
    text = Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8');
  } else {
    return null;
  }

  if (!text || text.length > MAX_TERMINAL_PAYLOAD) return null;

  try {
    const msg = JSON.parse(text);
    if (!msg || typeof msg !== 'object') return null;

    if (msg.type === 'resize') {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
      return {
        type: 'resize',
        cols: Math.max(2, Math.min(400, cols || 80)),
        rows: Math.max(1, Math.min(200, rows || 24)),
      };
    }

    if (msg.type === 'input' && typeof msg.data === 'string') {
      return { type: 'input', value: msg.data.slice(0, MAX_TERMINAL_PAYLOAD) };
    }

    return null;
  } catch {
    return { type: 'input', value: text.slice(0, MAX_TERMINAL_PAYLOAD) };
  }
}

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

  ws.on('message', (data: unknown) => {
    if (!session) return;
    const parsed = normalizeTerminalMessage(data);
    if (!parsed) {
      sendJson(ws, { type: 'error', message: 'Invalid terminal payload' });
      return;
    }

    if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
      resizeExecSession(session, parsed.cols, parsed.rows).catch(() => { });
      return;
    }

    if (parsed.type === 'input' && typeof parsed.value === 'string') {
      session.stream.write(parsed.value);
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
    if (session) {
      if (session.stream && typeof session.stream.destroy === 'function') {
        session.stream.destroy();
      }
    }
  } catch { /* ignore */ }
}