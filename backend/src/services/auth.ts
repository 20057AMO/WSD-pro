/**
 * auth.ts
 * WSD-Pro — Simple local admin auth (JWT + bcrypt).
 * First-run: admin account is created from env vars if none exists.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.WSD_JWT_SECRET || 'wsd-pro-dev-secret-change-me';
const JWT_EXPIRES = '7d';

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
 * Ensure the admin account exists (created from env on first boot).
 */
export async function ensureAdmin(): Promise<void> {
  const users = readUsers();
  if (users.length > 0) return;

  const username = process.env.WSD_ADMIN_USER || 'admin';
  const password = process.env.WSD_ADMIN_PASSWORD || 'admin1234';
  const passwordHash = await bcrypt.hash(password, 10);

  writeUsers([{ username, passwordHash, role: 'admin', createdAt: new Date().toISOString() }]);
  console.log(`[WSD-Pro] Created default admin: ${username} / ${password} (CHANGE ME!)`);
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
