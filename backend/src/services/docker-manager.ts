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
import crypto from 'crypto';
import { execSync, spawn, execFileSync } from 'child_process';
import { loadMeta, saveMeta, deleteMeta, touchActivity, listMetaSlugs, type ProjectMeta } from './projects-meta';
import { purgeOpencodeProjectRows } from './opencode-store';
import {
  createOpencodeSession,
  ensureOpencodeSession as ensureOpencodeSessionApi,
  unregisterOpencodeProjectSessions,
} from './opencode-api';

const docker = new Docker(); // uses /var/run/docker.sock by default

// Host path where project workspaces live (bind-mounted into containers)
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';
// Host-side path of the same directory, used as the bind source for project
// containers. Bind sources are resolved by the Docker daemon (the Docker
// Desktop VM), so a container-internal path like /workspaces/<slug> would
// resolve to an unrelated empty directory there.
const WORKSPACES_HOST_DIR = (process.env.WSD_WORKSPACES_HOST_DIR || '').replace(/[\\/]+$/, '');

// Base image used for project workspaces (Ubuntu + dev tooling)
const BASE_IMAGE = process.env.WSD_WORKSPACE_IMAGE || 'wsd/workspace:latest';

export interface ProjectSpec {
  name: string;
  slug: string;
  description?: string;
  image?: string;
  ports?: number[]; // host ports to expose
  env?: Record<string, string>;
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
  image?: string;
  ports?: number[];
  env?: Record<string, string>;
  activity?: { action: string; at: string }[];
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

function validateProjectSpec(spec: ProjectSpec): { name: string; slug: string; description?: string; image?: string; ports?: number[]; env: Record<string, string> } {
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
    const opencodePort = Number(process.env.WSD_OPENCODE_PORT) || 4096;
    if (port === dashboardPort) {
      throw new HttpError(400, `Port ${port} is reserved for the WSD-Pro dashboard.`);
    }
    if (port === idePort) {
      throw new HttpError(400, `Port ${port} is reserved for the WSD-Pro Web IDE.`);
    }
    if (port === opencodePort) {
      throw new HttpError(400, `Port ${port} is reserved for the WSD-Pro opencode web UI.`);
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
    env: normalizeEnv(spec.env),
  };
}

function normalizeEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object') return out;
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (typeof v === 'string' && v.length <= 4000) out[k] = v;
  }
  return out;
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

// opencode runtime integration (sessions, version, updates) lives in
// services/opencode-api.ts — this module only forwards to it.

function registerOpencodeProject(slug: string): void {
  createOpencodeSession(slug);
}

/** Ensure a project has at least one opencode session (no duplicates). */
export function ensureOpencodeSession(slug: string): void {
  ensureOpencodeSessionApi(slug);
}

/**
 * Best-effort cleanup of opencode sessions bound to a deleted project's
 * directory, so stale sessions don't linger in the web UI. Non-fatal: any
 * failure (opencode down, API shape drift) is silently ignored.
 */
function unregisterOpencodeProject(slug: string): void {
  unregisterOpencodeProjectSessions(slug);
}

/**
 * Make sure the project image exists locally; if not, pull it so
 * `docker create` never fails on a missing image (fresh hosts, CI, etc).
 */
