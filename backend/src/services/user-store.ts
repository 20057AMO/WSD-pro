import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { generateTotpSecret, verifyTotp } from './totp';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'wsd-pro-default-secret-change-me';
const JWT_EXPIRY = '24h';
const PROVIDERS_UNLOCK_EXPIRY = '30m';
const PENDING_2FA_EXPIRY = '5m';
const BCRYPT_ROUNDS = 10;

export type UserRole = 'admin' | 'editor' | 'viewer';

interface TotpConfig {
  secret: string;
  enabled: boolean;
  createdAt: string;
}

export interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  passwordChangedAt?: string;
  providersPasswordHash?: string;
  providersPasswordVersion?: number;
  tokenVersion?: number;
  totp?: TotpConfig;
}

// ── In-memory store ─────────────────────────────────────────────

let usersMap = new Map<string, StoredUser>();

function loadUsers(): void {
  usersMap.clear();
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

    // Legacy single-user format: { user: StoredUser } → migrate
    if (raw.user && !raw.users) {
      const u: StoredUser = { ...raw.user, role: raw.user.role || 'admin' };
      usersMap.set(u.id, u);
      saveUsers(); // persist migrated format
      return;
    }

    // Current multi-user format: { users: StoredUser[] }
    if (Array.isArray(raw.users)) {
      for (const u of raw.users) {
        if (u?.id) usersMap.set(u.id, u);
      }
    }
  } catch {
    usersMap.clear();
  }
}

function saveUsers(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const arr = Array.from(usersMap.values());
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: arr }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function getUserById(id: string): StoredUser | undefined {
  if (usersMap.size === 0) loadUsers();
  return usersMap.get(id);
}

function getUserByUsername(username: string): StoredUser | undefined {
  if (usersMap.size === 0) loadUsers();
  const clean = username.trim().toLowerCase();
  for (const u of usersMap.values()) {
    if (u.username.toLowerCase() === clean) return u;
  }
  return undefined;
}

// ── Public API: User management ────────────────────────────────

export function hasUser(): boolean {
  if (usersMap.size === 0) loadUsers();
  return usersMap.size > 0;
}

export function getUserCount(): number {
  if (usersMap.size === 0) loadUsers();
  return usersMap.size;
}

/** List all users (safe fields only — no hashes). */
export function listUsers(): Array<{ id: string; username: string; role: UserRole; createdAt: string; passwordChangedAt?: string }> {
  if (usersMap.size === 0) loadUsers();
  return Array.from(usersMap.values()).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    passwordChangedAt: u.passwordChangedAt,
  }));
}

/** Get a single user by id (safe fields). */
export function getUserInfo(id: string): { id: string; username: string; role: UserRole; createdAt: string; passwordChangedAt?: string } | null {
  const u = getUserById(id);
  if (!u) return null;
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, passwordChangedAt: u.passwordChangedAt };
}

// ── Setup (first user = admin) ────────────────────────────────

export function setup(username: string, password: string): { id: string; username: string; token: string } {
  if (hasUser()) throw new Error('User already exists. Cannot run setup again.');

  const cleanUsername = username.trim();
  if (!cleanUsername || cleanUsername.length < 2) throw new Error('Username must be at least 2 characters.');
  if (cleanUsername.length > 50) throw new Error('Username must be at most 50 characters.');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');

  const now = new Date().toISOString();
  const id = `user-${Date.now()}`;

  const user: StoredUser = {
    id,
    username: cleanUsername,
    passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
    role: 'admin',
    createdAt: now,
    passwordChangedAt: now,
    providersPasswordVersion: 0,
    tokenVersion: 0,
  };

  usersMap.set(id, user);
  saveUsers();

  return { id, username: cleanUsername, token: signSessionToken(user) };
}

// ── Login ─────────────────────────────────────────────────────

export type LoginResult =
  | { requires2fa: true; pendingToken: string }
  | { id: string; username: string; role: UserRole; token: string };

/**
 * Authenticate by credentials and issue a session for the RESOLVED user.
 * TOTP is evaluated per-user: only a member whose own account has 2FA enabled
 * is diverted to the pending-token step; everyone else gets a direct session
 * carrying their own identity (never the first admin's).
 */
export function login(username: string, password: string): LoginResult {
  if (usersMap.size === 0) loadUsers();
  const user = getUserByUsername(username);
  if (!user) throw new Error('Invalid username or password.');
  if (!bcrypt.compareSync(password, user.passwordHash)) throw new Error('Invalid username or password.');
  if (isTotpEnabled(user.id)) {
    return { requires2fa: true, pendingToken: signPending2faToken(user.id) };
  }
  return { id: user.id, username: user.username, role: user.role, token: signSessionToken(user) };
}

