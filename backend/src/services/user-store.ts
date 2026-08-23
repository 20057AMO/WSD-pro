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

interface TotpConfig {
  secret: string;
  enabled: boolean;
  createdAt: string;
}

interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  passwordChangedAt?: string;
  /** Optional second-layer password guarding the Providers management page. */
  providersPasswordHash?: string;
  /** Bumped whenever the providers password changes; invalidates old unlock tokens. */
  providersPasswordVersion?: number;
  /**
   * Bumped to invalidate every issued login token (logout everywhere /
   * password change). Tokens carry a matching `tv` claim; legacy tokens
   * without the claim are treated as version 0.
   */
  tokenVersion?: number;
  /** TOTP authenticator state; present once setup has begun. */
  totp?: TotpConfig;
}

let cachedUser: StoredUser | null = null;

function currentTokenVersion(): number {
  return cachedUser?.tokenVersion || 0;
}

function signSessionToken(): string {
  if (!cachedUser) throw new Error('No user configured.');
  return jwt.sign(
    {
      id: cachedUser.id,
      username: cachedUser.username,
      tv: currentTokenVersion(),
      // Per-session identifier. Providers unlock tokens are bound to this
      // value, so a leaked unlock token is useless without its session.
      jti: crypto.randomBytes(8).toString('hex'),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function loadUsers(): void {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      cachedUser = data.user || null;
    }
  } catch {
    cachedUser = null;
  }
}

function saveUsers(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify({ user: cachedUser }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function hasUser(): boolean {
  if (cachedUser === null) loadUsers();
  return cachedUser !== null;
}

export function getUser(): { id: string; username: string; createdAt: string; passwordChangedAt?: string } | null {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) return null;
  return {
    id: cachedUser.id,
    username: cachedUser.username,
    createdAt: cachedUser.createdAt,
    passwordChangedAt: cachedUser.passwordChangedAt,
  };
}

export function setup(username: string, password: string): { id: string; username: string; token: string } {
  if (hasUser()) throw new Error('User already exists. Cannot run setup again.');

  const cleanUsername = username.trim();
  if (!cleanUsername || cleanUsername.length < 2) throw new Error('Username must be at least 2 characters.');
  if (cleanUsername.length > 50) throw new Error('Username must be at most 50 characters.');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');

  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const id = `user-${Date.now()}`;

  cachedUser = {
    id,
    username: cleanUsername,
    passwordHash,
    createdAt: now,
    passwordChangedAt: now,
    providersPasswordVersion: 0,
    tokenVersion: 0,
  };

  saveUsers();

  return { id, username: cleanUsername, token: signSessionToken() };
}

export function login(username: string, password: string): { id: string; username: string; token: string } {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured. Run setup first.');

  const cleanUsername = username.trim();
  if (cleanUsername !== cachedUser.username) throw new Error('Invalid username or password.');
  if (!bcrypt.compareSync(password, cachedUser.passwordHash)) throw new Error('Invalid username or password.');

  return { id: cachedUser.id, username: cachedUser.username, token: signSessionToken() };
}

/** Credential check without issuing anything — lets the login route branch into the TOTP step. */
export function verifyCredentials(username: string, password: string): boolean {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) return false;
  const cleanUsername = String(username || '').trim();
  if (cleanUsername !== cachedUser.username) return false;
  return bcrypt.compareSync(String(password || ''), cachedUser.passwordHash);
}

/** Issue a full session token (after credentials + any second factor). */
export function issueSessionToken(): { id: string; username: string; token: string } {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured. Run setup first.');
  return { id: cachedUser.id, username: cachedUser.username, token: signSessionToken() };
}

export function verifyToken(token: string | null): { id: string; username: string; jti?: string } | null {
  if (cachedUser === null) loadUsers();
  if (!token) return null;
  try {
    const decoded = jwt.verify(String(token), JWT_SECRET) as {
      id: string; username: string; tv?: number; jti?: string; scope?: string;
    };
    // Scoped auxiliary tokens (providers unlock, 2FA pending) are NOT
    // sessions — they must never authenticate generic routes even though
    // they are signed with the same secret.
    if (decoded.scope) return null;
    // Tokens issued before a revocation carry a stale version → rejected.
    if ((decoded.tv || 0) !== currentTokenVersion()) return null;
    return { id: decoded.id, username: decoded.username, jti: decoded.jti };
  } catch {
    return null;
  }
}

/** Re-authenticate with the account password (used to authorize sensitive ops). */
export function verifyAccountPassword(accountPassword: string): boolean {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) return false;
  return bcrypt.compareSync(String(accountPassword || ''), cachedUser.passwordHash);
}

