export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  status: 'running' | 'stopped' | 'created' | 'missing';
  containerId?: string;
  hostPorts?: Record<string, string>;
  createdAt?: string;
}

export interface ServerInfo {
  version: string;
  lanIp: string | null;
  tailscaleIp: string | null;
  basePort: number;
  timestamp: string;
}

export interface IdeStatus {
  running: boolean;
  port: number;
  password: string;
}

export type ChatProvider = 'ollama' | 'local';
export type ChatLanguage = 'auto' | 'ar' | 'en';

export interface ChatConfig {
  provider: ChatProvider;
  model: string;
  systemPrompt: string;
  language: ChatLanguage;
  temperature: number;
  models: string[];
}

export interface OpencodeStatus {
  running: boolean;
  port: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  host: string;
  apiKeyMasked: string;
  enabled: boolean;
  requiresKey: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  modelCount?: number;
  error?: string;
}

let providersToken: string | null = null;
try {
  providersToken = sessionStorage.getItem('wsd.providers.token');
} catch {
  providersToken = null;
}

export function getProvidersToken(): string | null {
  return providersToken;
}

export function setProvidersToken(token: string | null): void {
  providersToken = token;
  try {
    if (token) sessionStorage.setItem('wsd.providers.token', token);
    else sessionStorage.removeItem('wsd.providers.token');
  } catch {
    /* storage unavailable */
  }
}

function authedHeaders(json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (providersToken) headers['Authorization'] = `Bearer ${providersToken}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data as T;
}

export const listProjects = () => api<{ projects: Project[] }>('/api/projects');
export const getProject = (slug: string) => api<{ project: Project }>(`/api/projects/${slug}`);
export const createProject = (body: { name: string; description?: string; ports?: number[] }) =>
  api<{ project: Project }>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
export const startProject = (slug: string) =>
  api<{ project: Project }>(`/api/projects/${slug}/start`, { method: 'POST' });
export const stopProject = (slug: string) =>
  api<{ project: Project }>(`/api/projects/${slug}/stop`, { method: 'POST' });
export const deleteProject = (slug: string) =>
  api<{ ok: boolean }>(`/api/projects/${slug}`, { method: 'DELETE' });
export const getServerInfo = () => api<ServerInfo>('/api/server/info');
export const getIdeStatus = () => api<{ ide: IdeStatus }>('/api/ide/status');
export const getChatInfo = () => api<ChatConfig>('/api/chat/info');
export const getChatModels = (provider: ChatProvider) =>
  api<{ models: string[] }>(`/api/chat/models?provider=${provider}`);
export const saveChatConfig = (cfg: Partial<ChatConfig>) =>
  api<ChatConfig>('/api/chat/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
export const getOpencodeStatus = () => api<OpencodeStatus>('/api/opencode/status');
export const getLogs = (slug: string, tail = 200) =>
  api<{ logs: string }>(`/api/projects/${slug}/logs?tail=${tail}`);

export const authProviders = (password: string) =>
  api<{ token: string }>('/api/providers/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
export const logoutProviders = () =>
  api<{ ok: boolean }>('/api/providers/logout', { method: 'POST', headers: authedHeaders() });
export const getProviders = () =>
  api<{ providers: ProviderInfo[] }>('/api/providers', { headers: authedHeaders(false) });
export const updateProvider = (
  id: string,
  patch: { host?: string; apiKey?: string; enabled?: boolean }
) =>
  api<{ provider: ProviderInfo }>(`/api/providers/${id}`, {
    method: 'PUT',
    headers: authedHeaders(),
    body: JSON.stringify(patch),
  });
export const testProvider = (id: string) =>
  api<ProviderTestResult>(`/api/providers/${id}/test`, {
    method: 'POST',
    headers: authedHeaders(),
  });

export function uploadFiles(slug: string, files: File[]): Promise<{ files: { name: string; path: string }[] }> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  return api(`/api/projects/${slug}/upload`, { method: 'POST', body: fd });
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}
