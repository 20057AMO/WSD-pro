/**
 * index.ts
 * WSD-Pro — Work Space Development Pro v2
 * Docker-compose app: dashboard + unified code-server IDE + opencode + chat.
 * No login. Each project = isolated container with durable workspace.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import http from 'http';
import multer from 'multer';

import {
  createProject,
  listProjects,
  getProject,
  startProject,
  stopProject,
  removeProject,
  projectLogs,
  HttpError,
  WORKSPACES_ROOT,
} from './services/docker-manager';
import { getIdeStatus } from './services/ide-service';
import { detectIp } from './services/server-info';
import { MODEL } from './services/ollama-chat';
import { attachWebSockets } from './ws/ws-server';

dotenv.config();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Helmet (CSP off — the UI is served from the same origin)
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Uploads (files into an existing project workspace) ────────
const UPLOADS_TMP = '/tmp/wsd-uploads';
fs.mkdirSync(UPLOADS_TMP, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_TMP),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 50 },
});

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'WSD-Pro',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── Server info / networking ─────────────────────────────────
app.get('/api/server/info', (_req, res) => {
  const ips = detectIp();
  res.json({
    version: '2.0.0',
    lanIp: ips.lanIp,
    tailscaleIp: ips.tailscaleIp,
    basePort: PORT,
    timestamp: new Date().toISOString(),
  });
});

// ── Chatbot info ─────────────────────────────────────────────
app.get('/api/chat/info', (_req, res) => {
  res.json({ model: MODEL });
});

// ── Unified Web IDE status (port + password) ─────────────────
app.get('/api/ide/status', async (_req, res) => {
  try {
    res.json({ ide: await getIdeStatus() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── opencode web status ──────────────────────────────────────
const OPENCODE_PORT = Number(process.env.WSD_OPENCODE_PORT) || 4096;

async function opencodeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

app.get('/api/opencode/status', async (_req, res) => {
  res.json({ running: await opencodeRunning(), port: OPENCODE_PORT });
});


// ── Projects API ─────────────────────────────────────────────

// List all projects
app.get('/api/projects', async (_req, res) => {
  try {
    const projects = await listProjects();
    res.json({ projects });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new project (provisions container + workspace)
app.post('/api/projects', async (req, res) => {
  try {
    const { name, slug, description, image, ports } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const project = await createProject({ name, slug, description, image, ports });
    res.status(201).json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Get single project
app.get('/api/projects/:slug', async (req, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Start project
app.post('/api/projects/:slug/start', async (req, res) => {
  try {
    const project = await startProject(req.params.slug);
    res.json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Stop project
app.post('/api/projects/:slug/stop', async (req, res) => {
  try {
    const project = await stopProject(req.params.slug);
    res.json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Remove project (container only; workspace kept)
app.delete('/api/projects/:slug', async (req, res) => {
  try {
    await removeProject(req.params.slug);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Project container logs
app.get('/api/projects/:slug/logs', async (req, res) => {
  try {
    const tail = Number(req.query.tail) || 200;
    const logs = await projectLogs(req.params.slug, tail);
    res.json({ logs });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Upload files into an existing project workspace (files only, no archives)
app.post('/api/projects/:slug/upload', (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const base = path.resolve(path.join(WORKSPACES_ROOT, slug));
  if (!fs.existsSync(base)) {
    return res.status(404).json({ error: `Project workspace '${slug}' not found` });
  }

  upload.array('files', 50)(req, res, (err: any) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    const files = (req.files || []) as Express.Multer.File[];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const saved: { name: string; path: string }[] = [];
    for (const file of files) {
      const rel = normalizeUploadPath((req.body as any)?.paths?.[file.originalname] || file.originalname);
      if (!rel) continue;
      const target = uniqueTargetPath(base, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.path, target);
      fs.unlinkSync(file.path);
      saved.push({ name: file.originalname, path: path.relative(base, target).split(path.sep).join('/') });
    }
    res.status(201).json({ ok: true, files: saved });
  });
});

/**
 * Resolve a target path inside the workspace; if a file already exists there,
 * append a numeric suffix before the extension so re-uploads never overwrite.
 */
function uniqueTargetPath(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  if (!target.startsWith(base)) return path.join(base, path.basename(rel));
  if (!fs.existsSync(target)) return target;

  const ext = path.extname(target);
  const stem = path.join(path.dirname(target), path.basename(target, ext));
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Keep upload paths inside the project workspace; strips leading slashes,
 * resolves '..' segments safely, and falls back to the bare filename.
 */
function normalizeUploadPath(raw: string): string | null {
  const value = String(raw ?? '').trim();
  const clean = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean === '.') return null;
  if (clean.startsWith('..') || clean.includes('/../') || clean.endsWith('/..')) return null;
  return clean.slice(0, 1024);
}

// ── Serve frontend static build if present ───────────────────
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback — catch-all (Express 5 compatible)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log(`[WSD-Pro] Serving frontend from ${frontendDist}`);
}

// ── Error handler ────────────────────────────────────────────
app.use((err: any, _req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[WSD-Pro] Unhandled error:', err?.stack || err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────
const server = http.createServer(app);
attachWebSockets(server);

server.listen(PORT, HOST, () => {
  console.log(`[WSD-Pro] Dashboard on http://${HOST}:${PORT}`);
  console.log(`[WSD-Pro] WebSocket hub on ws://${HOST}:${PORT}/ws`);
  console.log(`[WSD-Pro] Workspaces root: ${WORKSPACES_ROOT}`);
  console.log(`[WSD-Pro] opencode web on port ${OPENCODE_PORT}`);
  console.log(`[WSD-Pro] Chat model: ${MODEL}`);
  console.log(`[WSD-Pro] Docker socket: /var/run/docker.sock`);
});
