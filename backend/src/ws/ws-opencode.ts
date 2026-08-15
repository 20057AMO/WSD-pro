/**
 * ws-opencode.ts
 * WSD-Pro — opencode build panel over WebSocket.
 * Streams `opencode run` output from the project's workspace.
 * History is persisted via chat-store under slug + chatId 'opencode'.
 * Protocol (client → server, JSON):
 *   { type: "run", prompt }          → start a run (one per project)
 *   { type: "stop" }                 → kill the running opencode process
 * Protocol (server → client, JSON):
 *   { type: "replay", events: ChatEvent[] } → full history on connect
 *   { type: "started" }
 *   { type: "event", event: ChatEvent }
 *   { type: "error", message }
 */
import { WebSocket } from 'ws';
import { chatStore } from '../services/chat-store';
import { runOpenCode, RunControl } from '../services/opencode-runner';
import { getProject } from '../services/docker-manager';

const CHAT_ID = 'opencode';
const MAX_PROMPT_CHARS = 20000;
const active = new Map<string, boolean>();
const controls = new Map<string, RunControl>();
const subscribers = new Map<string, Set<WebSocket>>();

function roomKey(slug: string): string {
  return `opencode:${slug}`;
}

function normalizePrompt(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'stop') return 'stop';
  if (raw.type !== 'run') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  if (text.length > MAX_PROMPT_CHARS) return null;
  return text;
}

export async function handleOpenCodeSocket(ws: WebSocket, slug: string, onRelease: () => void): Promise<void> {
  const room = roomKey(slug);
  const project = await getProject(slug);
  if (!project) {
    sendJson(ws, { type: 'error', message: `Project '${slug}' not found` });
    onRelease();
    ws.close(1008, 'project not found');
    return;
  }

  const events = chatStore.readEvents(slug, CHAT_ID);
  sendJson(ws, { type: 'replay', events });

  if (!subscribers.has(room)) subscribers.set(room, new Set());
  subscribers.get(room)!.add(ws);

  const release = () => {
    const set = subscribers.get(room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) subscribers.delete(room);
    }
    onRelease();
  };

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    const cmd = normalizePrompt(msg);
    if (cmd === 'stop') {
      const control = controls.get(room);
      if (control) {
        control.cancelled = true;
        if (control.kill) control.kill();
        controls.delete(room);
      }
      active.delete(room);
      return;
    }
    if (cmd === null) {
      sendJson(ws, { type: 'error', message: 'Invalid run payload' });
      return;
    }

    if (active.get(room)) {
      sendJson(ws, { type: 'error', message: 'A run is already active for this project. Stop it first.' });
      return;
    }
    active.set(room, true);

    const userEvent = chatStore.append(slug, CHAT_ID, 'user_message', cmd);
    broadcast(room, { type: 'event', event: userEvent });

    const control: RunControl = { cancelled: false, kill: null };
    controls.set(room, control);

    try {
      runOpenCode(
        slug,
        cmd,
        {
          onChunk: (text) => {
            const ev = chatStore.append(slug, CHAT_ID, 'agent_chunk', text);
            broadcast(room, { type: 'event', event: ev });
          },
          onDone: (final) => {
            const ev = chatStore.append(slug, CHAT_ID, 'agent_done', final);
            broadcast(room, { type: 'event', event: ev });
            active.delete(room);
            controls.delete(room);
          },
          onError: (error) => {
            const ev = chatStore.append(slug, CHAT_ID, 'agent_error', error);
            broadcast(room, { type: 'event', event: ev });
            active.delete(room);
            controls.delete(room);
          },
        },
        control
      );
      broadcast(room, { type: 'started' });
    } catch (err: any) {
      active.delete(room);
      controls.delete(room);
      sendJson(ws, { type: 'error', message: err?.message || String(err) });
    }
  });

  ws.on('close', release);
  ws.on('error', release);
}

function broadcast(room: string, payload: unknown): void {
  const set = subscribers.get(room);
  if (!set) return;
  const text = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