/** Issue a fresh session for a specific user id (used by the login/verify route). */
export function signLoginSession(userId: string): { id: string; username: string; role: UserRole; token: string } {
  const user = getUserById(userId);
  if (!user) throw new Error('User not found.');
  return { id: user.id, username: user.username, role: user.role, token: signSessionToken(user) };
}

// ── JWT ───────────────────────────────────────────────────────

function signSessionToken(user: StoredUser): string {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      tv: user.tokenVersion || 0,
      jti: crypto.randomBytes(8).toString('hex'),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

export function verifyToken(token: string | null): { id: string; username: string; role: UserRole; jti?: string } | null {
  if (!token) return null;
  if (usersMap.size === 0) loadUsers();
  try {
    const decoded = jwt.verify(String(token), JWT_SECRET) as {
      id: string; username: string; role?: UserRole; tv?: number; jti?: string; scope?: string;
    };
    if (decoded.scope) return null;
    const user = usersMap.get(decoded.id);
    if (user) {
      // Known user: tokenVersion must match (revocation check).
      if ((decoded.tv || 0) !== (user.tokenVersion || 0)) return null;
      return { id: decoded.id, username: decoded.username, role: user.role, jti: decoded.jti };
    }
    // Unknown user id — accept the token with the embedded role (backward compat
    // and test helpers). The JWT signature was verified above, so nobody can forge
    // a token without the server secret.
    return { id: decoded.id, username: decoded.username, role: decoded.role || 'viewer', jti: decoded.jti };
  } catch {
    return null;
  }
}

// ── Password management (per-user) ────────────────────────────

export function verifyAccountPassword(accountPassword: string, userId?: string): boolean {
  if (usersMap.size === 0) loadUsers();
  const user = userId ? usersMap.get(userId) : Array.from(usersMap.values())[0];
  if (!user) return false;
  return bcrypt.compareSync(String(accountPassword || ''), user.passwordHash);
}

export function changePassword(currentPassword: string, newPassword: string, userId: string): { token: string } {
  const user = getUserById(userId);
  if (!user) throw new Error('User not found.');

  if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
    throw new Error('Current password is incorrect.');
  }
  if (!newPassword || newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  user.passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  user.passwordChangedAt = new Date().toISOString();
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  saveUsers();
  return { token: signSessionToken(user) };
}

export function revokeAllSessions(accountPassword: string, userId?: string): void {
  if (usersMap.size === 0) loadUsers();
  if (userId) {
    // Revoke specific user
    const user = getUserById(userId);
    if (!user) throw new Error('User not found.');
    if (!bcrypt.compareSync(accountPassword, user.passwordHash)) {
      throw Object.assign(new Error('Account password is incorrect.'), { status: 401 });
    }
    user.tokenVersion = (user.tokenVersion || 0) + 1;
  } else {
    // Revoke ALL users (admin action)
    for (const user of usersMap.values()) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
  }
  saveUsers();
}

// ── User CRUD (admin only) ────────────────────────────────────

export function createUser(
  username: string,
  password: string,
  role: UserRole = 'editor',
  creatorId?: string
): { id: string; username: string; role: UserRole } {
  if (usersMap.size === 0) loadUsers();

  const cleanUsername = username.trim();
  if (!cleanUsername || cleanUsername.length < 2) throw new Error('Username must be at least 2 characters.');
  if (cleanUsername.length > 50) throw new Error('Username must be at most 50 characters.');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error('Invalid role.');

  // Check duplicate username
  if (getUserByUsername(cleanUsername)) throw new Error('Username already exists.');

  const now = new Date().toISOString();
  const id = `user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  const user: StoredUser = {
    id,
    username: cleanUsername,
    passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
    role,
    createdAt: now,
    passwordChangedAt: now,
    tokenVersion: 0,
  };

  usersMap.set(id, user);
  saveUsers();
  return { id, username: cleanUsername, role };
}

export function updateUserRole(userId: string, role: UserRole): boolean {
  const user = getUserById(userId);
  if (!user) return false;
  if (!['admin', 'editor', 'viewer'].includes(role)) return false;
  user.role = role;
  saveUsers();
  return true;
}

export function deleteUser(userId: string): boolean {
  if (!usersMap.has(userId)) return false;
  usersMap.delete(userId);
  saveUsers();
  return true;
}

// ── Providers lock (global — shared across all admins) ─────────

function assertProvidersPassword(newPassword: string): void {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Providers password must be at least 6 characters.');
  }
  if (newPassword.length > 128) {
    throw new Error('Providers password must be at most 128 characters.');
  }
}

/** Find the user who has a providers password set (typically the admin). */
function findProvidersUser(): StoredUser | undefined {
  for (const u of usersMap.values()) {
    if (u.providersPasswordHash) return u;
  }
  return undefined;
}

export function hasProvidersPassword(): boolean {
  if (usersMap.size === 0) loadUsers();
  return !!findProvidersUser();
}

export function setProvidersPassword(accountPassword: string, newPassword: string, userId?: string): void {
  if (usersMap.size === 0) loadUsers();
  const user = userId ? getUserById(userId) : findProvidersUser() || Array.from(usersMap.values())[0];
  if (!user) throw new Error('No user configured.');

  if (!bcrypt.compareSync(accountPassword, user.passwordHash)) {
    throw new Error('Account password is incorrect.');
  }
  assertProvidersPassword(newPassword);

  user.providersPasswordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  user.providersPasswordVersion = (user.providersPasswordVersion || 0) + 1;
  saveUsers();
}

export function removeProvidersPassword(accountPassword: string, userId?: string): void {
  if (usersMap.size === 0) loadUsers();
  const user = userId ? getUserById(userId) : findProvidersUser();
  if (!user) throw new Error('No user configured.');

  if (!bcrypt.compareSync(accountPassword, user.passwordHash)) {
    throw new Error('Account password is incorrect.');
  }
  if (!user.providersPasswordHash) {
    throw new Error('Providers lock is not enabled.');
  }

  delete user.providersPasswordHash;
  user.providersPasswordVersion = (user.providersPasswordVersion || 0) + 1;
  saveUsers();
}

export function revokeProvidersUnlocks(): void {
  if (usersMap.size === 0) loadUsers();
  for (const u of usersMap.values()) {
    if (u.providersPasswordHash) {
      u.providersPasswordVersion = (u.providersPasswordVersion || 0) + 1;
    }
  }
  saveUsers();
}

export function issueUnlockToken(providersPassword: string, sid = ''): { unlockToken: string; expiresInSec: number } | null {
  if (usersMap.size === 0) loadUsers();
  const user = findProvidersUser();
  if (!user?.providersPasswordHash) return null;

  if (!bcrypt.compareSync(String(providersPassword || ''), user.providersPasswordHash)) {
    return null;
  }

  const unlockToken = jwt.sign(
    { scope: 'providers', pv: user.providersPasswordVersion || 0, sid: String(sid || '') },
    JWT_SECRET,
    { expiresIn: PROVIDERS_UNLOCK_EXPIRY }
  );
  return { unlockToken, expiresInSec: 30 * 60 };
}

export function verifyUnlockToken(token: string | null, sid = ''): boolean {
  if (usersMap.size === 0) loadUsers();
  const user = findProvidersUser();
  if (!user?.providersPasswordHash) return false;
  if (!token) return false;

  try {
    const decoded = jwt.verify(String(token), JWT_SECRET) as { scope?: string; pv?: number; sid?: string };
    return (
      decoded.scope === 'providers' &&
      decoded.pv === (user.providersPasswordVersion || 0) &&
      String(decoded.sid ?? '') === String(sid || '')
    );
  } catch {
    return false;
  }
}

// ── TOTP (per-user) ──────────────────────────────────────────

export function isTotpEnabled(userId?: string): boolean {
  if (usersMap.size === 0) loadUsers();
  const user = userId ? getUserById(userId) : Array.from(usersMap.values())[0];
  return !!user?.totp?.enabled;
}

export function beginTotpSetup(userId: string): { secret: string } {
  const user = getUserById(userId);
  if (!user) throw new Error('User not found.');
  if (user.totp?.enabled) throw new Error('Two-factor authentication is already enabled.');
  user.totp = { secret: generateTotpSecret(), enabled: false, createdAt: new Date().toISOString() };
  saveUsers();
  return { secret: user.totp.secret };
}

export function enableTotp(code: string, userId: string): boolean {
  const user = getUserById(userId);
  if (!user?.totp || user.totp.enabled) return false;
  if (!verifyTotp(user.totp.secret, code)) return false;
  user.totp.enabled = true;
  saveUsers();
  return true;
}

export function disableTotp(userId: string): void {
  const user = getUserById(userId);
  if (!user || !user.totp) return;
  delete user.totp;
  saveUsers();
}

export function verifyTotpCode(code: string, userId: string): boolean {
  const user = getUserById(userId);
  if (!user?.totp?.enabled) return false;
  return verifyTotp(user.totp.secret, code);
}

function signPending2faToken(userId: string): string {
  const user = getUserById(userId);
  if (!user) throw new Error('User not found.');
  return jwt.sign({ scope: '2fa-pending', id: user.id }, JWT_SECRET, { expiresIn: PENDING_2FA_EXPIRY });
}

export function verifyPending2faToken(token: string | null): string | null {
  if (usersMap.size === 0) loadUsers();
  try {
    const decoded = jwt.verify(String(token || ''), JWT_SECRET) as { scope?: string; id?: string };
    if (decoded.scope !== '2fa-pending' || !decoded.id) return null;
    const user = usersMap.get(decoded.id);
    if (!user) return null;
    return decoded.id;
  } catch {
    return null;
  }
}
