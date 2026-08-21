import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'wsd-pro-default-secret-change-me';
const JWT_EXPIRY = '24h';
const BCRYPT_ROUNDS = 10;

interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

let cachedUser: StoredUser | null = null;

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
  fs.writeFileSync(USERS_FILE, JSON.stringify({ user: cachedUser }, null, 2));
}

export function hasUser(): boolean {
  if (cachedUser === null) loadUsers();
  return cachedUser !== null;
}

export function getUser(): { id: string; username: string; createdAt: string } | null {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) return null;
  return { id: cachedUser.id, username: cachedUser.username, createdAt: cachedUser.createdAt };
}

export function setup(username: string, password: string): { id: string; username: string; token: string } {
  if (hasUser()) throw new Error('User already exists. Cannot run setup again.');

  const cleanUsername = username.trim();
  if (!cleanUsername || cleanUsername.length < 2) throw new Error('Username must be at least 2 characters.');
  if (cleanUsername.length > 50) throw new Error('Username must be at most 50 characters.');
  if (!password || password.length < 4) throw new Error('Password must be at least 4 characters.');

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const id = `user-${Date.now()}`;

  cachedUser = {
    id,
    username: cleanUsername,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  saveUsers();

  const token = jwt.sign({ id, username: cleanUsername }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  return { id, username: cleanUsername, token };
}

export function login(username: string, password: string): { id: string; username: string; token: string } {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured. Run setup first.');

  const cleanUsername = username.trim();
  if (cleanUsername !== cachedUser.username) throw new Error('Invalid username or password.');
  if (!bcrypt.compareSync(password, cachedUser.passwordHash)) throw new Error('Invalid username or password.');

  const token = jwt.sign({ id: cachedUser.id, username: cachedUser.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  return { id: cachedUser.id, username: cachedUser.username, token };
}

export function verifyToken(token: string | null): { id: string; username: string } | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string };
    return { id: decoded.id, username: decoded.username };
  } catch {
    return null;
  }
}

export function changePassword(currentPassword: string, newPassword: string): void {
  if (cachedUser === null) loadUsers();
  if (!cachedUser) throw new Error('No user configured.');

  if (!bcrypt.compareSync(currentPassword, cachedUser.passwordHash)) {
    throw new Error('Current password is incorrect.');
  }

  if (!newPassword || newPassword.length < 4) {
    throw new Error('New password must be at least 4 characters.');
  }

  cachedUser.passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  saveUsers();
}
