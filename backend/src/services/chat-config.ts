/**
 * chat-config.ts
 * WSD-Pro — Persisted chat configuration (provider, model, language, system prompt).
 * Lives in WSD_DATA_DIR/chat-config.json so it survives restarts.
 */

import fs from 'fs';
import path from 'path';
import {
  AZURE_API_VERSION,
  getProviderConfig,
  getProviderMeta,
  listProviders,
  type AuthMode,
  type ProviderType,
} from './provider-store';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'chat-config.json');

export type Provider = string;
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
  type: ProviderType;
  auth?: AuthMode;
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

/** Invalidate the in-memory chat-config cache (call after external file writes). */
export function resetChatConfigCache(): void {
  cached = null;
}

export function getChatConfig(): ChatConfig {
  if (!cached) {
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
  }
  // Self-heal on every read: if the saved provider no longer exists (e.g.
  // deleted from the Providers page), fall back to the first available provider.
  const cur = cached;
  if (cur.provider && !getProviderMeta(cur.provider)) {
    const first = listProviders()[0];
    if (first && first.id !== cur.provider) {
      cur.provider = first.id;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8');
      } catch {
        // non-fatal
      }
    }
  }
  return cached;
}

export function updateChatConfig(patch: Partial<ChatConfig>): ChatConfig {
  const next = { ...getChatConfig(), ...patch };
  cached = next;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * Resolve a provider endpoint. The requested id is used when it exists;
 * otherwise the first available provider is used (auto-fallback after a delete).
 */
export function resolveProvider(provider: Provider): ProviderEndpoint {
  const cfg = getProviderConfig(provider);
  return { baseUrl: cfg.host, apiKey: cfg.apiKey, type: cfg.type, auth: cfg.auth };
}

/** Language directive appended to the system prompt when a fixed reply language is set. */
export function buildSystemPrompt(cfg: ChatConfig): string {
  let prompt = cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (cfg.language === 'ar') prompt += '\nAnswer in Arabic (العربية).';
  else if (cfg.language === 'en') prompt += '\nAnswer in English.';
  return prompt;
}

/** Fetch available models from the provider (empty list on any failure). */
export async function listModels(provider: Provider): Promise<string[]> {
  const ep = resolveProvider(provider);
  try {
    if (ep.type === 'azure') {
      // Model dropdown lists Azure **deployments** — the names chat requests need.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ep.apiKey) headers['api-key'] = ep.apiKey;
      const res = await fetch(`${ep.baseUrl}/openai/deployments?api-version=${AZURE_API_VERSION}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => ({}))) as { data?: any[]; value?: any[] };
      const items = Array.isArray(data.data) ? data.data : Array.isArray(data.value) ? data.value : [];
      const names = items.map((d) => String(d?.id || d?.name || '').trim()).filter(Boolean);
      return [...new Set(names)].sort();
    }
    if (ep.type === 'gemini') {
      const res = await fetch(`${ep.baseUrl}/models`, {
        headers: ep.apiKey ? { 'x-goog-api-key': ep.apiKey } : undefined,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
      };
      return (data.models || [])
        .filter(
          (m) =>
            m.name &&
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent')
        )
        .map((m) => String(m.name).replace(/^models\//, ''))
        .sort();
    }
    if (ep.type === 'openai' || ep.type === 'anthropic') {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ep.apiKey) {
        if (ep.type === 'anthropic') {
          headers['x-api-key'] = ep.apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else if (ep.auth === 'api-key') {
          headers['api-key'] = ep.apiKey;
        } else {
          headers['Authorization'] = `Bearer ${ep.apiKey}`;
        }
      }
      const modelsUrl = ep.type === 'anthropic' ? `${ep.baseUrl}/v1/models` : `${ep.baseUrl}/models`;
      const res = await fetch(modelsUrl, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id?: string }[] };
      return (data.data || []).map((m) => m.id).filter((id): id is string => !!id).sort();
    }
    const res = await fetch(`${ep.baseUrl}/api/tags`, {
      headers: ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models || []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}