async function ensureImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // image not present locally — pull it
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: any, stream: any) => {
      if (err || !stream) {
        return reject(new Error(`Failed to pull ${image}: ${err?.message || 'no stream'}`));
      }
      stream.on('data', () => { /* progress */ });
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
      stream.on('error', (e: Error) => reject(new Error(`Failed to pull ${image}: ${e.message}`)));
    });
  });
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
  // Guard against silently inheriting files left behind by a previously
  // deleted project (crash mid-delete, pre-upgrade leftovers, manual dirs).
  // The janitor archives such strays automatically, so this window is small.
  const workDirPath = path.join(WORKSPACES_ROOT, slug);
  if (!loadMeta(slug) && fs.existsSync(workDirPath)) {
    let hasLeftovers = false;
    try {
      hasLeftovers = fs
        .readdirSync(workDirPath)
        .some((f) => f !== '.archive' && !f.startsWith('.'));
    } catch {
      /* unreadable — let creation proceed */
    }
    if (hasLeftovers) {
      throw new HttpError(
        409,
        `A workspace folder '${slug}' already exists from an earlier project. ` +
          'It is archived automatically within a few minutes — retry shortly.',
      );
    }
  }
  const workDir = ensureWorkspaceDir(slug);
  const bindSource = WORKSPACES_HOST_DIR
    ? `${WORKSPACES_HOST_DIR.replace(/\\/g, '/')}/${slug}`
    : workDir;
  const containerName = `wsd-${slug}`;
  const image = clean.image || BASE_IMAGE;
  await ensureImage(image);

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
    Image: image,
    Cmd: ['/bin/bash', '-c', 'sleep infinity'],
    Tty: true,
    OpenStdin: true,
    Env: [
      ...Object.entries(clean.env || {}).map(([k, v]) => `${k}=${v}`),
      'DEBIAN_FRONTEND=noninteractive',
    ],
    ExposedPorts: exposedPorts,
    HostConfig: {
      Binds: [`${bindSource}:/workspace`],
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

  registerOpencodeProject(slug);

  const info: ProjectInfo = {
    id: container.id,
    name: clean.name,
    slug,
    description: clean.description,
    status: 'running',
    containerId: container.id,
    hostPorts,
    createdAt: new Date().toISOString(),
    image,
    ports: clean.ports,
    env: clean.env,
  };

  const prev = loadMeta(slug);
  saveMeta(slug, {
    name: clean.name,
    description: clean.description,
    image,
    ports: clean.ports,
    createdAt: info.createdAt,
    env: clean.env,
    activity: [
      ...(prev?.activity || []),
      { action: 'created', at: new Date().toISOString() },
    ].slice(-200),
  });

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

    const project: ProjectInfo = {
      id: c.Id,
      name: labels['wsd.name'] || slug.replace(/^wsd-/, ''),
      slug,
      status: c.State === 'running' ? 'running' : 'stopped',
      containerId: c.Id,
      hostPorts: ports,
      createdAt: labels['wsd.createdAt'],
    };

    const meta = loadMeta(slug);
    if (meta) {
      if (meta.name) project.name = meta.name;
      project.description = meta.description;
      project.image = meta.image;
      project.ports = meta.ports;
      project.env = meta.env;
      project.activity = meta.activity;
    }

    projects.push(project);
  }

  return projects;
}

/**
 * Get a single project by slug — O(1) direct container lookup.
 */
export async function getProject(slug: string): Promise<ProjectInfo | null> {
  try {
    const projectSlug = validateProjectSlug(slug);
    const container = docker.getContainer(`wsd-${projectSlug}`);
    const data = await container.inspect();

    const labels = data.Config?.Labels || {};
    if (labels['wsd.managed'] !== 'true') return null;

    const ports: Record<string, string> = {};
    const portBindings = (data.HostConfig?.PortBindings || {}) as Record<string, Array<{ HostPort?: string }>>;
    for (const [priv, bindings] of Object.entries(portBindings)) {
      if (bindings && bindings.length > 0 && bindings[0].HostPort) {
        ports[priv.replace('/tcp', '')] = bindings[0].HostPort;
      }
    }

    const project: ProjectInfo = {
      id: data.Id?.slice(0, 12) || '',
      name: labels['wsd.name'] || projectSlug,
      slug: projectSlug,
      status: data.State?.Running ? 'running' : 'stopped',
      containerId: data.Id || '',
      hostPorts: ports,
      createdAt: labels['wsd.createdAt'],
    };

    const meta = loadMeta(projectSlug);
    if (meta) {
      if (meta.name) project.name = meta.name;
      project.description = meta.description;
      project.image = meta.image;
      project.ports = meta.ports;
      project.env = meta.env;
      project.activity = meta.activity;
    }

    return project;
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
  touchActivity(projectSlug, 'started');
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
  touchActivity(projectSlug, 'stopped');
  const info = await getProject(projectSlug);
  if (!info) throw new HttpError(500, 'Project not found after stop');
  info.status = 'stopped';
  return info;
}

/**
 * Remove a project entirely: container, meta store AND its workspace files
 * from disk. opencode session cleanup is best-effort (non-fatal).
 */
export async function removeProject(slug: string): Promise<void> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  await container.remove({ force: true });
  deleteMeta(projectSlug);
  removeWorkspaceDir(projectSlug);
  unregisterOpencodeProject(projectSlug);
  purgeOpencodeProjectRows([projectSlug]);
}

