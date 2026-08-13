/**
 * chat-store.ts
 * WSD-Pro — Persistent chat history (JSONL, one file per conversation).
 * Every event: { seq, type, content, timestamp }
 * Types: user_message | agent_chunk | agent_done | agent_error
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');

export type ChatEventType = 'user_message' | 'agent_chunk' | 'agent_done' | 'agent_error';

export interface ChatEvent {
  seq: number;
  type: ChatEventType;
  content: string;
  timestamp: string;
}

export class ChatStore {
  private dir: string;
  private seqCache = new Map<string, number>();

  constructor() {
    this.dir = path.join(DATA_DIR, 'chats');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private sanitizeId(id: string): string {
    const clean = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
    return clean || `chat-${Date.now()}`;
  }

  private file(slug: string, chatId: string): string {
    const dir = path.join(this.dir, this.sanitizeId(slug), this.sanitizeId(chatId));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'events.jsonl');
  }

  private nextSeq(slug: string, chatId: string): number {
    const key = `${slug}/${chatId}`;
    const cached = this.seqCache.get(key);
    if (cached !== undefined) return cached + 1;
    const events = this.readEvents(slug, chatId);
    const seq = (events[events.length - 1]?.seq ?? 0) + 1;
    this.seqCache.set(key, seq);
    return seq;
  }

  /** Append an event and persist it (sync append is fine for local JSONL). */
  append(slug: string, chatId: string, type: ChatEventType, content: string): ChatEvent {
    const event: ChatEvent = {
      seq: this.nextSeq(slug, chatId),
      type,
      content,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(this.file(slug, chatId), JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  /** Full event list for a conversation, in sequence (replay). */
  readEvents(slug: string, chatId: string): ChatEvent[] {
    const f = this.file(slug, chatId);
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as ChatEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is ChatEvent => e !== null);
  }
}

export const chatStore = new ChatStore();