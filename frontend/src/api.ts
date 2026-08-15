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

export interface ChatInfo {
  model: string;
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
export const getChatInfo = () => api<ChatInfo>('/api/chat/info');
export const getLogs = (slug: string, tail = 200) =>
  api<{ logs: string }>(`/api/projects/${slug}/logs?tail=${tail}`);

export function uploadFiles(slug: string, files: File[]): Promise<{ files: { name: string; path: string }[] }> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  return api(`/api/projects/${slug}/upload`, { method: 'POST', body: fd });
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}