/**
 * Change the account password. Security best practice: bump the token
 * version so every OTHER session is invalidated, then return a fresh
 * token so the current session stays signed in.
 */
export function changePassword(currentPassword: string, newPassword: string): { token: string } {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured.');

  if (!bcrypt.compareSync(currentPassword, cachedUser.passwordHash)) {
    throw new Error('Current password is incorrect.');
  }

  if (!newPassword || newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  cachedUser.passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  cachedUser.passwordChangedAt = new Date().toISOString();
  cachedUser.tokenVersion = currentTokenVersion() + 1;
  saveUsers();
  return { token: signSessionToken() };
}

/**
 * Invalidate every issued session token (logout everywhere).
 * Requires account-password re-auth. Returns nothing; callers must re-login.
 */
export function revokeAllSessions(accountPassword: string): void {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured.');
  if (!verifyAccountPassword(accountPassword)) {
    throw Object.assign(new Error('Account password is incorrect.'), { status: 401 });
  }
  cachedUser.tokenVersion = currentTokenVersion() + 1;
  saveUsers();
}

// ── Providers lock (optional second-layer password) ───────────

function assertProvidersPassword(newPassword: string): void {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Providers password must be at least 6 characters.');
  }
  if (newPassword.length > 128) {
    throw new Error('Providers password must be at most 128 characters.');
  }
}

export function hasProvidersPassword(): boolean {
  if (cachedUser === null) loadUsers();
  return Boolean(cachedUser?.providersPasswordHash);
}

/**
 * Set or change the Providers lock password.
 * Always requires re-verification of the account password first.
 */
export function setProvidersPassword(accountPassword: string, newPassword: string): void {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured.');

  if (!verifyAccountPassword(accountPassword)) {
    throw new Error('Account password is incorrect.');
  }
  assertProvidersPassword(newPassword);

  cachedUser.providersPasswordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  cachedUser.providersPasswordVersion = (cachedUser.providersPasswordVersion || 0) + 1;
  saveUsers();
}

/** Disable the Providers lock entirely. Requires account password verification. */
export function removeProvidersPassword(accountPassword: string): void {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured.');

  if (!verifyAccountPassword(accountPassword)) {
    throw new Error('Account password is incorrect.');
  }
  if (!cachedUser.providersPasswordHash) {
    throw new Error('Providers lock is not enabled.');
  }

  delete cachedUser.providersPasswordHash;
  cachedUser.providersPasswordVersion = (cachedUser.providersPasswordVersion || 0) + 1;
  saveUsers();
}

/**
 * Invalidate every outstanding unlock token WITHOUT touching the stored
 * providers password ("Lock now" across all tabs/devices).
 */
export function revokeProvidersUnlocks(): void {
  if (cachedUser === null) loadUsers();
  if (!cachedUser?.providersPasswordHash) return;
  cachedUser.providersPasswordVersion = (cachedUser.providersPasswordVersion || 0) + 1;
  saveUsers();
}

/**
 * Verify a providers-lock password and issue a short-lived scoped unlock
 * token. The token carries the current password version so changing or
 * removing the lock instantly invalidates every previously issued token,
 * plus the requesting session's `jti` so a stolen unlock token cannot be
 * replayed from a different session. Legacy sessions without a jti use ''
 * consistently on both sides, keeping them fully compatible.
 */
