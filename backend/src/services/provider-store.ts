/**
 * provider-store.ts
 * WSD-Pro — Persisted provider credentials (Ollama Cloud / Local Ollama).
 * Stored in WSD_DATA_DIR/providers.json. Env vars act as defaults.
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'providers.json');

export type ProviderId = 'ollama' | 'local';

export interface ProviderConfig {
  host: string;
  apiKey: string;
  enabled: boolean;
}

export interface ProviderMeta {
  id: string;
  name: string;
  host: string;
  apiKeyMasked: string;
  enabled: boolean;
  requiresKey: boolean;
}

function defaults(): Record<ProviderId, ProviderConfig> {
  return {
    ollama: {
      host: process.env.OLLAMA_HOST || 'https://ollama.com',
      apiKey: process.env.OLLAMA_API_KEY || '',
      enabled: true,
    },
    local: {
      host: process.env.OLLAMA_LOCAL_HOST || 'http://host.docker.internal:11434',
      apiKey: '',
      enabled: true,
    },
  };
}

let cached: Record<ProviderId, ProviderConfig> | null = null;

function load(): Record<ProviderId, ProviderConfig> {
  if (cached) return cached;
  const base = defaults();
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as Partial<
        Record<ProviderId, Partial<ProviderConfig>>
      >;
      for (const id of ['ollama', 'local'] as ProviderId[]) {
        const stored = raw[id];
        if (stored && typeof stored === 'object') base[id] = { ...base[id], ...stored };
      }
    }
  } catch {
    // ignore a corrupt store file
  }
  cached = base;
  return cached;
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(cached, null, 2), 'utf8');
}

export function getProviderConfig(id: string): ProviderConfig {
  const cfg = load();
  return cfg[id === 'local' ? 'local' : 'ollama'];
}

export function listProviders(): ProviderMeta[] {
  const cfg = load();
  const ids: ProviderId[] = ['ollama', 'local'];
  return ids.map((id) => ({
    id,
    name: id === 'ollama' ? 'Ollama Cloud' : 'Local Ollama',
    host: cfg[id].host,
    apiKeyMasked: maskKey(cfg[id].apiKey),
    enabled: cfg[id].enabled,
    requiresKey: id === 'ollama',
  }));
}

export function updateProvider(
  id: string,
  patch: { host?: string; apiKey?: string; enabled?: boolean }
): ProviderMeta {
  const providerId: ProviderId = id === 'local' ? 'local' : 'ollama';
  const cfg = load();
  if (typeof patch.host === 'string' && patch.host.trim()) {
    cfg[providerId].host = patch.host.trim().slice(0, 500);
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    cfg[providerId].apiKey = patch.apiKey.trim();
  }
  if (typeof patch.enabled === 'boolean') {
    cfg[providerId].enabled = patch.enabled;
  }
  persist();
  return listProviders().find((p) => p.id === providerId)!;
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '••••';
  return '••••••••' + key.slice(-4);
}
