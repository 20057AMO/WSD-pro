/**
 * auth.ts
 * WSD-Pro — Simple local admin auth (JWT + bcrypt).
 * First-run: admin account is created from env vars if none exists.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt-secret');
const JWT_EXPIRES = '7d';

/**
 * Resolve the JWT signing secret.
 * Priority: env WSD_JWT_SECRET → persisted random secret (data/jwt-secret).
 * A random secret is generated once and reused, so tokens survive restarts
 * without shipping any hardcoded fallback.
 */
function getJwtSecret(): string {
  if (process.env.WSD_JWT_SECRET) return process.env.WSD_JWT_SECRET;
  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    }
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    console.warn('[WSD-Pro] Generated random JWT secret (stored in data/jwt-secret). Set WSD_JWT_SECRET to control it.');
    return secret;
  } catch (err: any) {
    console.error('[WSD-Pro] Could not persist JWT secret, falling back to random per-boot secret:', err.message);
    return crypto.randomBytes(32).toString('hex');
  }
}

const JWT_SECRET = getJwtSecret();

interface StoredUser {
  username: string;
  passwordHash: string;
  role: 'admin';
  createdAt: string;
}

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readUsers(): StoredUser[] {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) as StoredUser[];
  } catch {
    return [];
  }
}

function writeUsers(users: StoredUser[]): void {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

/**
 * Ensure the admin account exists (created from env or with a generated
 * password on first boot).
 */
export async function ensureAdmin(): Promise<void> {
  const users = readUsers();
  if (users.length > 0) return;

  const username = (process.env.WSD_ADMIN_USER || 'admin').trim();
  let password = process.env.WSD_ADMIN_PASSWORD || '';
  if (!password) {
    password = crypto.randomBytes(6).toString('base64url');
    console.log(`[WSD-Pro] Generated admin password for '${username}': ${password} (set WSD_ADMIN_PASSWORD to control it)`);
  } else {
    console.log(`[WSD-Pro] Admin '${username}' created from env (WSD_ADMIN_PASSWORD)`);
  }
  const passwordHash = await bcrypt.hash(password, 10);

  writeUsers([{ username, passwordHash, role: 'admin', createdAt: new Date().toISOString() }]);
}

/* ── Login rate limiting (in-memory, per IP) ─────────────────── */

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; firstAt: number }>();

function garbageCollectAttempts(): void {
  const now = Date.now();
  for (const [key, v] of attempts) {
    if (now - v.firstAt > LOGIN_WINDOW_MS) attempts.delete(key);
  }
}

function getClientIp(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded.length > 0) return String(forwarded[0]).trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Express middleware: 429 after too many login attempts from one IP. */
export function loginRateLimit(req: any, res: any, next: any): void {
  const ip = getClientIp(req);
  const now = Date.now();
  garbageCollectAttempts();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now });
    return next();
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    const retryIn = Math.ceil((LOGIN_WINDOW_MS - (now - entry.firstAt)) / 1000);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${retryIn}s.` });
  }
  next();
}

/** Reset the attempt counter after a successful login. */
export function resetLoginAttempts(ip: string): void {
  attempts.delete(ip);
}

/**
 * Verify credentials, return a signed JWT on success.
 */
export async function login(
  username: string,
  password: string
): Promise<{ token: string; username: string; role: string } | null> {
  const users = readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return null;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  const token = jwt.sign({ sub: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });
  return { token, username: user.username, role: user.role };
}

/**
 * Verify a JWT (middleware helper).
 */
export function verifyToken(token: string): { sub: string; role: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; role: string };
    return decoded;
  } catch {
    return null;
  }
}

/** Express middleware: require valid Bearer token. */
export function requireAuth(req: any, res: any, next: any): void {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = payload;
  next();
}
