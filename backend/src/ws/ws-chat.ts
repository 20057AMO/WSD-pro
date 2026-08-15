/**
 * ws-chat.ts
 * WSD-Pro — Global chatbot over WebSocket (Ollama Cloud or local Ollama).
 * History is persisted via chat-store under slug 'global'.
 * Protocol (client → server, JSON):
 *   { type: "prompt", text, attachments? } → start a streaming reply (one per chat)
 *     attachments: [{ kind: "image"|"text"|"file", name, data?, text?, size? }]
 * Protocol (server → client, JSON):
 *   { type: "replay", events: ChatEvent[] } → full history on connect
 *   { type: "started" }
 *   { type: "event", event: ChatEvent }     → live event
 *   { type: "error", message }
 */
import { WebSocket } from 'ws';
import { chatStore, type ChatAttachment, type ChatEvent } from '../services/chat-store';
import { streamChat, RunControl, type ChatMessage } from '../services/ollama-chat';

const MAX_PROMPT_CHARS = 20000;
const MAX_HISTORY_TURNS = 20;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_FILE_CHARS = 100000;
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

function normalizeAttachments(raw: any): ChatAttachment[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_ATTACHMENTS) return null;

  const out: ChatAttachment[] = [];
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const kind = item.kind;
    if (kind !== 'image' && kind !== 'text' && kind !== 'file') return null;
    const name = String(item.name ?? 'file').slice(0, 255);
    let data: string | undefined;
    let text: string | undefined;
    let size = Number(item.size) || 0;

    if (kind === 'image') {
      data = String(item.data ?? '');
      if (!data.startsWith('data:image/')) return null;
      size = Math.max(size, Math.round((data.length * 3) / 4));
    } else if (kind === 'text') {
      text = String(item.text ?? '');
      if (text.length > MAX_TEXT_FILE_CHARS) return null;
      size = Buffer.byteLength(text, 'utf8');
    }

    total += size;
    if (total > MAX_ATTACHMENT_BYTES) return null;
    out.push({ kind, name, data, text, size });
  }
  return out;
}

/** Model-facing text for the current turn: prompt + inlined text files + binary markers. */
function buildUserContent(text: string, attachments: ChatAttachment[]): string {
  const parts: string[] = [text];
  for (const a of attachments) {
    if (a.kind === 'text' && a.text != null) {
      parts.push(`[attached file: ${a.name}]\n${a.text}`);
    } else if (a.kind === 'file') {
      parts.push(`[attached file: ${a.name} (${a.size} bytes) — binary, cannot read content]`);
    }
  }
  return parts.join('\n\n');
}

/** Strip the data-URI prefix so Ollama accepts the raw base64. */
function toBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

/** Reconstruct a model message from a persisted event (keeps image context). */
function eventToMessage(ev: ChatEvent): ChatMessage | null {
  if (ev.type === 'user_message') {
    const images = (ev.attachments || [])
      .filter((a) => a.kind === 'image' && a.data)
      .map((a) => toBase64(a.data!));
    return {
      role: 'user',
      content: ev.content,
      ...(images.length > 0 ? { images } : {}),
    };
  }
  if (ev.type === 'agent_done') {
    return { role: 'assistant', content: ev.content };
  }
  return null;
}

/** Recent history (user + assistant) to give the model context, newest last. */
function buildHistory(slug: string, chatId: string): ChatMessage[] {
  const events = chatStore.readEvents(slug, chatId);
  const turns: ChatMessage[] = [];
  for (const ev of events) {
    const msg = eventToMessage(ev);
    if (msg) turns.push(msg);
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

    const attachments = normalizeAttachments(msg.attachments);
    if (attachments === null) {
      sendJson(ws, { type: 'error', message: 'Invalid attachments (too many or too large)' });
      return;
    }

    if (active.get(room)) {
      sendJson(ws, { type: 'error', message: 'A reply is already running. Wait for it to finish.' });
      return;
    }
    active.set(room, true);

    const userContent = buildUserContent(text, attachments);
    const userEvent = chatStore.append(slug, chatId, 'user_message', userContent, attachments);
    broadcast(room, { type: 'event', event: userEvent });

    const control: RunControl = { cancelled: false, abort: null };
    controls.set(room, control);

    const images = attachments
      .filter((a) => a.kind === 'image' && a.data)
      .map((a) => toBase64(a.data!));
    const userMessage: ChatMessage = {
      role: 'user',
      content: userContent,
      ...(images.length > 0 ? { images } : {}),
    };

    streamChat(
      [...buildHistory(slug, chatId), userMessage],
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
