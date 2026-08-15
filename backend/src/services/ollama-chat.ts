/**
 * ollama-chat.ts
 * WSD-Pro — Chatbot against Ollama Cloud (qwen3:30b by default).
 * Streams /api/chat (NDJSON) deltas via fetch. No local Ollama required.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'https://ollama.com';
const MODEL = process.env.WSD_CHAT_MODEL || 'qwen3:30b';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (full: string) => void;
  onError: (error: string) => void;
}

export interface RunControl {
  cancelled: boolean;
  abort: (() => void) | null;
}

const SYSTEM_PROMPT =
  'You are the WSD-Pro assistant. You help users plan, design, and structure ' +
  'their software projects (architecture, tech choices, project layout, and ' +
  'implementation steps). You only discuss ideas and design — you do not edit ' +
  'files. Answer in the same language the user writes in. Be concise and practical.';

function getApiKey(): string {
  const key = process.env.OLLAMA_API_KEY || '';
  if (!key) throw new Error('OLLAMA_API_KEY is not set (see .env.example)');
  return key;
}

export async function streamChat(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  control: RunControl
): Promise<string> {
  const apiKey = getApiKey();
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    stream: true,
    options: { temperature: 0.4 },
  });

  const controller = new AbortController();
  control.abort = () => controller.abort();

  let full = '';
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama Cloud request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const delta: string = parsed?.message?.content || '';
          if (delta) {
            full += delta;
            handlers.onDelta(delta);
          }
        } catch {
          // skip malformed line
        }
      }
    }

    if (control.cancelled) throw new Error('Chat stopped');
    handlers.onDone(full);
    return full;
  } catch (err: any) {
    if (control.cancelled) throw new Error('Chat stopped');
    if (err?.name === 'AbortError') throw new Error('Chat stopped');
    handlers.onError(err?.message || String(err));
    throw err;
  } finally {
    control.abort = null;
  }
}

export { MODEL };
