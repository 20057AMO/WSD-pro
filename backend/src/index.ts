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
import { getChatConfig, updateChatConfig, listModels, type ChatConfig } from './services/chat-config';
import { listProviders, updateProvider, getProviderConfig } from './services/provider-store';
import { authenticate, verifyToken, revokeToken } from './services/providers-auth';
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
app.get('/api/chat/info', async (_req, res) => {
  const cfg = getChatConfig();
  const models = await listModels(cfg.provider);
  res.json({ ...cfg, models });
});

// Update chat configuration (provider / model / language / system prompt / temperature)
app.post('/api/chat/config', (req, res) => {
  try {
    const { provider, model, systemPrompt, language, temperature } = req.body || {};
    const patch: Partial<ChatConfig> = {};
    if (provider === 'ollama' || provider === 'local') patch.provider = provider;
    if (typeof model === 'string' && model.trim()) patch.model = model.trim().slice(0, 200);
    if (typeof systemPrompt === 'string') patch.systemPrompt = systemPrompt.slice(0, 20000);
    if (language === 'auto' || language === 'ar' || language === 'en') patch.language = language;
    if (typeof temperature === 'number' && temperature >= 0 && temperature <= 2) patch.temperature = temperature;
    res.json(updateChatConfig(patch));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List models available from a provider (ollama | local)
app.get('/api/chat/models', async (req, res) => {
  const provider = req.query.provider === 'local' ? 'local' : 'ollama';
  const models = await listModels(provider);
  res.json({ models });
});

// ── Providers (password-protected API key management) ────────
function requireProvidersAuth(req: any, res: any, next: any): void {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!verifyToken(token)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function bearerToken(req: any): string | null {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function isProviderId(value: string): boolean {
  return value === 'ollama' || value === 'local';
}

app.post('/api/providers/auth', (req, res) => {
  const password = (req.body || {}).password;
  const token = authenticate(typeof password === 'string' ? password : '');
  if (!token) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  res.json({ token });
});

app.post('/api/providers/logout', requireProvidersAuth, (req, res) => {
  const token = bearerToken(req);
  if (token) revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/providers', requireProvidersAuth, (_req, res) => {
  res.json({ providers: listProviders() });
});

app.put('/api/providers/:id', requireProvidersAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!isProviderId(id)) {
    res.status(404).json({ error: 'Unknown provider' });
    return;
  }
  const { host, apiKey, enabled } = req.body || {};
  const provider = updateProvider(id, { host, apiKey, enabled });
  res.json({ provider });
});

app.post('/api/providers/:id/test', requireProvidersAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!isProviderId(id)) {
    res.status(404).json({ error: 'Unknown provider' });
    return;
  }
  const cfg = getProviderConfig(id);
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const resp = await fetch(`${cfg.host}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    const body = (await resp.json().catch(() => ({}))) as { models?: unknown[] };
    res.json({
      ok: resp.ok,
      status: resp.status,
      modelCount: Array.isArray(body.models) ? body.models.length : 0,
    });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || String(err) });
  }
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
  console.log(`[WSD-Pro] Chat model: ${getChatConfig().model}`);
  console.log(`[WSD-Pro] Docker socket: /var/run/docker.sock`);
});
