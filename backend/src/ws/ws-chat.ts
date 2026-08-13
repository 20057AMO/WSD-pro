/**
 * ws-chat.ts
 * WSD-Pro — Streaming agent chat over WebSocket.
 * Protocol (client → server, JSON):
 *   { type: "prompt", agent, text }        → start a streaming run (one per chat)
 * Protocol (server → client, JSON):
 *   { type: "replay", events: ChatEvent[] } → full history on connect
 *   { type: "started", taskId }             → run started
 *   { type: "event", event: ChatEvent }     → live event (user_message/agent_chunk/agent_done/agent_error)
 *   { type: "error", message }
 */
import { WebSocket } from 'ws';
import { chatStore, ChatEvent } from '../services/chat-store';
import { getAgents, runAgentStreaming } from '../services/agents-manager';

const MAX_PROMPT_CHARS = 20000;
const active = new Map<string, boolean>();
const subscribers = new Map<string, Set<WebSocket>>();

function roomKey(slug: string, chatId: string): string {
  return `${slug}:${chatId}`;
}

function normalizePrompt(raw: any): { agent: string; text: string } | null {
  if (!raw || typeof raw !== 'object' || raw.type !== 'prompt') return null;

  const agent = typeof raw.agent === 'string' ? raw.agent.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!agent || !text) return null;
  if (text.length > MAX_PROMPT_CHARS) return null;

  const allowedAgents = new Set(getAgents().map((a) => a.name));
  if (!allowedAgents.has(agent)) return null;

  return { agent, text };
}

export function handleChatSocket(ws: WebSocket, slug: string, chatId: string): void {
  const room = roomKey(slug, chatId);
  const events = chatStore.readEvents(slug, chatId);
  sendJson(ws, { type: 'replay', events });

  if (!subscribers.has(room)) subscribers.set(room, new Set());
  subscribers.get(room)!.add(ws);

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    const prompt = normalizePrompt(msg);
    if (!prompt) {
      sendJson(ws, { type: 'error', message: 'Invalid prompt payload' });
      return;
    }

    if (active.get(room)) {
      sendJson(ws, { type: 'error', message: 'A run is already active in this chat. Wait for it to finish.' });
      return;
    }
    active.set(room, true);

    const userEvent = chatStore.append(slug, chatId, 'user_message', prompt.text);
    broadcast(room, { type: 'event', event: userEvent });

    try {
      const task = runAgentStreaming(
        prompt.agent,
        slug,
        prompt.text,
        {
          onChunk: (text) => {
            const ev = chatStore.append(slug, chatId, 'agent_chunk', text);
            broadcast(room, { type: 'event', event: ev });
          },
          onDone: (final) => {
            const ev = chatStore.append(slug, chatId, 'agent_done', final);
            broadcast(room, { type: 'event', event: ev });
            active.delete(room);
          },
          onError: (error) => {
            const ev = chatStore.append(slug, chatId, 'agent_error', error);
            broadcast(room, { type: 'event', event: ev });
            active.delete(room);
          },
        },
        chatId // task id == chat id → stories map 1:1 to Task History
      );
      broadcast(room, { type: 'started', taskId: task.id });
    } catch (err: any) {
      active.delete(room);
      sendJson(ws, { type: 'error', message: err?.message || String(err) });
    }
  });

  ws.on('close', () => {
    const set = subscribers.get(room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) subscribers.delete(room);
    }
  });
  ws.on('error', () => {
    const set = subscribers.get(room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) subscribers.delete(room);
    }
  });
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