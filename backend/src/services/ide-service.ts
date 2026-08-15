/**
 * ide-service.ts
 * WSD-Pro — Unified Web IDE (single code-server in the main container,
 * rooted at /workspaces, so it sees every project).
 * The dashboard shows its host port + password.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
 */
async function isIdeRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:8080/healthz', {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getIdeStatus(): Promise<IdeStatus> {
  const [running] = await Promise.all([isIdeRunning()]);
  return {
    running,
    port: Number(process.env.WSD_IDE_PORT) || 8100,
    password: getIdePassword(),
  };
}
