/**
 * ollama-chat.ts
 * WSD-Pro — Streaming chat against any Ollama-compatible endpoint
 * (Ollama Cloud by default, or a local Ollama instance).
 * Streams /api/chat (NDJSON) deltas via fetch. No local Ollama required.
 */

import {
  getChatConfig,
  resolveProvider,
  buildSystemPrompt,
  type Provider,
} from './chat-config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64-encoded images (no data-URI prefix), for vision-capable models. */
  images?: string[];
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

export interface StreamOptions {
  provider: Provider;
  model: string;
  temperature: number;
}

export async function streamChat(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  control: RunControl,
  opts: Partial<StreamOptions> = {}
): Promise<string> {
  const cfg = getChatConfig();
  const provider = opts.provider || cfg.provider;
  const model = opts.model || cfg.model;
  const temperature = opts.temperature ?? cfg.temperature;
  const { baseUrl, apiKey } = resolveProvider(provider);

  if (provider === 'ollama' && !apiKey) {
    const error = 'OLLAMA_API_KEY is not set (see .env.example)';
    handlers.onError(error);
    throw new Error(error);
  }

  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: buildSystemPrompt(cfg) }, ...messages],
    stream: true,
    options: { temperature },
  });

  const controller = new AbortController();
  control.abort = () => controller.abort();

  let full = '';
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${baseUrl} request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
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
