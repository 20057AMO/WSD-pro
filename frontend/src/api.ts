export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  status: 'running' | 'stopped' | 'created' | 'missing';
  containerId?: string;
  hostPorts?: Record<string, string>;
  createdAt?: string;
  image?: string;
  ports?: number[];
  env?: Record<string, string>;
  activity?: { action: string; at: string }[];
}

export interface ProjectStats {
  running: boolean;
  cpuPct: number;
  memBytes: number;
  memLimit: number;
  memPct: number;
  startedAt: string | null;
}

export interface PortHealth {
  port: string;
  hostPort: string;
  status: 'open' | 'refused' | 'timeout' | 'error';
  httpCode: number | null;
  ms: number;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
}

export interface FileListing {
  entries: FileEntry[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  truncated: boolean;
}

export interface FilePreview {
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
}

export interface ScriptRunResult {
  exitCode: number | null;
  output: string;
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

export type ChatProvider = string;
export type ChatLanguage = 'auto' | 'ar' | 'en';
export type ProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface ProviderBrief {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
}

export interface ChatConfig {
  provider: ChatProvider;
  model: string;
  systemPrompt: string;
  language: ChatLanguage;
  temperature: number;
  models: string[];
  providers: ProviderBrief[];
}

export interface ChatSession {
  slug: string;
  chatId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
}

export interface IndexStats {
  files: number;
  chunks: number;
  rebuilt: boolean;
  builtAt: string | null;
}

export interface ChatContext {
  slug: string;
  text: string;
  truncated: boolean;
  indexStats?: IndexStats;
}

export interface OpencodeStatus {
  running: boolean;
  port: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  type: ProviderType;
  host: string;
  apiKeyMasked: string;
  enabled: boolean;
}

export interface KnownTemplate {
  name: string;
  type: ProviderType;
  host: string;
  keyPrefix?: string;
}

export interface DetectResult {
  provider: {
    name: string;
    host: string;
    type: ProviderType;
    modelCount: number;
  } | null;
  tried: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  modelCount?: number;
  verified?: boolean;
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
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (HTTP ${res.status})`) as Error & { status?: number; code?: string; message?: string };
    err.code = data?.error;
    if (data?.message && data?.error) err.message = `${data.error}: ${data.message}`;
    err.status = res.status;
    throw err;
  }
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
export const getChatContext = (project: string) =>
  api<ChatContext>(`/api/chat/context?project=${encodeURIComponent(project)}`);
export const listChatSessions = (project?: string) =>
  api<{ sessions: ChatSession[] }>(
    `/api/chat/sessions${project ? `?project=${encodeURIComponent(project)}` : ''}`
  );
export const createChatSession = (body: { name?: string; project?: string }) =>
  api<{ session: ChatSession }>('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
export const renameChatSession = (chatId: string, name: string, project?: string) =>
  api<{ session: ChatSession }>(
    `/api/chat/sessions/${chatId}${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }
  );
export const deleteChatSession = (chatId: string, project?: string) =>
  api<{ ok: boolean }>(
    `/api/chat/sessions/${chatId}${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    { method: 'DELETE' }
  );
export const getOpencodeStatus = () => api<OpencodeStatus>('/api/opencode/status');

export interface AgentDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  enabled: boolean;
  toolsEnabled: boolean;
}

export interface AgentSession {
  chatId: string;
  agentId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export const listAgents = () => api<{ agents: AgentDef[] }>('/api/agents');
export const createAgent = (body: Partial<Omit<AgentDef, 'id'>>) =>
  api<{ agent: AgentDef }>('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
export const updateAgent = (id: string, patch: Partial<Omit<AgentDef, 'id'>>) =>
  api<{ agent: AgentDef }>(`/api/agents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
export const deleteAgent = (id: string) =>
  api<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' });

export const listAgentSessions = (agentId: string) =>
  api<{ sessions: AgentSession[] }>(`/api/agents/${agentId}/sessions`);
export const createAgentSession = (agentId: string, name?: string) =>
  api<{ session: AgentSession }>(`/api/agents/${agentId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
export const deleteAgentSession = (agentId: string, chatId: string) =>
  api<{ ok: boolean }>(`/api/agents/${agentId}/sessions/${chatId}`, { method: 'DELETE' });
export const renameAgentSession = (agentId: string, chatId: string, name: string) =>
  api<{ session: AgentSession }>(`/api/agents/${agentId}/sessions/${chatId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

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
export const getProviderTemplates = () =>
  api<{ templates: KnownTemplate[] }>('/api/providers/templates', { headers: authedHeaders(false) });
export const detectProvider = (body: { apiKey?: string; host?: string }) =>
  api<DetectResult>('/api/providers/detect', {
    method: 'POST',
    headers: authedHeaders(),
    body: JSON.stringify(body),
  });
export const createProvider = (body: {
  name: string;
  host?: string;
  type?: ProviderType;
  apiKey?: string;
  enabled?: boolean;
}) =>
  api<{ provider: ProviderInfo }>('/api/providers', {
    method: 'POST',
    headers: authedHeaders(),
    body: JSON.stringify(body),
  });
export const updateProvider = (
  id: string,
  patch: { name?: string; host?: string; apiKey?: string; enabled?: boolean; type?: ProviderType }
) =>
  api<{ provider: ProviderInfo }>(`/api/providers/${id}`, {
    method: 'PUT',
    headers: authedHeaders(),
    body: JSON.stringify(patch),
  });
export const deleteProvider = (id: string) =>
  api<{ ok: boolean }>(`/api/providers/${id}`, {
    method: 'DELETE',
    headers: authedHeaders(),
  });
export const testProvider = (id: string) =>
  api<ProviderTestResult>(`/api/providers/${id}/test`, {
    method: 'POST',
    headers: authedHeaders(),
  });

export function uploadFiles(
  slug: string,
  files: File[],
  folder?: string
): Promise<{ files: { name: string; path: string }[] }> {
  const fd = new FormData();
  const paths: Record<string, string> = {};
  const prefix = (folder || '').trim().replace(/^\/+|\/+$/g, '');
  for (const f of files) {
    fd.append('files', f, f.name);
    paths[f.name] = prefix ? `${prefix}/${f.name}` : f.name;
  }
  fd.append('paths', JSON.stringify(paths));
  return api(`/api/projects/${slug}/upload`, { method: 'POST', body: fd });
}

export const updateProject = (slug: string, patch: { name?: string; description?: string }) =>
  api<{ project: Project }>(`/api/projects/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
export const recreateProject = (slug: string) =>
  api<{ project: Project }>(`/api/projects/${slug}/recreate`, { method: 'POST' });
export const setProjectEnv = (slug: string, env: Record<string, string>) =>
  api<{ env: Record<string, string>; needsRecreate: boolean }>(`/api/projects/${slug}/env`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env }),
  });
export const cloneProject = (slug: string, url: string) =>
  api<{ target: string; output: string }>(`/api/projects/${slug}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
export const getProjectStats = (slug: string) =>
  api<{ stats: ProjectStats }>(`/api/projects/${slug}/stats`);
export const checkProjectPorts = (slug: string) =>
  api<{ checks: PortHealth[] }>(`/api/projects/${slug}/ports/check`);
export const listProjectFiles = (slug: string, path?: string) =>
  api<FileListing>(`/api/projects/${slug}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`);
export const getProjectFile = (slug: string, path: string) =>
  api<FilePreview>(`/api/projects/${slug}/file?path=${encodeURIComponent(path)}`);
export const deleteProjectFile = (slug: string, path: string) =>
  api<{ ok: boolean; type: 'file' | 'dir' }>(
    `/api/projects/${slug}/file?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' }
  );
export const getProjectScripts = (slug: string) =>
  api<{ scripts: Record<string, string> }>(`/api/projects/${slug}/scripts`);
export const runProjectScript = (slug: string, script: string) =>
  api<ScriptRunResult>(`/api/projects/${slug}/scripts/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script }),
  });
export interface SubdirInfo {
  subdir: string;
  hostPath: string;
  containerPath: string;
}
export const getProjectSubdir = (slug: string) =>
  api<SubdirInfo>(`/api/projects/${slug}/subdir`);

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}
