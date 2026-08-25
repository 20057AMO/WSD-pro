/**
 * index.ts
 * Madar — Work Space Development Pro v2
 * Docker-compose app: dashboard + unified code-server IDE + opencode + chat.
 * Each project = isolated container with durable workspace.
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
  getProjectStats,
  checkProjectPorts,
  recreateProject,
  runProjectScript,
  cloneIntoWorkspace,
  ensureOpencodeSession,
  HttpError,
  WORKSPACES_ROOT,
} from './services/docker-manager';
import { startJanitor } from './services/workspace-janitor';
import * as studio from './services/opencode-studio';
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, renameWorkspacePath, deleteWorkspacePath, resolveProjectSubdir } from './services/workspace-files';
import { loadMeta, saveMeta } from './services/projects-meta';
import { getIdeStatus } from './services/ide-service';
import { detectIp } from './services/server-info';
import { getChatConfig, updateChatConfig, listModels, type ChatConfig } from './services/chat-config';
import {
  listProviders,
  updateProvider,
  getProviderConfig,
  getProviderMeta,
  createProvider,
  deleteProvider,
  findDuplicateByKeyOrHost,
  KNOWN_TEMPLATES,
} from './services/provider-store';
import { detectProvider, checkProvider } from './services/providers-detect';
import { getProjectContext, listProjectsBrief, capText } from './services/project-context';
import * as notes from './services/project-notes';
import { getIndexStats, retrieveProject, formatRetrievedChunks } from './services/project-index';
import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
} from './services/chat-sessions';
import {
  setup,
  login,
  verifyCredentials,
  issueSessionToken,
  changePassword,
  hasUser,
  getUser,
  verifyToken,
  hasProvidersPassword,
  setProvidersPassword,
  removeProvidersPassword,
  issueUnlockToken,
  verifyUnlockToken,
  verifyAccountPassword,
  revokeAllSessions,
  revokeProvidersUnlocks,
  isTotpEnabled,
  beginTotpSetup,
  enableTotp,
  disableTotp,
  verifyTotpCode,
  signPending2faToken,
  verifyPending2faToken,
} from './services/user-store';
import { otpauthUri } from './services/totp';
import { buildBackup, restoreFromBackup } from './services/settings-export';
import { recordAudit, listAudit } from './services/audit-store';
import { authMiddleware } from './middleware/auth';
import { attachWebSockets } from './ws/ws-server';

dotenv.config();

// Loud, unmissable warning when the deployment runs on a publicly-known
// signing secret — tokens would be forgeable by anyone with the repo.
const INSECURE_SECRETS = new Set([
  'wsd-pro-insecure-default',
  'wsd-pro-default-secret-change-me',
  'change-me',
]);
if (!process.env.JWT_SECRET || INSECURE_SECRETS.has(process.env.JWT_SECRET)) {
  console.warn('┌──────────────────────────────────────────────────────────────┐');
  console.warn('│  ⚠ SECURITY WARNING: JWT_SECRET is missing or uses a known   │');
  console.warn('│  default. Session tokens are forgeable. Set a long random    │');
  console.warn('│  JWT_SECRET in your .env and restart immediately.            │');
  console.warn('└──────────────────────────────────────────────────────────────┘');
}

const app = express();
// Trust exactly one reverse-proxy hop ONLY when explicitly enabled — with
// the port published directly, a hardcoded trust would let clients spoof
// X-Forwarded-For and defeat every per-IP limiter and the unlock cooldown.
if (process.env.WSD_TRUST_PROXY === '1' || process.env.WSD_TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Helmet (CSP off — the UI is served from the same origin)
app.use(helmet({ contentSecurityPolicy: false }));
// CORS is opt-in via WSD_CORS_ORIGINS (comma-separated). The UI is always
// same-origin (served by this server; vite dev proxies /api and /ws), so the
// wildcard default of `cors()` would hand every website read access to the
// authenticated API. With no env set no ACAO headers are emitted at all.
const corsOrigins = String(process.env.WSD_CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (corsOrigins.length > 0) {
  app.use(
    cors({
      origin(origin, cb) {
        cb(null, !origin || corsOrigins.includes(origin));
      },
    })
  );
}
app.use(express.json({ limit: '10mb' }));

// ── Rate limiting (simple in-memory, per IP, per scope) ───────
// Fixed-window counters, namespaced per scope so the global limit and the
// stricter dangerous-endpoint limit never contaminate each other's budget.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW = 60_000; // 1 minute
const RATE_MAX = 240; // max requests per window (global)
const RATE_STRICT_MAX = 10; // for dangerous endpoints
const RATE_AUTH_MAX = 10; // password-verification endpoints (brute-force guard)

function rateLimit(scope: string, windowMs: number, max: number) {
  return (req: any, res: any, next: any) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `${scope}:${ip}`;
    const entry = rateBuckets.get(key);
    if (!entry || entry.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

// Clean up stale buckets every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) rateBuckets.delete(key);
  }
}, 120_000);

// Global rate limit
app.use(rateLimit('global', RATE_WINDOW, RATE_MAX));

// Dedicated brute-force guard for every endpoint that verifies a password.
// Separate scope so login attempts never consume the general API budget
// (and vice versa). 10 attempts/min is far above human usage.
const authLimiter = rateLimit('auth', RATE_WINDOW, RATE_AUTH_MAX);

// Providers unlock gets its OWN budget so lock-picking attempts can neither
// starve legit logins nor have their counting poisoned by them. The
// progressive cooldown below adds the real teeth on top of this.
const unlockLimiter = rateLimit('unlock', RATE_WINDOW, 15);

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
    service: 'Madar',
    version: '2.0.0-beta',
    timestamp: new Date().toISOString(),
  });
});

// ── Auth: setup / login / status / change-password ───────────
app.get('/api/auth/status', (req: any, res) => {
  const exists = hasUser();
  if (!exists) return res.json({ hasUser: false });
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = token && verifyToken(token) ? getUser() : null;
  res.json({ hasUser: true, user });
});

app.post('/api/auth/setup', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const result = setup(String(username), String(password));
    recordAudit('setup', true, req.ip);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (!verifyCredentials(String(username), String(password))) {
      recordAudit('login-failed', false, req.ip);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    // Correct password + 2FA enabled → do NOT issue a session yet. Hand back
    // a short-lived pending token that only the code-verify step accepts.
    if (isTotpEnabled()) {
      return res.json({ requires2fa: true, pendingToken: signPending2faToken() });
    }
    const result = issueSessionToken();
    recordAudit('login', true, req.ip);
    res.json(result);
  } catch (err: any) {
    recordAudit('login-failed', false, req.ip);
    res.status(401).json({ error: err.message });
  }
});

// Second login factor for 2FA accounts: exchange a pending token plus a
// valid authenticator code for a real session. Tight dedicated budget —
// 6-digit codes must never be guessable at speed.
const totpLimiter = rateLimit('totp', RATE_WINDOW, 8);

app.post('/api/auth/login/verify', totpLimiter, (req: any, res) => {
  const { pendingToken, code } = req.body || {};
  if (!isTotpEnabled() || !verifyPending2faToken(typeof pendingToken === 'string' ? pendingToken : null)) {
    return res.status(401).json({ error: 'Login session expired. Sign in again.' });
  }
  const user = getUser();
  if (!user || !verifyTotpCode(String(code || ''))) {
    recordAudit('login-2fa-failed', false, req.ip);
    return res.status(401).json({ error: 'Invalid authenticator code.' });
  }
  const result = issueSessionToken();
  recordAudit('login', true, req.ip);
  res.json(result);
});

// ── Auth middleware (protect everything below) ────────────────
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  authMiddleware(req, res, next);
});

// Security activity log for the authenticated owner.
app.get('/api/auth/audit', (req: any, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  res.json(listAudit(limit, offset));
});

// ── Two-factor authentication (TOTP) ──────────────────────────
app.get('/api/auth/2fa/status', (_req, res) => {
  res.json({ enabled: isTotpEnabled() });
});

// Enrollment step 1: generate a fresh pending secret. Safe to re-run while
// still unverified — it simply replaces the not-yet-enabled secret.
app.post('/api/auth/2fa/setup', authLimiter, (req: any, res) => {
  try {
    const { secret } = beginTotpSetup();
    const owner = getUser();
    res.json({ secret, uri: otpauthUri(secret, owner?.username || 'owner') });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Enrollment step 2: activate once the app proves it can produce valid codes.
app.post('/api/auth/2fa/enable', authLimiter, (req: any, res) => {
  const { code } = req.body || {};
  if (enableTotp(String(code || ''))) {
    recordAudit('2fa-enabled', true, req.ip);
    return res.json({ ok: true });
  }
  recordAudit('2fa-enabled-failed', false, req.ip);
  res.status(400).json({ error: 'Invalid authenticator code.' });
});

// Turning 2FA off is dangerous → account-password re-auth required.
app.post('/api/auth/2fa/disable', authLimiter, (req: any, res) => {
  const { accountPassword } = req.body || {};
  if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
  if (!verifyAccountPassword(String(accountPassword))) {
    recordAudit('2fa-disabled-failed', false, req.ip);
    return res.status(401).json({ error: 'Account password is incorrect.' });
  }
  disableTotp();
  recordAudit('2fa-disabled', true, req.ip);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', authLimiter, (req: any, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required.' });
    const { token } = changePassword(String(currentPassword), String(newPassword));
    recordAudit('password-change', true, req.ip);
    // Other sessions are revoked; the caller receives a fresh token to keep
    // its current session alive.
    res.json({ ok: true, token });
  } catch (err: any) {
    recordAudit('password-change-failed', false, req.ip);
    res.status(400).json({ error: err.message });
  }
});

// Logout everywhere: invalidate every issued session token.
app.post('/api/auth/logout-all', authLimiter, (req: any, res) => {
  try {
    const { accountPassword } = req.body || {};
    if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
    revokeAllSessions(String(accountPassword));
    recordAudit('logout-all', true, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    recordAudit('logout-all-failed', false, req.ip);
    res.status(err?.status || 400).json({ error: err.message });
  }
});

// ── Providers lock (optional second-layer password) ───────────

app.get('/api/providers-lock', (_req, res) => {
  res.json({ enabled: hasProvidersPassword() });
});

// Unlock verifies a password — brute-force guard (dedicated unlock limiter +
// progressive cooldown) + audit trail apply here.
app.post('/api/providers/unlock', unlockLimiter, (req: any, res) => {
  const ip = String(req.ip || 'unknown');
  const cd = unlockCooldownRemainingSec(ip);
  if (cd > 0) {
    res.set('Retry-After', String(cd));
    return res.status(429).json({ error: `Too many failed unlock attempts. Try again in ${Math.ceil(cd / 60)} minute(s).` });
  }
  const { password } = req.body || {};
  if (!hasProvidersPassword()) return res.json({ ok: true, unlocked: true });
  const result = issueUnlockToken(String(password || ''), String(req.user?.jti || ''));
  if (!result) {
    const st = unlockFails.get(ip) || { count: 0, until: 0 };
    st.count += 1;
    if (st.count >= UNLOCK_FAIL_LIMIT) {
      st.until = Date.now() + UNLOCK_COOLDOWN_MS;
      st.count = 0;
      recordAudit('providers-unlock-cooldown', false, req.ip);
    }
    unlockFails.set(ip, st);
    recordAudit('providers-unlock-failed', false, req.ip);
    return res.status(401).json({ error: 'Incorrect providers password.' });
  }
  unlockFails.delete(ip);
  recordAudit('providers-unlock', true, req.ip);
  res.json({ ok: true, unlockToken: result.unlockToken, expiresInSec: result.expiresInSec });
});

// "Lock now" — invalidate every outstanding unlock token across all
// tabs/devices. Main-JWT auth only; no password re-entry needed because
// locking is the defensive direction.
app.post('/api/providers/relock', (req: any, res) => {
  if (!hasProvidersPassword()) return res.json({ ok: true, locked: false });
  revokeProvidersUnlocks();
  recordAudit('providers-relock', true, req.ip);
  res.json({ ok: true, locked: true });
});

// Set or change the providers lock password — requires account re-auth.
// On success the response carries a ready-to-use unlock token so the
// current session does not get locked out of the page it just protected.
app.post('/api/auth/providers-password', authLimiter, (req: any, res) => {
  try {
    const { accountPassword, newPassword } = req.body || {};
    if (!accountPassword || !newPassword) {
      return res.status(400).json({ error: 'Account password and new providers password are required.' });
    }
    setProvidersPassword(String(accountPassword), String(newPassword));
    recordAudit('providers-lock-change', true, req.ip);
    const unlock = issueUnlockToken(String(newPassword), String(req.user?.jti || ''));
    res.json({
      ok: true,
      enabled: true,
      ...(unlock ? { unlockToken: unlock.unlockToken, expiresInSec: unlock.expiresInSec } : {}),
    });
  } catch (err: any) {
    recordAudit('providers-lock-change-failed', false, req.ip);
    res.status(err?.message?.includes('incorrect') ? 401 : 400).json({ error: err.message });
  }
});

// Remove the providers lock entirely — requires account re-auth.
app.delete('/api/auth/providers-password', authLimiter, (req: any, res) => {
  try {
    const { accountPassword } = req.body || {};
    if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
    removeProvidersPassword(String(accountPassword));
    recordAudit('providers-lock-change', true, req.ip);
    res.json({ ok: true, enabled: false });
  } catch (err: any) {
    recordAudit('providers-lock-change-failed', false, req.ip);
    res.status(err?.message?.includes('not enabled') ? 409 : 401).json({ error: err.message });
  }
});

// ── Settings backup (export / import) ─────────────────────────
// Both operations require account re-auth. Exports never contain API keys.

app.post('/api/settings/export', authLimiter, (req: any, res) => {
  const accountPassword = String((req.body?.accountPassword) || '');
  if (!verifyAccountPassword(accountPassword)) {
    return res.status(401).json({ error: 'Account password is incorrect.' });
  }
  try {
    recordAudit('backup-export', true, req.ip);
    const backup = buildBackup('2.0.0-beta');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="madar-backup-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json(backup);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/import', authLimiter, async (req: any, res) => {
  try {
    const { accountPassword, backup } = req.body || {};
    if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
    if (!verifyAccountPassword(String(accountPassword))) {
      return res.status(401).json({ error: 'Account password is incorrect.' });
    }
    const result = restoreFromBackup(backup);
    recordAudit('backup-import', true, req.ip);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

// ── Server info / networking ─────────────────────────────────
app.get('/api/server/info', (_req, res) => {
  const ips = detectIp();
  res.json({
    version: '2.0.0-beta',
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
  const providers = listProviders().map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: p.enabled }));
  res.json({ ...cfg, models, providers });
});

// Update chat configuration (provider / model / language / system prompt / temperature)
app.post('/api/chat/config', (req, res) => {
  try {
    const { provider, model, systemPrompt, language, temperature } = req.body || {};
    const patch: Partial<ChatConfig> = {};
    if (typeof provider === 'string' && provider.trim() && getProviderMeta(provider)) {
      patch.provider = provider;
    }
    if (typeof model === 'string' && model.trim()) patch.model = model.trim().slice(0, 200);
    if (typeof systemPrompt === 'string') patch.systemPrompt = systemPrompt.slice(0, 20000);
    if (language === 'auto' || language === 'ar' || language === 'en') patch.language = language;
    if (typeof temperature === 'number' && temperature >= 0 && temperature <= 2) patch.temperature = temperature;
    res.json(updateChatConfig(patch));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List models available from a provider (any configured provider id)
app.get('/api/chat/models', async (req, res) => {
  const requested = String(req.query.provider || '');
  const provider = requested && getProviderMeta(requested) ? requested : getChatConfig().provider;
  const models = await listModels(provider);
  res.json({ models });
});

// Preview the project-awareness context that will be injected into the model
app.get('/api/chat/context', async (req, res) => {
  const project = String(req.query.project || '').trim();
  if (!project) {
    return res.status(400).json({ error: 'Missing project query (use "all" or a project slug)' });
  }
  try {
    const ctx = project === 'all' ? await listProjectsBrief() : await getProjectContext(project);
    let indexStats;
    if (project !== 'all') {
      indexStats = getIndexStats(project);
      const query = String(req.query.query || '').trim();
      if (query) {
        const ret = await retrieveProject(project, query, 6);
        const block = formatRetrievedChunks(ret);
        if (block) ctx.text = capText(`${ctx.text}\n\n${block}`, 24000).text;
      }
    }
    res.json({ ...ctx, indexStats });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Chat sessions (per-project conversation history) ──────────
app.get('/api/chat/sessions', (_req, res) => {
  const project = String(_req.query.project || '').trim() || undefined;
  res.json({ sessions: listSessions(project) });
});

app.post('/api/chat/sessions', (req, res) => {
  const { name, project } = req.body || {};
  res.status(201).json({ session: createSession({ project, name }) });
});

app.put('/api/chat/sessions/:chatId', (req, res) => {
  const project = String(req.query.project || '').trim() || undefined;
  const name = String(req.body?.name || '').trim();
  const session = renameSession(project, req.params.chatId, name);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

app.delete('/api/chat/sessions/:chatId', (req, res) => {
  const project = String(req.query.project || '').trim() || undefined;
  if (!deleteSession(project, req.params.chatId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ ok: true });
});

// ── Providers (API key management, protected by authMiddleware) ──

// Optional second-layer lock: when a providers password is configured, all
// management endpoints require a short-lived scoped unlock token. Chat and
// agent LLM calls are server-side and unaffected.
function providersLockMiddleware(req: any, res: any, next: any) {
  if (!hasProvidersPassword()) return next();
  const token = String(req.headers['x-providers-unlock'] || '');
  // Unlock tokens are bound to the requesting session's jti — a stolen
  // token replayed from another session (or without one) is rejected.
  const sid = String(req.user?.jti || '');
  if (verifyUnlockToken(token, sid)) return next();
  res.status(403).json({ error: 'providers_locked' });
}

// Progressive brute-force cooldown for providers unlock failures:
// UNLOCK_FAIL_LIMIT consecutive wrong passwords from one IP triggers a
// silent-to-attacker cooldown window on top of the dedicated unlock limiter.
const UNLOCK_FAIL_LIMIT = 5;
const UNLOCK_COOLDOWN_MS = 15 * 60 * 1000;
const unlockFails = new Map<string, { count: number; until: number }>();

function unlockCooldownRemainingSec(ip: string): number {
  const st = unlockFails.get(ip);
  if (!st?.until) return 0;
  const remainMs = st.until - Date.now();
  if (remainMs <= 0) {
    unlockFails.delete(ip);
    return 0;
  }
  return Math.ceil(remainMs / 1000);
}

// Lightweight picker list for dropdowns (Agents modal etc.) — no secrets,
// stays reachable even when the providers lock is enabled.
app.get('/api/providers/options', (_req, res) => {
  const options = listProviders().map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: p.enabled }));
  res.json({ providers: options });
});

app.get('/api/providers/templates', (_req, res) => {
  res.json({ templates: KNOWN_TEMPLATES });
});

const providersManagement: Array<(req: any, res: any, next: any) => void> = [providersLockMiddleware];

app.get('/api/providers', providersManagement, (_req: any, res: any) => {
  res.json({ providers: listProviders() });
});

app.post('/api/providers/detect', providersManagement, async (req: any, res: any) => {
  try {
    const { apiKey, host } = req.body || {};
    const result = await detectProvider({ apiKey, host });
    res.json(result);
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.post('/api/providers', providersManagement, async (req: any, res: any) => {
  try {
    const { name, host, type, apiKey, enabled, auth } = req.body || {};
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';

    let finalHost = typeof host === 'string' ? host.trim() : '';
    let finalType = type;
    if (finalHost) {
      const dup = findDuplicateByKeyOrHost(key, finalHost, type);
      if (dup) {
        res.status(409).json({ error: `A provider with this ${key ? 'API key' : 'host'} already exists (${dup.name})` });
        return;
      }
    } else {
      // No host → detect everything from the API key in the background.
      const result = await detectProvider({ apiKey: key });
      if (!result.provider) {
        res.status(400).json({
          error: 'detection_required',
          message: 'Could not auto-detect a provider from this API key. Pick a template or enter the host manually.',
          tried: result.tried,
        });
        return;
      }
      const dup = findDuplicateByKeyOrHost(key);
      if (dup) {
        res.status(409).json({ error: `A provider with this API key already exists (${dup.name})` });
        return;
      }
      finalHost = result.provider.host;
      finalType = result.provider.type;
    }

    const provider = createProvider({ name, host: finalHost, type: finalType, apiKey: key, enabled, auth });
    res.status(201).json({ provider });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.put('/api/providers/:id', providersManagement, (req: any, res: any) => {
  try {
    const id = String(req.params.id || '');
    if (!getProviderMeta(id)) {
      res.status(404).json({ error: 'Unknown provider' });
      return;
    }
    const { name, host, apiKey, enabled, type, auth } = req.body || {};
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const dup = findDuplicateByKeyOrHost(apiKey.trim());
      if (dup && dup.id !== id) {
        res.status(409).json({ error: `A provider with this API key already exists (${dup.name})` });
        return;
      }
    }
    const provider = updateProvider(id, { name, host, apiKey, enabled, type, auth });
    res.json({ provider });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.delete('/api/providers/:id', providersManagement, (req: any, res: any) => {
  try {
    const id = String(req.params.id || '');
    deleteProvider(id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.post('/api/providers/:id/test', providersManagement, async (req: any, res: any) => {
  const id = String(req.params.id || '');
  if (!getProviderMeta(id)) {
    res.status(404).json({ error: 'Unknown provider' });
    return;
  }
  const cfg = getProviderConfig(id);
  const r = await checkProvider(cfg.type, cfg.host, cfg.apiKey, cfg.auth);
  res.json({ ok: r.ok, status: r.status, modelCount: r.modelCount, verified: r.verified, error: r.error });
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


// ── Agents API ────────────────────────────────────────────────
import {
  listAllAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  listAgentSessions,
  createAgentSession,
  deleteAgentSession,
  renameAgentSession,
} from './services/agent-store';

app.get('/api/agents', (_req, res) => {
  res.json({ agents: listAllAgents() });
});

app.post('/api/agents', (req, res) => {
  const body = req.body as any;
  const agent = createAgent({
    name: body.name,
    icon: body.icon,
    description: body.description,
    systemPrompt: body.systemPrompt,
    provider: body.provider,
    model: body.model,
  });
  res.json({ agent });
});

app.put('/api/agents/:id', (req, res) => {
  const agent = updateAgent(req.params.id, req.body as any);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ agent });
});

app.delete('/api/agents/:id', (req, res) => {
  if (!deleteAgent(req.params.id)) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ok: true });
});

app.get('/api/agents/:id/sessions', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ sessions: listAgentSessions(req.params.id) });
});

app.post('/api/agents/:id/sessions', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const session = createAgentSession(req.params.id, (req.body as any)?.name);
  res.json({ session });
});

app.delete('/api/agents/:id/sessions/:chatId', (req, res) => {
  if (!deleteAgentSession(req.params.id, req.params.chatId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ ok: true });
});

app.put('/api/agents/:id/sessions/:chatId', (req, res) => {
  const name = (req.body as any)?.name;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const session = renameAgentSession(req.params.id, req.params.chatId, name.trim());
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
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

// Project notes (ideas / bugs / goals) — read + full-document save
app.get('/api/projects/:slug/notes', (req, res) => {
  try {
    res.json(notes.loadNotes(req.params.slug));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
app.put('/api/projects/:slug/notes', (req, res) => {
  try {
    res.json(notes.saveNotes(req.params.slug, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
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

// Remove project — container, meta store AND workspace files from disk.
app.delete('/api/projects/:slug', rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req, res) => {
  try {
    await removeProject(req.params.slug);
    recordAudit('project-files-deleted', true, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Open a project in opencode (ensures registration + a session exists) so the
// opencode page's project picker can land the user on the right workspace.
app.post('/api/opencode/open', async (req, res) => {
  try {
    const slug = String(req.body?.slug || '');
    const info = await getProject(slug);
    if (!info) return res.status(404).json({ error: 'Project not found' });
    ensureOpencodeSession(slug);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Opencode Studio: subagents / skills / config CRUD + update ──────────

app.get('/api/opencode-studio/agents', (_req, res) => {
  res.json({ agents: studio.listAgents() });
});

app.get('/api/opencode-studio/agents/:name', (req, res) => {
  try {
    res.json(studio.getAgent(String(req.params.name)));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/agents/:name', (req, res) => {
  try {
    const content = String(req.body?.content ?? '');
    if (!content.trim()) return res.status(400).json({ error: 'Agent content is required' });
    studio.saveAgent(String(req.params.name), content);
    recordAudit('opencode-studio', true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/opencode-studio/agents/:name', (req, res) => {
  try {
    studio.deleteAgent(String(req.params.name));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/skills', (_req, res) => {
  res.json({ skills: studio.listSkills() });
});

app.get('/api/opencode-studio/skills/:name', (req, res) => {
  try {
    res.json(studio.getSkill(String(req.params.name)));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/skills/:name', (req, res) => {
  try {
    const content = String(req.body?.content ?? '');
    if (!content.trim()) return res.status(400).json({ error: 'Skill content is required' });
    studio.saveSkill(String(req.params.name), content);
    recordAudit('opencode-studio', true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/opencode-studio/skills/:name', (req, res) => {
  try {
    studio.deleteSkill(String(req.params.name));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/commands', (_req, res) => {
  res.json({ commands: studio.listCommands() });
});

app.get('/api/opencode-studio/commands/:name', (req, res) => {
  try {
    res.json(studio.getCommand(String(req.params.name)));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/commands/:name', (req, res) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    studio.saveCommand(String(req.params.name), content);
    recordAudit('opencode-studio', true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/opencode-studio/commands/:name', (req, res) => {
  try {
    studio.deleteCommand(String(req.params.name));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/config', (_req, res) => {
  res.json(studio.getConfig());
});

app.put('/api/opencode-studio/config', (req, res) => {
  try {
    res.json(studio.updateConfig(req.body));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/version', async (_req, res) => {
  try {
    res.json(await studio.getVersionInfo());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/update', async (_req, res) => {
  try {
    res.json(await studio.runUpdate());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

// Edit project metadata (name / description)
app.patch('/api/projects/:slug', async (req, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, description } = req.body || {};
    const meta = loadMeta(project.slug) || { activity: [] };
    if (typeof name === 'string' && name.trim()) meta.name = name.trim().slice(0, 100);
    if (typeof description === 'string') meta.description = description.trim().slice(0, 2000);
    meta.activity = [
      ...(meta.activity || []),
      { action: 'updated', at: new Date().toISOString() },
    ].slice(-200);
    saveMeta(project.slug, meta);
    res.json({ project: await getProject(project.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Recreate the container from stored meta (image / ports / env)
app.post('/api/projects/:slug/recreate', async (req, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const recreated = await recreateProject(project.slug);
    res.json({ project: recreated });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Set project environment variables (applied on recreate)
app.put('/api/projects/:slug/env', async (req, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rawEnv = (req.body || {}).env || {};
    const clean: Record<string, string> = {};
    if (typeof rawEnv === 'object' && rawEnv !== null) {
      for (const [k, v] of Object.entries(rawEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        if (typeof v === 'string' && v.length <= 4000) clean[k] = v;
      }
    }
    const meta = loadMeta(project.slug) || { activity: [] };
    meta.env = clean;
    meta.activity = [
      ...(meta.activity || []),
      { action: 'env_updated', at: new Date().toISOString() },
    ].slice(-200);
    saveMeta(project.slug, meta);
    res.json({ env: clean, needsRecreate: project.status === 'running' });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// git clone into the workspace
app.post('/api/projects/:slug/clone', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !String(url).trim()) {
      return res.status(400).json({ error: 'Git repository URL is required' });
    }
    const result = await cloneIntoWorkspace(req.params.slug, url);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Runtime stats (CPU / memory / uptime)
app.get('/api/projects/:slug/stats', async (req, res) => {
  try {
    res.json({ stats: await getProjectStats(req.params.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// HTTP health check for each published port
app.get('/api/projects/:slug/ports/check', async (req, res) => {
  try {
    res.json({ checks: await checkProjectPorts(req.params.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Project workspace files ───────────────────────────────────
app.get('/api/projects/:slug/files', (req, res) => {
  try {
    const listing = listWorkspaceFiles(req.params.slug, String(req.query.path || '').trim() || undefined);
    res.json(listing);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/projects/:slug/file', (req, res) => {
  try {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'Missing path query' });
    res.json(readWorkspaceFile(req.params.slug, rel));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/projects/:slug/file', (req, res) => {
  try {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'Missing path query' });
    res.json(deleteWorkspacePath(req.params.slug, rel));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Create or overwrite a text file in the workspace
app.put('/api/projects/:slug/file', (req, res) => {
  try {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'Missing path query' });
    const content = (req.body || {}).content;
    res.json(writeWorkspaceFile(req.params.slug, rel, typeof content === 'string' ? content : ''));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Rename/move a file or directory within the workspace
app.post('/api/projects/:slug/file/rename', (req, res) => {
  try {
    const from = String((req.body || {}).from || '').trim();
    const to = String((req.body || {}).to || '').trim();
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    res.json(renameWorkspacePath(req.params.slug, from, to));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── npm scripts ───────────────────────────────────────────────
app.get('/api/projects/:slug/scripts', (req, res) => {
  try {
    const base = path.resolve(WORKSPACES_ROOT, String(req.params.slug || '').trim());
    const pkgPath = path.join(base, 'package.json');
    if (!fs.existsSync(pkgPath)) return res.json({ scripts: {} });
    let pkg: any = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      /* invalid json — treat as no scripts */
    }
    res.json({ scripts: pkg?.scripts || {} });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:slug/scripts/run', rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req, res) => {
  try {
    const name = String((req.body || {}).script || '').trim();
    if (!/^[A-Za-z0-9:_-]{1,64}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid script name' });
    }
    res.json(await runProjectScript(req.params.slug, name));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/projects/:slug/subdir', (req, res) => {
  try {
    const info = resolveProjectSubdir(req.params.slug);
    res.json(info);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
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
  console.log(`[Madar] Serving frontend from ${frontendDist}`);
}

// ── Error handler ────────────────────────────────────────────
app.use((err: any, _req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[Madar] Unhandled error:', err?.stack || err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────
const server = http.createServer(app);
attachWebSockets(server);

server.listen(PORT, HOST, () => {
  console.log(`[Madar] Dashboard on http://${HOST}:${PORT}`);
  console.log(`[Madar] WebSocket hub on ws://${HOST}:${PORT}/ws`);
  console.log(`[Madar] Workspaces root: ${WORKSPACES_ROOT}`);
  console.log(`[Madar] opencode web on port ${OPENCODE_PORT}`);
  console.log(`[Madar] Chat model: ${getChatConfig().model}`);
  console.log(`[Madar] Docker socket: /var/run/docker.sock`);
});

// Automatic orphaned-workspace cleanup (boot + every WSD_JANITOR_INTERVAL_MS).
startJanitor();






