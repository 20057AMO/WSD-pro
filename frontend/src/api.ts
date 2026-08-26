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
export type ProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'azure';

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

function getAuthToken(): string | null {
  try {
    return localStorage.getItem('wsd.token');
  } catch {
    return null;
  }
}

// ── Providers unlock token (second-layer lock) ────────────────
// Stored in localStorage (not sessionStorage): the 30-minute expiry
// timestamp still time-boxes it, while the `storage` event lets all open
// tabs stay in sync about the lock state.
export const UNLOCK_KEY = 'wsd.providers.unlock';

export interface UnlockState {
  token: string;
  /** epoch ms when the unlock expires */
  expiresAt: number;
}

export function getProvidersUnlock(): UnlockState | null {
  try {
    const raw = localStorage.getItem(UNLOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UnlockState;
    if (!parsed?.token || !parsed?.expiresAt || Date.now() >= parsed.expiresAt) {
      localStorage.removeItem(UNLOCK_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setProvidersUnlock(token: string, expiresInSec: number): void {
  try {
    localStorage.setItem(UNLOCK_KEY, JSON.stringify({ token, expiresAt: Date.now() + expiresInSec * 1000 }));
  } catch { /* storage unavailable */ }
}

export function clearProvidersUnlock(): void {
  try {
    localStorage.removeItem(UNLOCK_KEY);
  } catch { /* ignore */ }
}

/** "Lock now" — invalidate every outstanding unlock token server-side. */
export const relockProviders = () =>
  api<{ ok: boolean; locked: boolean }>('/api/providers/relock', { method: 'POST' });

// ── Two-factor authentication (TOTP) ──────────────────────────

export const getTotpStatus = () =>
  api<{ enabled: boolean }>('/api/auth/2fa/status');

/** Enrollment step 1: fresh pending secret + provisioning URI for the app. */
export const totpSetup = () =>
  api<{ secret: string; uri: string }>('/api/auth/2fa/setup', { method: 'POST' });

/** Enrollment step 2: activate once the authenticator proves it works. */
export const totpEnable = (code: string) =>
  api<{ ok: boolean }>('/api/auth/2fa/enable', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });

/** Turn 2FA off — requires the account password (sudo-style re-auth). */
export const totpDisable = (accountPassword: string) =>
  api<{ ok: boolean }>('/api/auth/2fa/disable', {
    method: 'POST',
    body: JSON.stringify({ accountPassword }),
    skipAuthRedirect: true,
  });

/** Sign out of every session across all devices. */
export const apiLogoutAll = (accountPassword: string) =>
  api<{ ok: boolean }>('/api/auth/logout-all', {
    method: 'POST',
    body: JSON.stringify({ accountPassword }),
    skipAuthRedirect: true,
  });

export type ApiError = Error & { status?: number; code?: string };

type ApiInit = RequestInit & { skipAuthRedirect?: boolean };

async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const merged: RequestInit = { ...init };
  const existingHeaders = new Headers(merged.headers || {});
  if (!existingHeaders.has('Authorization')) {
    const token = getAuthToken();
    if (token) existingHeaders.set('Authorization', `Bearer ${token}`);
  }
  // Providers-lock scoped token — attached opportunistically; the server
  // ignores it on unlocked routes.
  if (!existingHeaders.has('X-Providers-Unlock')) {
    const unlock = getProvidersUnlock();
    if (unlock) existingHeaders.set('X-Providers-Unlock', unlock.token);
  }
  if (!existingHeaders.has('Content-Type') && !(merged.body instanceof FormData)) {
    existingHeaders.set('Content-Type', 'application/json');
  }
  merged.headers = existingHeaders;

  const res = await fetch(path, merged);
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    if (res.status === 403 && data?.error === 'providers_locked') {
      clearProvidersUnlock();
    }
    // A 401 normally means the session died — but intentional password
    // checks (providers unlock, sudo re-auth endpoints) opt out via
    // skipAuthRedirect so a wrong password surfaces inline instead of
    // logging the whole app out.
    if (res.status === 401 && !init?.skipAuthRedirect) {
      localStorage.removeItem('wsd.token');
      window.location.hash = '/login';
      throw new Error('Session expired');
    }
    const err = new Error(data?.error || `Request failed (HTTP ${res.status})`) as ApiError;
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

// ── Project notes (ideas / bugs / goals) ─────────────────────────────────
export type NoteKind = 'idea' | 'bug' | 'goal';
export interface NoteItem {
  id: string;
  text: string;
  kind: NoteKind;
  done: boolean;
  createdAt: string;
}
export const getProjectNotes = (slug: string) =>
  api<{ items: NoteItem[] }>(`/api/projects/${encodeURIComponent(slug)}/notes`);
export const saveProjectNotes = (slug: string, items: NoteItem[]) =>
  api<{ items: NoteItem[] }>(`/api/projects/${encodeURIComponent(slug)}/notes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
export const getServerInfo = () => api<ServerInfo>('/api/server/info');
export const getIdeStatus = () => api<{ ide: IdeStatus }>('/api/ide/status');
export const getChatInfo = () => api<ChatConfig>('/api/chat/info');
export const getChatModels = (provider: ChatProvider) =>
  api<{ models: string[] }>(`/api/chat/models?provider=${provider}`);
export const getChatContext = (project: string) =>
  api<ChatContext>(`/api/chat/context?project=${encodeURIComponent(project)}`);
export const getOpencodeStatus = () => api<OpencodeStatus>('/api/opencode/status');
export const openOpencodeProject = (slug: string) =>
  api<{ ok: boolean }>('/api/opencode/open', { method: 'POST', body: JSON.stringify({ slug }) });

// ── Opencode Studio ─────────────────────────────────────────────────────
export interface StudioItem {
  name: string;
  description: string;
  mode?: string;
  agent?: string;
}
export interface StudioVersionInfo {
  current: string;
  latest: string | null;
  upToDate: boolean | null;
  channelUnlocked: boolean;
  supportedMajors: number[];
  updateRunning: boolean;
}
export const listStudioAgents = () => api<{ agents: StudioItem[] }>('/api/opencode-studio/agents');
export const getStudioAgent = (name: string) =>
  api<{ name: string; content: string }>(`/api/opencode-studio/agents/${encodeURIComponent(name)}`);
export const saveStudioAgent = (name: string, content: string) =>
  api<{ ok: boolean }>(`/api/opencode-studio/agents/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
export const deleteStudioAgent = (name: string) =>
  api<{ ok: boolean }>(`/api/opencode-studio/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
export const listStudioSkills = () => api<{ skills: StudioItem[] }>('/api/opencode-studio/skills');
export const getStudioSkill = (name: string) =>
  api<{ name: string; content: string }>(`/api/opencode-studio/skills/${encodeURIComponent(name)}`);
export const saveStudioSkill = (name: string, content: string) =>
  api<{ ok: boolean }>(`/api/opencode-studio/skills/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
export const deleteStudioSkill = (name: string) =>
  api<{ ok: boolean }>(`/api/opencode-studio/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const listStudioCommands = () => api<{ commands: StudioItem[] }>('/api/opencode-studio/commands');

export const getStudioCommand = (name: string) =>
  api<{ name: string; content: string }>(`/api/opencode-studio/commands/${encodeURIComponent(name)}`);

export const saveStudioCommand = (name: string, content: string) =>
  api<{ ok: boolean }>(`/api/opencode-studio/commands/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });

export const deleteStudioCommand = (name: string) =>
  api<{ ok: boolean }>(`/api/opencode-studio/commands/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const getStudioConfig = () => api<Record<string, unknown>>('/api/opencode-studio/config');
export const updateStudioConfig = (patch: Record<string, unknown>) =>
  api<Record<string, unknown>>('/api/opencode-studio/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
export const getStudioVersion = () => api<StudioVersionInfo>('/api/opencode-studio/version');
export const runStudioUpdate = () =>
  api<{ ok: boolean; updatedTo?: string; error?: string }>('/api/opencode-studio/update', {
    method: 'POST',
  });

export type AgentPermission = 'none' | 'read' | 'bash' | 'full';

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
  permission?: AgentPermission;
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

// ── Project-scoped AI chat (ws-chat + chat-sessions) ──────────

export interface ProjectChatSession {
  slug: string;
  chatId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
}

export const listChatSessions = (project?: string) =>
  api<{ sessions: ProjectChatSession[] }>(
    `/api/chat/sessions${project ? `?project=${encodeURIComponent(project)}` : ''}`
  );
export const createChatSession = (project: string, name?: string) =>
  api<{ session: ProjectChatSession }>('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, name }),
  });
export const renameChatSession = (project: string, chatId: string, name: string) =>
  api<{ session: ProjectChatSession }>(
    `/api/chat/sessions/${chatId}?project=${encodeURIComponent(project)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }
  );
export const deleteChatSession = (project: string, chatId: string) =>
  api<{ ok: boolean }>(
    `/api/chat/sessions/${chatId}?project=${encodeURIComponent(project)}`,
    { method: 'DELETE' }
  );

export const updateChatConfig = (patch: Partial<ChatConfig>) =>
  api<ChatConfig>('/api/chat/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });


export const getLogs = (slug: string, tail = 200) =>
  api<{ logs: string }>(`/api/projects/${slug}/logs?tail=${tail}`);

export const getProviders = () =>
  api<{ providers: ProviderInfo[] }>('/api/providers');
export const getProviderTemplates = () =>
  api<{ templates: KnownTemplate[] }>('/api/providers/templates');
export const detectProvider = (body: { apiKey?: string; host?: string }) =>
  api<DetectResult>('/api/providers/detect', {
    method: 'POST',
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
    body: JSON.stringify(body),
  });
export const updateProvider = (
  id: string,
  patch: { name?: string; host?: string; apiKey?: string; enabled?: boolean; type?: ProviderType }
) =>
  api<{ provider: ProviderInfo }>(`/api/providers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
export const deleteProvider = (id: string) =>
  api<{ ok: boolean }>(`/api/providers/${id}`, {
    method: 'DELETE',
  });
export const testProvider = (id: string) =>
  api<ProviderTestResult>(`/api/providers/${id}/test`, {
    method: 'POST',
  });

// ── Providers lock management ─────────────────────────────────
export const getProvidersLockStatus = () =>
  api<{ enabled: boolean }>('/api/providers-lock');
export const unlockProviders = (password: string) =>
  api<{ ok: boolean; unlocked?: boolean; unlockToken?: string; expiresInSec?: number }>('/api/providers/unlock', {
    method: 'POST',
    body: JSON.stringify({ password }),
    skipAuthRedirect: true,
  });
export const setProvidersPassword = (accountPassword: string, newPassword: string) =>
  api<{ ok: boolean; enabled: boolean; unlockToken?: string; expiresInSec?: number }>('/api/auth/providers-password', {
    method: 'POST',
    body: JSON.stringify({ accountPassword, newPassword }),
    skipAuthRedirect: true,
  });
export const removeProvidersPassword = (accountPassword: string) =>
  api<{ ok: boolean; enabled: boolean }>('/api/auth/providers-password', {
    method: 'DELETE',
    body: JSON.stringify({ accountPassword }),
    skipAuthRedirect: true,
  });

// ── Security activity log ─────────────────────────────────────
export interface AuditEntry {
  ts: string;
  event: string;
  ok: boolean;
  ip?: string;
}
export const getAuditLog = (limit = 50, offset = 0) =>
  api<{ entries: AuditEntry[]; total: number }>(`/api/auth/audit?limit=${limit}&offset=${offset}`);

// ── Settings backup ───────────────────────────────────────────
export interface BackupFile {
  kind: string;
  version: string;
  exportedAt: string;
  sanitized: boolean;
  data: Record<string, unknown>;
}
export const exportSettings = (accountPassword: string): Promise<BackupFile> =>
  api<BackupFile>('/api/settings/export', {
    method: 'POST',
    body: JSON.stringify({ accountPassword }),
    skipAuthRedirect: true,
  });
export const importSettings = (accountPassword: string, backup: unknown) =>
  api<{ ok: boolean; imported: Record<string, number>; skipped: number }>('/api/settings/import', {
    method: 'POST',
    body: JSON.stringify({ accountPassword, backup }),
    skipAuthRedirect: true,
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
export const saveProjectFile = (slug: string, path: string, content: string) =>
  api<{ ok: boolean; path: string; bytes: number }>(
    `/api/projects/${slug}/file?path=${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
  );
export const renameProjectPath = (slug: string, from: string, to: string) =>
  api<{ ok: boolean }>(`/api/projects/${slug}/file/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
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
  const token = getAuthToken();
  const sep = path.includes('?') ? '&' : '?';
  const tokenParam = token ? `${sep}token=${encodeURIComponent(token)}` : '';
  return `${proto}://${location.host}${path}${tokenParam}`;
}

// ── User management ──────────────────────────────────────────

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface TeamUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  passwordChangedAt?: string;
}

export const listUsers = () => api<TeamUser[]>('/api/users');

export const createUser = (username: string, password: string, role: UserRole = 'editor') =>
  api<{ id: string; username: string; role: UserRole }>('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role }),
  });

export const updateUserRole = (userId: string, role: UserRole) =>
  api<{ ok: boolean }>(`/api/users/${userId}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });

export const deleteUser = (userId: string) =>
  api<{ ok: boolean }>(`/api/users/${userId}`, { method: 'DELETE' });
