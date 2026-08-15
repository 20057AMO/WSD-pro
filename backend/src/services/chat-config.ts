/**
 * chat-config.ts
 * WSD-Pro — Persisted chat configuration (provider, model, language, system prompt).
 * Lives in WSD_DATA_DIR/chat-config.json so it survives restarts.
 */

import fs from 'fs';
import path from 'path';
import { getProviderConfig } from './provider-store';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'chat-config.json');

export type Provider = 'ollama' | 'local';
export type ReplyLanguage = 'auto' | 'ar' | 'en';

export interface ChatConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  language: ReplyLanguage;
  temperature: number;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are the WSD-Pro assistant. You help users plan, design, and structure ' +
  'their software projects (architecture, tech choices, project layout, and ' +
  'implementation steps). You only discuss ideas and design — you do not edit ' +
  'files. Answer in the same language the user writes in. Be concise and practical.';

export interface ProviderEndpoint {
  baseUrl: string;
  apiKey: string;
}

function defaults(): ChatConfig {
  return {
    provider: 'ollama',
    model: process.env.WSD_CHAT_MODEL || 'qwen3:30b',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    language: 'auto',
    temperature: 0.4,
  };
}

let cached: ChatConfig | null = null;

export function getChatConfig(): ChatConfig {
  if (cached) return cached;
  const base = defaults();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<ChatConfig>;
      cached = { ...base, ...raw };
    } else {
      cached = base;
    }
  } catch {
    cached = base;
  }
  return cached!;
}

export function updateChatConfig(patch: Partial<ChatConfig>): ChatConfig {
  const next = { ...getChatConfig(), ...patch };
  cached = next;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Resolve the active provider endpoint (base URL + optional bearer key). */
export function resolveProvider(provider: Provider): ProviderEndpoint {
  if (provider === 'local') {
    const cfg = getProviderConfig('local');
    return { baseUrl: cfg.host, apiKey: cfg.apiKey };
  }
  const cfg = getProviderConfig('ollama');
  return { baseUrl: cfg.host, apiKey: cfg.apiKey };
}

/** Language directive appended to the system prompt when a fixed reply language is set. */
export function buildSystemPrompt(cfg: ChatConfig): string {
  let prompt = cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (cfg.language === 'ar') prompt += '\nAnswer in Arabic (العربية).';
  else if (cfg.language === 'en') prompt += '\nAnswer in English.';
  return prompt;
}

/** Fetch available models from the provider's /api/tags. Empty list on any failure. */
export async function listModels(provider: Provider): Promise<string[]> {
  const { baseUrl, apiKey } = resolveProvider(provider);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models || []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}