/**
 * Delete a workspace directory from disk — path-escape guarded, and failures
 * are non-fatal (the janitor archives any leftover on its next sweep).
 */
function removeWorkspaceDir(slug: string): void {
  try {
    const root = path.resolve(WORKSPACES_ROOT);
    const dir = path.resolve(root, slug);
    if (dir !== root && !dir.startsWith(root + path.sep)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* janitor archives leftovers */
  }
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

// ── Extended project capabilities ────────────────────────────

export interface ProjectStats {
  running: boolean;
  cpuPct: number;
  memBytes: number;
  memLimit: number;
  memPct: number;
  startedAt: string | null;
}

/** One-shot container stats (CPU %, memory) + uptime from inspect. */
export async function getProjectStats(slug: string): Promise<ProjectStats> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  const [stats, inspect] = await Promise.all([
    container.stats({ stream: false }) as unknown as any,
    container.inspect(),
  ]);

  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta =
    (stats.cpu_stats?.system_cpu_usage || 0) -
    (stats.precpu_stats?.system_cpu_usage || 0);
  const cpuCount = stats.cpu_stats?.online_cpus || 1;
  const cpuPct = sysDelta > 0 ? (cpuDelta / sysDelta) * cpuCount * 100 : 0;

  const memBytes = stats.memory_stats?.usage || 0;
  const memLimit = stats.memory_stats?.limit || 0;
  const memPct = memLimit > 0 ? (memBytes / memLimit) * 100 : 0;

  return {
    running: Boolean(inspect?.State?.Running),
    cpuPct: Math.round(cpuPct * 10) / 10,
    memBytes,
    memLimit,
    memPct: Math.round(memPct * 10) / 10,
    startedAt: inspect?.State?.StartedAt || null,
  };
}

export interface PortHealth {
  port: string;
  hostPort: string;
  status: 'open' | 'refused' | 'timeout' | 'error';
  httpCode: number | null;
  ms: number;
}

/** Probe each published host port over HTTP from inside the control container. */
export async function checkProjectPorts(slug: string): Promise<PortHealth[]> {
  const project = await requireContainer(slug);
  if (!project.hostPorts || Object.keys(project.hostPorts).length === 0) return [];

  const results: PortHealth[] = [];
  for (const [priv, pub] of Object.entries(project.hostPorts)) {
    const started = Date.now();
    const url = `http://host.docker.internal:${pub}/`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      results.push({
        port: priv,
        hostPort: pub,
        status: 'open',
        httpCode: res.status,
        ms: Date.now() - started,
      });
    } catch (err: any) {
      results.push({
        port: priv,
        hostPort: pub,
        status: err?.name === 'TimeoutError' ? 'timeout' : 'refused',
        httpCode: null,
        ms: Date.now() - started,
      });
    }
  }
  return results;
}

/** Stop + recreate a project container from its stored meta (env/image/ports). */
export async function recreateProject(slug: string): Promise<ProjectInfo> {
  const projectSlug = validateProjectSlug(slug);
  const proj = await requireContainer(projectSlug);
  const meta: ProjectMeta = loadMeta(projectSlug) || { activity: [] };

  if (proj.containerId) {
    const c = docker.getContainer(proj.containerId);
    await c.stop().catch(() => {});
    await c.remove({ force: true }).catch(() => {});
  }

  return createProject({
    name: meta.name || proj.name,
    slug: projectSlug,
    description: meta.description,
    image: meta.image,
    ports: meta.ports,
    env: meta.env,
  });
}

