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
import { runAgentStreaming } from '../services/agents-manager';

const active = new Map<string, boolean>();
const subscribers = new Map<string, Set<WebSocket>>();

export function handleChatSocket(ws: WebSocket, slug: string, chatId: string): void {
  const events = chatStore.readEvents(slug, chatId);
  sendJson(ws, { type: 'replay', events });

  if (!subscribers.has(chatId)) subscribers.set(chatId, new Set());
  subscribers.get(chatId)!.add(ws);

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type !== 'prompt' || !msg.text || !msg.agent) return;

    if (active.get(chatId)) {
      sendJson(ws, { type: 'error', message: 'A run is already active in this chat. Wait for it to finish.' });
      return;
    }
    active.set(chatId, true);

    const userEvent = chatStore.append(slug, chatId, 'user_message', msg.text);
    broadcast(chatId, { type: 'event', event: userEvent });

    try {
      const task = runAgentStreaming(
        msg.agent,
        slug,
        msg.text,
        {
          onChunk: (text) => {
            const ev = chatStore.append(slug, chatId, 'agent_chunk', text);
            broadcast(chatId, { type: 'event', event: ev });
          },
          onDone: (final) => {
            const ev = chatStore.append(slug, chatId, 'agent_done', final);
            broadcast(chatId, { type: 'event', event: ev });
            active.delete(chatId);
          },
          onError: (error) => {
            const ev = chatStore.append(slug, chatId, 'agent_error', error);
            broadcast(chatId, { type: 'event', event: ev });
            active.delete(chatId);
          },
        },
        chatId // task id == chat id → stories map 1:1 to Task History
      );
      broadcast(chatId, { type: 'started', taskId: task.id });
    } catch (err: any) {
      active.delete(chatId);
      sendJson(ws, { type: 'error', message: err?.message || String(err) });
    }
  });

  ws.on('close', () => {
    subscribers.get(chatId)?.delete(ws);
  });
  ws.on('error', () => {
    subscribers.get(chatId)?.delete(ws);
  });
}

function broadcast(chatId: string, payload: unknown): void {
  const set = subscribers.get(chatId);
  if (!set) return;
  const text = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}