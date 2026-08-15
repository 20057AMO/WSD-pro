/**
 * docker-manager.ts
 * WSD-Pro — Docker orchestration layer.
 * Creates, starts, stops, and inspects per-project containers via Dockerode.
 * Each project gets its own container on its own port(s); the workspace dir
 * lives under WORKSPACES_ROOT and is bind-mounted at /workspace.
 */

import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';

const docker = new Docker(); // uses /var/run/docker.sock by default

// Host path where project workspaces live (bind-mounted into containers)
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

// Base image used for project workspaces (Ubuntu + dev tooling)
const BASE_IMAGE = process.env.WSD_WORKSPACE_IMAGE || 'wsd/workspace:latest';

export interface ProjectSpec {
  name: string;
  slug: string;
  description?: string;
  image?: string;
  ports?: number[]; // host ports to expose
}

export interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  description?: string;
  status: 'running' | 'stopped' | 'created' | 'missing';
  containerId?: string;
  hostPorts?: Record<string, string>;
  createdAt?: string;
}

function validateProjectSlug(slug: string): string {
  const value = String(slug ?? '').trim().toLowerCase();
  const clean = value.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!clean) throw new HttpError(400, 'Project slug is invalid');

  const RESERVED_SLUGS = ['wsd', 'ide', 'admin', 'api', 'system', 'root', 'workspace'];
  if (RESERVED_SLUGS.includes(clean)) {
    throw new HttpError(400, `Project slug '${clean}' is reserved and cannot be used.`);
  }

  return clean;
}

function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || `project-${Date.now()}`;
}

function validateProjectSpec(spec: ProjectSpec): { name: string; slug: string; description?: string; image?: string; ports?: number[] } {
  const name = String(spec.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Project name is required');

  const slugInput = spec.slug ? String(spec.slug).trim() : sanitizeSlug(name);
  const slug = validateProjectSlug(slugInput);

  const ports = Array.isArray(spec.ports) ? [...spec.ports] : [];
  const seen = new Set<number>();
  const cleanPorts: number[] = [];

  for (const raw of ports) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(400, `Invalid port: ${raw} (must be 1-65535)`);
    }
    if (port < 1024) {
      throw new HttpError(400, `Port ${port} is a privileged system port (1-1023) and cannot be used.`);
    }
    const dashboardPort = Number(process.env.PORT) || 3000;
    const idePort = Number(process.env.WSD_IDE_PORT) || 8100;
    if (port === dashboardPort) {
      throw new HttpError(400, `Port ${port} is reserved for the WSD-Pro dashboard.`);
    }
    if (port === idePort) {
      throw new HttpError(400, `Port ${port} is reserved for the WSD-Pro Web IDE.`);
    }

    if (seen.has(port)) continue;
    seen.add(port);
    cleanPorts.push(port);
  }

  return {
    name,
    slug,
    description: spec.description ? String(spec.description).trim() : undefined,
    image: spec.image ? String(spec.image).trim() : undefined,
    ports: cleanPorts,
  };
}

/** Error with an HTTP status code — routes map this to the response. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Throw a 404 if no container exists for this slug. */
async function requireContainer(slug: string) {
  const projectSlug = validateProjectSlug(slug);
  const info = await getProject(projectSlug);
  if (!info) throw new HttpError(404, `Project '${projectSlug}' not found`);
  return info;
}

function ensureWorkspaceDir(slug: string): string {
  const dir = path.join(WORKSPACES_ROOT, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a project: provision workspace dir + launch container.
 */
export async function createProject(spec: ProjectSpec): Promise<ProjectInfo> {
  const clean = validateProjectSpec(spec);
  const existing = await getProject(clean.slug);
  if (existing) {
    throw new HttpError(409, `Project '${clean.slug}' already exists`);
  }

  const slug = clean.slug;
  const workDir = ensureWorkspaceDir(slug);
  const containerName = `wsd-${slug}`;

  // Port mappings: expose requested host ports (bound to all interfaces)
  const portBindings: Record<string, any> = {};
  const exposedPorts: Record<string, any> = {};
  const hostPorts: Record<string, string> = {};
  if (clean.ports) {
    for (const p of clean.ports) {
      const key = `${p}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostIp: '0.0.0.0', HostPort: String(p) }];
      hostPorts[String(p)] = String(p);
    }
  }

  const container = await docker.createContainer({
    name: containerName,
    Image: clean.image || BASE_IMAGE,
    Cmd: ['/bin/bash', '-c', 'sleep infinity'],
    Tty: true,
    OpenStdin: true,
    Env: ['DEBIAN_FRONTEND=noninteractive'],
    ExposedPorts: exposedPorts,
    HostConfig: {
      Binds: [`${workDir}:/workspace`],
      PortBindings: portBindings,
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Labels: {
      'wsd.project': slug,
      'wsd.name': clean.name,
      'wsd.managed': 'true',
      'wsd.createdAt': new Date().toISOString(),
    },
    WorkingDir: '/workspace',
  });

  await container.start();

  const info: ProjectInfo = {
    id: container.id,
    name: clean.name,
    slug,
    description: clean.description,
    status: 'running',
    containerId: container.id,
    hostPorts,
    createdAt: new Date().toISOString(),
  };

  return info;
}

/**
 * List all WSD-managed projects (containers with wsd.managed=true).
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  const containers = await docker.listContainers({ all: true });
  const projects: ProjectInfo[] = [];

  for (const c of containers) {
    const labels = c.Labels || {};
    if (labels['wsd.managed'] !== 'true') continue;

    const slug = labels['wsd.project'] || c.Names[0]?.replace(/^\//, '');
    const ports: Record<string, string> = {};
    for (const p of c.Ports || []) {
      if (p.PublicPort) ports[String(p.PrivatePort)] = String(p.PublicPort);
    }

    projects.push({
      id: c.Id,
      name: labels['wsd.name'] || slug.replace(/^wsd-/, ''),
      slug,
      status: c.State === 'running' ? 'running' : 'stopped',
      containerId: c.Id,
      hostPorts: ports,
      createdAt: labels['wsd.createdAt'],
    });
  }

  return projects;
}

/**
 * Get a single project by slug.
 */
export async function getProject(slug: string): Promise<ProjectInfo | null> {
  try {
    const projectSlug = validateProjectSlug(slug);
    const projects = await listProjects();
    return projects.find((p) => p.slug === projectSlug) || null;
  } catch {
    return null;
  }
}

/**
 * Start a stopped project container.
 */
export async function startProject(slug: string): Promise<ProjectInfo> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  await container.start();
  const info = await getProject(projectSlug);
  if (!info) throw new HttpError(500, 'Project not found after start');
  info.status = 'running';
  return info;
}

/**
 * Stop a running project container.
 */
export async function stopProject(slug: string): Promise<ProjectInfo> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  await container.stop();
  const info = await getProject(projectSlug);
  if (!info) throw new HttpError(500, 'Project not found after stop');
  info.status = 'stopped';
  return info;
}

/**
 * Remove a project container entirely (keeps workspace dir).
 */
export async function removeProject(slug: string): Promise<void> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  await container.remove({ force: true });
}

/**
 * Get a project container's logs.
 */
export async function projectLogs(slug: string, tail = 200): Promise<string> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  const logs = await container.logs({ stdout: true, stderr: true, tail });
  return logs.toString('utf8');
}

export { WORKSPACES_ROOT, BASE_IMAGE };
