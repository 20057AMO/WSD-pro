/**
 * ide-service.ts
 * WSD-Pro — Unified Web IDE (single code-server in the main container,
 * rooted at /workspaces, so it sees every project).
 * The dashboard shows its host port + password.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const IDE_PASSWORD_FILE = path.join(DATA_DIR, 'ide-password');

export interface IdeStatus {
  running: boolean;
  port: number;
  password: string;
}

export function getIdePassword(): string {
  const configured = process.env.WSD_IDE_PASSWORD;
  if (configured && configured.trim()) return configured.trim();
  try {
    if (fs.existsSync(IDE_PASSWORD_FILE)) {
      return fs.readFileSync(IDE_PASSWORD_FILE, 'utf8').trim();
    }
    const pwd = crypto.randomBytes(12).toString('base64url');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(IDE_PASSWORD_FILE, pwd, { mode: 0o600 });
    return pwd;
  } catch {
    return 'change-me';
  }
}

/**
 * Check whether code-server is up (it runs inside the same main container
 * on port 8080 — the dashboard host port is WSD_IDE_PORT).
 * Uses a plain TCP probe so auth/healthz behavior never matters.
 */
function isIdeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: 8080 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export async function getIdeStatus(): Promise<IdeStatus> {
  const running = await isIdeRunning();
  return {
    running,
    port: Number(process.env.WSD_IDE_PORT) || 8100,
    password: getIdePassword(),
  };
}
