/**
 * index.ts
 * WSD-Pro — Work Space Development Pro
 * Self-hosted command center for AI coding agents.
 * Each project = isolated Docker container with durable workspace.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import http from 'http';

import {
  createProject,
  listProjects,
  getProject,
  startProject,
  stopProject,
  removeProject,
  execInProject,
  projectLogs,
  WORKSPACES_ROOT,
} from './services/docker-manager';
import { ensureAdmin, login, requireAuth, loginRateLimit, resetLoginAttempts } from './services/auth';
import { getAgents, checkAgentAuth, runAgent, listTasks, getTask, stopTask } from './services/agents-manager';
import { attachWebSockets } from './ws/ws-server';
import { detectIp } from './services/server-info';
import { getIdeStatus, startIde, stopIde } from './services/ide-service';
import { scanProjectPorts } from './services/port-scanner';
import { gitStatus, gitLog, gitDiff, gitCommit } from './services/git-service';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Helmet with CSP that allows the app's inline onclick handlers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Auth ─────────────────────────────────────────────────────
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const result = await login(username, password);
    if (!result) return res.status(401).json({ error: 'Invalid credentials' });
    resetLoginAttempts(req.ip || 'unknown');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/status', requireAuth, (_req, res) => {
  res.json({ authenticated: true });
});

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'WSD-Pro',
    version: '0.2.0',
    timestamp: new Date().toISOString(),
  });
});

// ── Projects API (protected) ─────────────────────────────────

// List all projects
app.get('/api/projects', requireAuth, async (_req, res) => {
  try {
    const projects = await listProjects();
    res.json({ projects });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new project (provisions container + workspace)
app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const { name, slug, description, image, ports } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    // Validate ports: integers in 1..65535
    if (ports !== undefined) {
      if (!Array.isArray(ports)) {
        return res.status(400).json({ error: 'ports must be an array of numbers' });
      }
      for (const p of ports) {
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          return res.status(400).json({ error: `Invalid port: ${p} (must be 1-65535)` });
        }
      }
    }
    // Duplicate check before hitting Docker
    const existing = await getProject(slug || String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
    if (existing) {
      return res.status(409).json({ error: `Project '${existing.slug}' already exists` });
    }
    const project = await createProject({ name, slug, description, image, ports });
    res.status(201).json({ project });
  } catch (err: any) {
    const code = err.statusCode || (err.message && err.message.includes('Conflict') ? 409 : 500);
    res.status(code).json({ error: err.message });
  }
});

// Get single project
app.get('/api/projects/:slug', requireAuth, async (req, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Start project
app.post('/api/projects/:slug/start', requireAuth, async (req, res) => {
  try {
    const project = await startProject(req.params.slug);
    res.json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Stop project
app.post('/api/projects/:slug/stop', requireAuth, async (req, res) => {
  try {
    const project = await stopProject(req.params.slug);
    res.json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Remove project (container only; workspace kept)
app.delete('/api/projects/:slug', requireAuth, async (req, res) => {
  try {
    await removeProject(req.params.slug);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Execute a command inside a project container
app.post('/api/projects/:slug/exec', requireAuth, async (req, res) => {
  try {
    const { cmd } = req.body || {};
    if (!Array.isArray(cmd) || cmd.length === 0) {
      return res.status(400).json({ error: 'cmd must be a non-empty string array' });
    }
    const result = await execInProject(req.params.slug, cmd);
    res.json(result);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Project container logs
app.get('/api/projects/:slug/logs', requireAuth, async (req, res) => {
  try {
    const tail = Number(req.query.tail) || 200;
    const logs = await projectLogs(req.params.slug, tail);
    res.json({ logs });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Workspace file API (read via bind-mount host dirs) ───────
app.get('/api/projects/:slug/files', requireAuth, (req, res) => {
  try {
    const relPath = (req.query.path as string) || '.';
    const base = path.join(WORKSPACES_ROOT, req.params.slug);
    // Prevent path traversal
    const target = path.resolve(base, relPath);
    if (!target.startsWith(path.resolve(base))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(target)) {
      return res.status(404).json({ error: 'Path not found' });
    }
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target).map((name) => {
        const full = path.join(target, name);
        const s = fs.statSync(full);
        return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.size };
      });
      res.json({ path: relPath, entries });
    } else {
      const content = fs.readFileSync(target, 'utf8');
      res.json({ path: relPath, content });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── IDE file tree (recursive, lazy per folder) ────────────────
app.get('/api/projects/:slug/tree', requireAuth, (req, res) => {
  try {
    const relPath = (req.query.path as string) || '.';
    const base = path.join(WORKSPACES_ROOT, req.params.slug);
    const target = path.resolve(base, relPath);
    if (!target.startsWith(path.resolve(base))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Path not found' });
    const stat = fs.statSync(target);
    const read = (p: string): any => {
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        return {
          name: path.basename(p),
          type: 'dir',
          children: fs.readdirSync(p)
            .filter((n) => !n.startsWith('.') && n !== 'node_modules')
            .map((n) => read(path.join(p, n))),
        };
      }
      return { name: path.basename(p), type: 'file', size: s.size };
    };
    res.json({ path: relPath, tree: read(target) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── IDE: write file ───────────────────────────────────────────
app.post('/api/projects/:slug/file/write', requireAuth, (req, res) => {
  try {
    const { path: relPath, content } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const base = path.join(WORKSPACES_ROOT, req.params.slug);
    const target = path.resolve(base, relPath);
    if (!target.startsWith(path.resolve(base))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(path.dirname(target))) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    fs.writeFileSync(target, content ?? '', 'utf8');
    res.json({ ok: true, path: relPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── IDE: create file/folder ───────────────────────────────────
app.post('/api/projects/:slug/file', requireAuth, (req, res) => {
  try {
    const { path: relPath, type = 'file' } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const base = path.join(WORKSPACES_ROOT, req.params.slug);
    const target = path.resolve(base, relPath);
    if (!target.startsWith(path.resolve(base))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      if (fs.existsSync(target)) return res.status(409).json({ error: 'Already exists' });
      fs.writeFileSync(target, '', 'utf8');
    }
    res.json({ ok: true, path: relPath, type });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── IDE: delete file/folder ───────────────────────────────────
app.delete('/api/projects/:slug/file', requireAuth, (req, res) => {
  try {
    const relPath = (req.query.path as string) || '';
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const base = path.join(WORKSPACES_ROOT, req.params.slug);
    const target = path.resolve(base, relPath);
    if (!target.startsWith(path.resolve(base))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true, path: relPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── IDE: rename file/folder ───────────────────────────────────
app.post('/api/projects/:slug/file/rename', requireAuth, (req, res) => {
  try {
    const { path: relPath, newName } = req.body || {};
    if (!relPath || !newName) return res.status(400).json({ error: 'path and newName required' });
    const base = path.join(WORKSPACES_ROOT, req.params.slug);
    const target = path.resolve(base, relPath);
    const dest = path.resolve(path.dirname(target), newName);
    if (!target.startsWith(path.resolve(base)) || !dest.startsWith(path.resolve(base))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
    fs.renameSync(target, dest);
    res.json({ ok: true, path: relPath, newPath: path.relative(base, dest) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server info / networking ─────────────────────────────────
app.get('/api/server/info', requireAuth, (_req, res) => {
  const ips = detectIp();
  res.json({
    version: '0.2.0',
    lanIp: ips.lanIp,
    tailscaleIp: ips.tailscaleIp,
    idePort: Number(process.env.WSD_IDE_PORT) || 8100,
    basePort: PORT,
    timestamp: new Date().toISOString(),
  });
});

// ── Live port discovery (preview links) ──────────────────────
app.get('/api/projects/:slug/ports', requireAuth, async (req, res) => {
  try {
    const fresh = req.query.fresh === '1';
    const ports = await scanProjectPorts(req.params.slug, fresh);
    res.json({ slug: req.params.slug, ports });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Git inside project workspace ─────────────────────────────
app.get('/api/projects/:slug/git/status', requireAuth, async (req, res) => {
  try {
    res.json({ slug: req.params.slug, output: await gitStatus(req.params.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/projects/:slug/git/log', requireAuth, async (req, res) => {
  try {
    const count = Math.min(100, Number(req.query.count) || 20);
    res.json({ slug: req.params.slug, output: await gitLog(req.params.slug, count) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/projects/:slug/git/diff', requireAuth, async (req, res) => {
  try {
    const output = await gitDiff(req.params.slug, req.query.staged === '1');
    res.json({ slug: req.params.slug, output });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/projects/:slug/git/commit', requireAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'commit message required' });
    }
    const output = await gitCommit(req.params.slug, String(message));
    res.json({ slug: req.params.slug, output });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Shared Web IDE (code-server on :WSD_IDE_PORT) ────────────
app.get('/api/ide/status', requireAuth, async (_req, res) => {
  try {
    res.json({ ide: await getIdeStatus() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ide/start', requireAuth, async (_req, res) => {
  try {
    const ide = await startIde();
    res.json({ ide });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ide/stop', requireAuth, async (_req, res) => {
  try {
    const ide = await stopIde();
    res.json({ ide });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Bridge API ─────────────────────────────────────────
app.get('/api/agents', requireAuth, async (_req, res) => {
  try {
    const agents = getAgents();
    const withAuth = await Promise.all(
      agents.map(async (a) => ({ ...a, auth: await checkAgentAuth(a.name) }))
    );
    res.json({ agents: withAuth });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:name/run', requireAuth, async (req, res) => {
  try {
    const { project, prompt } = req.body || {};
    if (!project || !prompt) {
      return res.status(400).json({ error: 'project and prompt are required' });
    }
    const task = await runAgent(req.params.name, project, prompt);
    res.status(202).json({ task });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agents/tasks', requireAuth, (req, res) => {
  try {
    const agent = req.query.agent as string | undefined;
    res.json({ tasks: listTasks(agent) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/tasks/:id', requireAuth, (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});

app.post('/api/agents/tasks/:id/stop', requireAuth, (req, res) => {
  const ok = stopTask(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

// ── Serve frontend static build if present ───────────────────
// Prefer ../frontend (dev), fall back to ../public (legacy)
const frontendDist =
  fs.existsSync(path.join(__dirname, '..', '..', 'frontend')) &&
  fs.existsSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'))
    ? path.join(__dirname, '..', '..', 'frontend')
    : path.join(__dirname, '..', 'public');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback — catch-all (Express 5 compatible)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log(`[WSD-Pro] Serving frontend from ${frontendDist}`);
}

// ── Start ────────────────────────────────────────────────────
const server = http.createServer(app);
attachWebSockets(server);

ensureAdmin()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[WSD-Pro] Command center listening on http://${HOST}:${PORT}`);
      console.log(`[WSD-Pro] WebSocket hub on ws://${HOST}:${PORT}/ws`);
      console.log(`[WSD-Pro] Workspaces root: ${WORKSPACES_ROOT}`);
      console.log(`[WSD-Pro] Docker socket: /var/run/docker.sock`);
    });
  })
  .catch((err: any) => {
    console.error('[WSD-Pro] Startup failed:', err);
    process.exit(1);
  });
