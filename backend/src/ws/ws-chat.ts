/**
 * ws-chat.ts
 * WSD-Pro — Global chatbot over WebSocket (Ollama Cloud, qwen3:30b).
 * History is persisted via chat-store under slug 'global'.
 * Protocol (client → server, JSON):
 *   { type: "prompt", text }         → start a streaming reply (one per chat)
 * Protocol (server → client, JSON):
 *   { type: "replay", events: ChatEvent[] } → full history on connect
 *   { type: "started" }
 *   { type: "event", event: ChatEvent }     → live event
 *   { type: "error", message }
 */
import { WebSocket } from 'ws';
import { chatStore } from '../services/chat-store';
import { streamChat, RunControl, type ChatMessage } from '../services/ollama-chat';

const MAX_PROMPT_CHARS = 20000;
const MAX_HISTORY_TURNS = 20;
const active = new Map<string, boolean>();
const controls = new Map<string, RunControl>();
const subscribers = new Map<string, Set<WebSocket>>();

function roomKey(slug: string, chatId: string): string {
  return `${slug}:${chatId}`;
}

function normalizePrompt(raw: any): string | null {
  if (!raw || typeof raw !== 'object' || raw.type !== 'prompt') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  if (text.length > MAX_PROMPT_CHARS) return null;
  return text;
}

/** Recent history (user + assistant) to give the model context, newest last. */
function buildHistory(slug: string, chatId: string): ChatMessage[] {
  const events = chatStore.readEvents(slug, chatId);
  const turns: ChatMessage[] = [];
  for (const ev of events) {
    if (ev.type === 'user_message') {
      turns.push({ role: 'user', content: ev.content });
    } else if (ev.type === 'agent_done') {
      turns.push({ role: 'assistant', content: ev.content });
    }
  }
  return turns.slice(-MAX_HISTORY_TURNS * 2);
}

export function handleChatSocket(ws: WebSocket, slug: string, chatId: string, onRelease: () => void): void {
  const room = roomKey(slug, chatId);
  const events = chatStore.readEvents(slug, chatId);
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

    const text = normalizePrompt(msg);
    if (!text) {
      sendJson(ws, { type: 'error', message: 'Invalid prompt payload' });
      return;
    }

    if (active.get(room)) {
      sendJson(ws, { type: 'error', message: 'A reply is already running. Wait for it to finish.' });
      return;
    }
    active.set(room, true);

    const userEvent = chatStore.append(slug, chatId, 'user_message', text);
    broadcast(room, { type: 'event', event: userEvent });

    const control: RunControl = { cancelled: false, abort: null };
    controls.set(room, control);

    streamChat(
      [...buildHistory(slug, chatId), { role: 'user', content: text }],
      {
        onDelta: (delta) => {
          const ev = chatStore.append(slug, chatId, 'agent_chunk', delta);
          broadcast(room, { type: 'event', event: ev });
        },
        onDone: (final) => {
          const ev = chatStore.append(slug, chatId, 'agent_done', final);
          broadcast(room, { type: 'event', event: ev });
          active.delete(room);
          controls.delete(room);
        },
        onError: (error) => {
          const ev = chatStore.append(slug, chatId, 'agent_error', error);
          broadcast(room, { type: 'event', event: ev });
          active.delete(room);
          controls.delete(room);
        },
      },
      control
    ).catch((err: any) => {
      active.delete(room);
      controls.delete(room);
      sendJson(ws, { type: 'error', message: err?.message || String(err) });
    });

    broadcast(room, { type: 'started' });
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
