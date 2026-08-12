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
  createdAt?: string;
}

function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || `project-${Date.now()}`;
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
  const info = await getProject(slug);
  if (!info) throw new HttpError(404, `Project '${slug}' not found`);
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
  const slug = spec.slug || sanitizeSlug(spec.name);
  const workDir = ensureWorkspaceDir(slug);
  const containerName = `wsd-${slug}`;

  // Port mappings: expose requested host ports
  const portBindings: Record<string, any> = {};
  const exposedPorts: Record<string, any> = {};
  const hostPorts: Record<string, string> = {};
  if (spec.ports) {
    for (const p of spec.ports) {
      const key = `${p}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p) }];
      hostPorts[String(p)] = String(p);
    }
  }

  const container = await docker.createContainer({
    name: containerName,
    Image: spec.image || BASE_IMAGE,
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
    },
    WorkingDir: '/workspace',
  });

  await container.start();

  // Label metadata on the container for future lookups
  const info: ProjectInfo = {
    id: container.id,
    name: spec.name,
    slug,
    description: spec.description,
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
      name: slug.replace(/^wsd-/, ''),
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
  const projects = await listProjects();
  return projects.find((p) => p.slug === slug) || null;
}

/**
 * Start a stopped project container.
 */
export async function startProject(slug: string): Promise<ProjectInfo> {
  await requireContainer(slug);
  const container = docker.getContainer(`wsd-${slug}`);
  await container.start();
  const info = await getProject(slug);
  if (!info) throw new HttpError(500, 'Project not found after start');
  info.status = 'running';
  return info;
}

/**
 * Stop a running project container.
 */
export async function stopProject(slug: string): Promise<ProjectInfo> {
  await requireContainer(slug);
  const container = docker.getContainer(`wsd-${slug}`);
  await container.stop();
  const info = await getProject(slug);
  if (!info) throw new HttpError(500, 'Project not found after stop');
  info.status = 'stopped';
  return info;
}

/**
 * Remove a project container entirely (keeps workspace dir).
 */
export async function removeProject(slug: string): Promise<void> {
  await requireContainer(slug);
  const container = docker.getContainer(`wsd-${slug}`);
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
  await requireContainer(slug);
  const container = docker.getContainer(`wsd-${slug}`);
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

/**
 * Get a project container's logs.
 */
export async function projectLogs(slug: string, tail = 200): Promise<string> {
  await requireContainer(slug);
  const container = docker.getContainer(`wsd-${slug}`);
  const logs = await container.logs({ stdout: true, stderr: true, tail });
  return logs.toString('utf8');
}

export { WORKSPACES_ROOT, BASE_IMAGE };