export function issueUnlockToken(
  providersPassword: string,
  sid = ''
): { unlockToken: string; expiresInSec: number } | null {
  if (cachedUser === null) loadUsers();
  if (!cachedUser?.providersPasswordHash) return null;

  if (!bcrypt.compareSync(String(providersPassword || ''), cachedUser.providersPasswordHash)) {
    return null;
  }

  const unlockToken = jwt.sign(
    { scope: 'providers', pv: cachedUser.providersPasswordVersion || 0, sid: String(sid || '') },
    JWT_SECRET,
    { expiresIn: PROVIDERS_UNLOCK_EXPIRY }
  );
  // 30 minutes in seconds — keep in sync with PROVIDERS_UNLOCK_EXPIRY
  return { unlockToken, expiresInSec: 30 * 60 };
}

export function verifyUnlockToken(token: string | null, sid = ''): boolean {
  if (cachedUser === null) loadUsers();
  if (!cachedUser?.providersPasswordHash) return false;
  if (!token) return false;

  try {
    const decoded = jwt.verify(String(token), JWT_SECRET) as { scope?: string; pv?: number; sid?: string };
    return (
      decoded.scope === 'providers' &&
      decoded.pv === (cachedUser.providersPasswordVersion || 0) &&
      String(decoded.sid ?? '') === String(sid || '')
    );
  } catch {
    return false;
  }
}

// ── TOTP two-factor authentication ─────────────────────────────

export function isTotpEnabled(): boolean {
  if (cachedUser === null) loadUsers();
  return !!cachedUser?.totp?.enabled;
}

/**
 * Begin 2FA enrollment: generate a fresh secret in the disabled state.
 * Re-running setup before enabling simply replaces the pending secret.
 * Refuses when 2FA is already enabled — disable it first.
 */
export function beginTotpSetup(): { secret: string } {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured.');
  if (cachedUser.totp?.enabled) throw new Error('Two-factor authentication is already enabled.');
  cachedUser.totp = { secret: generateTotpSecret(), enabled: false, createdAt: new Date().toISOString() };
  saveUsers();
  return { secret: cachedUser.totp.secret };
}

/** Activate the pending secret once the user proves they can generate valid codes. */
export function enableTotp(code: string): boolean {
  if (cachedUser === null) loadUsers();
  if (!cachedUser?.totp || cachedUser.totp.enabled) return false;
  if (!verifyTotp(cachedUser.totp.secret, code)) return false;
  cachedUser.totp.enabled = true;
  saveUsers();
  return true;
}

export function disableTotp(): void {
  if (cachedUser === null) loadUsers();
  if (!cachedUser || !cachedUser.totp) return;
  delete cachedUser.totp;
  saveUsers();
}

/** Check an authenticator code against the ENABLED secret — no state change. */
export function verifyTotpCode(code: string): boolean {
  if (cachedUser === null) loadUsers();
  if (!cachedUser?.totp?.enabled) return false;
  return verifyTotp(cachedUser.totp.secret, code);
}

/**
 * Short-lived token proving the PASSWORD step of a 2FA login succeeded —
 * never a session token. Exchanged for a real session only after the
 * authenticator code is verified by /api/auth/login/verify.
 */
export function signPending2faToken(): string {
  if (!cachedUser) throw new Error('No user configured.');
  return jwt.sign({ scope: '2fa-pending', id: cachedUser.id }, JWT_SECRET, { expiresIn: PENDING_2FA_EXPIRY });
}

export function verifyPending2faToken(token: string | null): boolean {
  if (cachedUser === null) loadUsers();
  try {
    const decoded = jwt.verify(String(token || ''), JWT_SECRET) as { scope?: string; id?: string };
    return decoded.scope === '2fa-pending' && !!decoded.id && decoded.id === cachedUser?.id;
  } catch {
    return false;
  }
}

