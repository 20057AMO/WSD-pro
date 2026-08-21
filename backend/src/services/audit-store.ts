/**
 * audit-store.ts
 * Append-only security activity log (data/audit.json).
 * Records auth-sensitive events so the owner can review recent account
 * activity from Settings. Capped at the most recent 100 entries.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const MAX_ENTRIES = 100;

export type AuditEvent =
  | 'setup'
  | 'login'
  | 'login-failed'
  | 'logout-all'
  | 'logout-all-failed'
  | 'password-change'
  | 'password-change-failed'
  | 'providers-lock-change'
  | 'providers-lock-change-failed'
  | 'backup-export'
  | 'backup-import';

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  ok: boolean;
  ip?: string;
}

function loadEntries(): AuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Record an event; failures to persist are non-fatal by design. */
export function recordAudit(event: AuditEvent, ok: boolean, ip?: string): void {
  try {
    const entries = loadEntries();
    entries.push({ ts: new Date().toISOString(), event, ok, ...(ip ? { ip } : {}) });
    const trimmed = entries.slice(-MAX_ENTRIES);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch {
    /* auditing must never break the request flow */
  }
}

/** Most recent entries first. */
export function listAudit(limit = 50): AuditEntry[] {
  return loadEntries().slice(-Math.min(Math.max(limit, 1), MAX_ENTRIES)).reverse();
}
