/**
 * docker-manager.ts
 * WSD-Pro — Docker orchestration layer.
 * Creates, starts, stops, and inspects per-project containers via Dockerode.
 */

import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';

const docker = new Docker(); // uses /var/run/docker.sock by default

// Host path where project workspaces live (bind-mounted into containers)
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/home/ahmedali/wsd-pro/workspaces';

// Base image used for project workspaces (Ubuntu + dev tooling)
const BASE_IMAGE = process.env.WSD_BASE_IMAGE || 'ubuntu:24.04';

// Images commonly needed inside workspaces: code-server, node, python, git
const WORKSPACE_ENV = [
  'DEBIAN_FRONTEND=noninteractive',
];

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
  idePort?: number;
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
    if (port === 3000 || port === Number(process.env.PORT || 3000)) {
      throw new HttpError(400, `Port ${port} is reserved for the WSD-Pro command center API.`);
    }
    if (port >= 8100 && port <= 8200) {
      throw new HttpError(400, `Port ${port} is reserved for WSD-Pro Web IDEs (8100-8200).`);
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

  // Find free IDE port
  const allProjects = await listProjects();
  const usedIdePorts = allProjects.map(p => p.idePort).filter(Boolean) as number[];
  let idePort = 8101;
  while (usedIdePorts.includes(idePort)) {
    idePort++;
  }

  // Port mappings: expose requested host ports
  const portBindings: Record<string, any> = {};
  const exposedPorts: Record<string, any> = {};
  const hostPorts: Record<string, string> = {};
  if (clean.ports) {
    for (const p of clean.ports) {
      const key = `${p}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p) }];
      hostPorts[String(p)] = String(p);
    }
  }

  // Add IDE port mapping (container 8080 -> host idePort)
  exposedPorts['8080/tcp'] = {};
  portBindings['8080/tcp'] = [{ HostPort: String(idePort) }];

  const container = await docker.createContainer({
    name: containerName,
    Image: clean.image || BASE_IMAGE,
    Cmd: ['/bin/bash', '-c', 'sleep infinity'],
    Tty: true,
    OpenStdin: true,
    Env: WORKSPACE_ENV,
    ExposedPorts: exposedPorts,
    HostConfig: {
      Binds: [`${workDir}:/workspace`],
      PortBindings: portBindings,
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Labels: {
      'wsd.project': slug,
      'wsd.managed': 'true',
      'wsd.ide.port': String(idePort),
      'wsd.createdAt': new Date().toISOString(),
    },
    WorkingDir: '/workspace',
  });

  await container.start();

  // Label metadata on the container for future lookups
  const info: ProjectInfo = {
    id: container.id,
    name: clean.name,
    slug,
    description: clean.description,
    status: 'running',
    containerId: container.id,
    hostPorts,
    idePort,
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
      name: slug.replace(/^wsd-/, ''),
      slug,
      status: c.State === 'running' ? 'running' : 'stopped',
      containerId: c.Id,
      hostPorts: ports,
      idePort: labels['wsd.ide.port'] ? parseInt(labels['wsd.ide.port'], 10) : undefined,
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
 * Execute a command inside a project container (for terminal / agent actions).
 */
export async function execInProject(
  slug: string,
  cmd: string[],
  opts: { stream?: boolean } = {}
): Promise<{ output: string; exitCode: number }> {
  const projectSlug = validateProjectSlug(slug);
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new HttpError(400, 'Command must be a non-empty array of non-empty strings');
  }
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  return new Promise((resolve, reject) => {
    exec.start({}, (err: any, stream: any) => {
      if (err) return reject(err);
      let output = '';
      if (stream) {
        // Docker multiplexed stream: 8-byte header per frame.
        // [0]=stream type, [1-3]=unused, [4-7]=length
        stream.on('data', (chunk: Buffer) => {
          let offset = 0;
          while (offset + 8 <= chunk.length) {
            const frameLen = chunk.readUInt32BE(offset + 4);
            if (offset + 8 + frameLen > chunk.length) break;
            output += chunk.subarray(offset + 8, offset + 8 + frameLen).toString('utf8');
            offset += 8 + frameLen;
          }
          // tail of a partial frame: carry over
          if (offset < chunk.length) {
            output += chunk.subarray(offset).toString('utf8');
          }
        });
        stream.on('end', () => {
          exec.inspect((ierr: any, data: any) => {
            if (ierr) return reject(ierr);
            resolve({ output, exitCode: data?.ExitCode ?? 0 });
          });
        });
        stream.on('error', reject);
      } else {
        resolve({ output: '', exitCode: 0 });
      }
    });
  });
}

export interface ExecSession {
  id: string;
  exec: any;
  stream: any;
}

/**
 * Start an interactive bash session inside a project container.
 * Uses a TTY exec (raw output — no 8-byte demux headers), returns a
 * full-duplex hijacked stream for reading output and writing input.
 */
export async function startInteractiveShell(slug: string): Promise<ExecSession> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  const exec = await container.exec({
    Cmd: ['/bin/bash', '-l'],
    Tty: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'LANG=C.UTF-8'],
  });
  const stream: any = await new Promise((resolve, reject) => {
    exec.start({ hijack: true, stdin: true }, (err: any, s: any) => {
      if (err) return reject(err);
      resolve(s);
    });
  });
  return { id: exec.id, exec, stream };
}

/** Resize the TTY of an interactive exec session (cols/rows). */
export function resizeExecSession(session: ExecSession, cols: number, rows: number): Promise<void> {
  return new Promise((resolve, reject) => {
    session.exec.resize({ h: rows, w: cols }, (err: any) => {
      if (err) return reject(err);
      resolve();
    });
  });
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
