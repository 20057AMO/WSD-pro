/**
 * settings-export.ts
 * Backup/restore of user configuration data.
 * SECURITY: provider API keys are intentionally excluded from exports —
 * the backup file must never contain secrets. Imported providers are
 * created without keys; re-add keys manually from the Providers page.
 */
import fs from 'fs';
import path from 'path';
import { resetProviderCache } from './provider-store';
import { resetChatConfigCache } from './chat-config';
import { resetAgentsCache } from './agent-store';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const AGENT_SESSIONS_FILE = path.join(DATA_DIR, 'agent-sessions.json');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const CHAT_CONFIG_FILE = path.join(DATA_DIR, 'chat-config.json');

export interface BackupFile {
  kind: 'wsd-pro-backup';
  version: string;
  exportedAt: string;
  /** True when secrets were stripped during export (always true today). */
  sanitized: boolean;
  data: {
    agents?: unknown[];
    agentSessions?: unknown[];
    providers?: Record<string, unknown>;
    chatConfig?: Record<string, unknown>;
  };
}

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** Strip secret fields from a single provider config object. */
function sanitizeProvider(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null;
  const { apiKey, ...rest } = entry as Record<string, unknown>;
  void apiKey;
  return rest;
}

/** Build an export payload. Provider entries are stripped of API keys/auth modes. */
export function buildBackup(version: string): BackupFile {
  // providers.json shape: Record<id, ProviderConfig>
  const rawProviders = readJson(PROVIDERS_FILE);
  const cleanProviders: Record<string, unknown> = {};
  if (rawProviders && typeof rawProviders === 'object' && !Array.isArray(rawProviders)) {
    for (const [id, entry] of Object.entries(rawProviders as Record<string, unknown>)) {
      const clean = sanitizeProvider(entry);
      if (clean) cleanProviders[id] = clean;
    }
  }

  const rawAgents = readJson(AGENTS_FILE);
  const rawAgentSessions = readJson(AGENT_SESSIONS_FILE);
  const rawChatConfig = readJson(CHAT_CONFIG_FILE);

  return {
    kind: 'wsd-pro-backup',
    version,
    exportedAt: new Date().toISOString(),
    sanitized: true,
    data: {
      ...(Array.isArray(rawAgents) ? { agents: rawAgents } : {}),
      ...(Array.isArray(rawAgentSessions) ? { agentSessions: rawAgentSessions } : {}),
      ...(Object.keys(cleanProviders).length > 0 ? { providers: cleanProviders } : {}),
      ...(rawChatConfig && typeof rawChatConfig === 'object' && !Array.isArray(rawChatConfig)
        ? { chatConfig: rawChatConfig as Record<string, unknown> }
        : {}),
    },
  };
}

export interface RestoreResult {
  imported: Record<string, number>;
  skipped: number;
}

/**
 * Merge a backup into the current stores. Existing items always win;
 * only ids not already present are imported. Provider secrets are never
 * imported even if someone hand-edits the file to re-add them.
 */
export function restoreFromBackup(backup: unknown): RestoreResult {
  const b = backup as Partial<BackupFile> & { data?: BackupFile['data'] };
  if (
    !b ||
    b.kind !== 'wsd-pro-backup' ||
    !b.data ||
    typeof b.data !== 'object' ||
    Array.isArray(b.data)
  ) {
    throw Object.assign(new Error('Invalid backup file: missing wsd-pro-backup marker.'), { status: 400 });
  }

  const imported: Record<string, number> = {};
  let skipped = 0;

  // ── Agents + agent sessions: array stores keyed by id / chatId ──
  const mergeArrayStore = (file: string, incoming: unknown[], idField: string, label: string): void => {
    if (incoming.length === 0) return;
    const current = readJson(file);
    const existing = Array.isArray(current) ? [...current] : [];
    const ids = new Set(existing.map((x) => String((x as any)?.[idField] ?? '')));
    let added = 0;
    for (const item of incoming) {
      const id = String((item as any)?.[idField] ?? '');
      if (!id || ids.has(id)) {
        skipped += 1;
        continue;
      }
      ids.add(id);
      existing.push(item);
      added += 1;
    }
    if (added > 0) writeJson(file, existing);
    if (label === 'agents' && added > 0) resetAgentsCache();
    imported[label] = added;
  };

  if (Array.isArray(b.data.agents)) mergeArrayStore(AGENTS_FILE, b.data.agents, 'id', 'agents');
  if (Array.isArray(b.data.agentSessions)) {
    mergeArrayStore(AGENT_SESSIONS_FILE, b.data.agentSessions, 'chatId', 'agentSessions');
  }

  // ── Providers: Record store — add unknown ids only ───────────
  if (b.data.providers && typeof b.data.providers === 'object' && !Array.isArray(b.data.providers)) {
    const currentRaw = readJson(PROVIDERS_FILE);
    const current =
      currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
        ? ({ ...(currentRaw as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    let added = 0;
    for (const [id, entry] of Object.entries(b.data.providers)) {
      const clean = sanitizeProvider(entry);
      if (!clean) continue;
      if (Object.prototype.hasOwnProperty.call(current, id)) {
        skipped += 1;
        continue;
      }
      current[id] = clean;
      added += 1;
    }
    if (added > 0) writeJson(PROVIDERS_FILE, current);
    if (added > 0) resetProviderCache();
    imported['providers'] = added;
  }

  // ── Chat config: fill missing fields only; active choices stay untouched ──
  if (b.data.chatConfig && typeof b.data.chatConfig === 'object' && !Array.isArray(b.data.chatConfig)) {
    const currentRaw = readJson(CHAT_CONFIG_FILE);
    const current =
      currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
        ? (currentRaw as Record<string, unknown>)
        : {};
    const filled: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b.data.chatConfig)) {
      if (!(k in current)) filled[k] = v;
    }
    if (Object.keys(filled).length > 0) {
      writeJson(CHAT_CONFIG_FILE, { ...current, ...filled });
      resetChatConfigCache();
      imported['chatConfig'] = Object.keys(filled).length;
    }
  }

  return { imported, skipped };
}