export interface ScriptRunResult {
  exitCode: number | null;
  output: string;
}

/** Run `npm run <script>` inside the project container (must be running). */
export async function runProjectScript(slug: string, script: string): Promise<ScriptRunResult> {
  const projectSlug = validateProjectSlug(slug);
  const proj = await requireContainer(projectSlug);
  if (proj.status !== 'running') throw new HttpError(409, 'Project is stopped. Start it first.');

  const container = docker.getContainer(`wsd-${projectSlug}`);
  const exec = await container.exec({
    Cmd: ['sh', '-lc', `npm run ${script} 2>&1`],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream: any = await exec.start({ hijack: false });

  let output = '';
  let raw = Buffer.alloc(0);
  await new Promise<void>((resolve) => {
    const onData = (d: Buffer) => {
      // docker stream: [1 byte stream][3 bytes padding][4 byte big-endian len]
      // then payload. Demux by walking frames in case a chunk splits a frame.
      raw = Buffer.concat([raw, d]);
      while (raw.length >= 8) {
        const size = raw.readUInt32BE(4);
        if (raw.length < 8 + size) break;
        output += raw.subarray(8, 8 + size).toString('utf8');
        raw = raw.subarray(8 + size);
      }
      if (output.length > 300000) output = output.slice(-300000);
    };
    stream.on('data', onData);
    stream.on('end', resolve);
    stream.on('error', resolve);
    const timer = setTimeout(() => {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    }, 180000);
    stream.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const info = await exec.inspect().catch(() => null);
  return { exitCode: info?.ExitCode ?? null, output };
}

/** git clone into the project workspace (empty workspace → root, else subdir). */
export async function cloneIntoWorkspace(
  slug: string,
  url: string
): Promise<{ target: string; output: string }> {
  const projectSlug = validateProjectSlug(slug);
  const base = path.resolve(WORKSPACES_ROOT, projectSlug);
  if (!fs.existsSync(base)) throw new HttpError(404, `Project workspace '${projectSlug}' not found`);

  const cleanUrl = String(url ?? '').trim();
  const validHttp = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(cleanUrl);
  const validScp = /^[\w.-]+@[\w.-]+:[\w./-]+$/i.test(cleanUrl);
  const validShort = /^[\w.-]+\/[\w.-]+(\.git)?$/.test(cleanUrl);
  if (!validHttp && !validScp && !validShort) {
    throw new HttpError(400, 'Invalid git repository URL');
  }

  const existing = fs.readdirSync(base).filter((f) => f !== '.git');
  let target = existing.length === 0 ? base : path.join(base, repoName(cleanUrl));

  // If we're cloning into the root, the only thing there may be the auto-init
  // .git scaffold (no commits) created for opencode registration — drop it so
  // `git clone` can seed the workspace. Keep any .git that has real history.
  if (target === base && fs.existsSync(path.join(base, '.git'))) {
    let hasCommits = true;
    try {
      hasCommits =
        execFileSync('git', ['-C', base, 'rev-parse', '--verify', 'HEAD'], {
          stdio: 'pipe',
        }).toString().trim().length > 0;
    } catch {
      hasCommits = false;
    }
    if (!hasCommits) {
      fs.rmSync(path.join(base, '.git'), { recursive: true, force: true });
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', '--depth', '1', '--progress', cleanUrl, target], { cwd: '/' });
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString('utf8');
      if (output.length > 5000) output = output.slice(-5000);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 300000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        touchActivity(projectSlug, 'cloned');
        resolve({ target: path.relative(base, target).split(path.sep).join('/'), output });
      } else {
        reject(new Error(`git clone failed (exit ${code}): ${output.slice(-2000)}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function repoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/i, '');
  const name = cleaned.split('/').pop() || cleaned.split(':').pop() || 'repo';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'repo';
}
