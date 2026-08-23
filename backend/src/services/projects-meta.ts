/**
 * projects-meta.ts
 * WSD-Pro — Durable per-project metadata (description, image, ports, env,
 * activity history) stored as JSON under WSD_DATA_DIR/projects/<slug>/meta.json.
 * Docker labels are too limited for this (no description label, no update
 * endpoint for labels), so the meta store is the source of truth for anything
 * editable after creation.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');

export interface ActivityEntry {
  action: string;
  at: string;
}

export interface ProjectMeta {
  name?: string;
  description?: string;
  image?: string;
  ports?: number[];
  createdAt?: string;
  env?: Record<string, string>;
  activity: ActivityEntry[];
}

function metaFile(slug: string): string {
  return path.join(META_DIR, slug, 'meta.json');
}

export function loadMeta(slug: string): ProjectMeta | null {
  const file = metaFile(String(slug ?? ''));
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      return { activity: [], ...raw };
    }
  } catch {
    /* corrupt meta — treated as missing */
  }
  return null;
}

export function saveMeta(slug: string, meta: ProjectMeta): void {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '');
  if (!clean) return;
  fs.mkdirSync(path.dirname(metaFile(clean)), { recursive: true });
  fs.writeFileSync(metaFile(clean), JSON.stringify(meta, null, 2), 'utf8');
}

export function deleteMeta(slug: string): void {
  const dir = path.dirname(metaFile(String(slug ?? '')));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function touchActivity(slug: string, action: string): ProjectMeta | null {
  const clean = String(slug ?? '');
  const meta = loadMeta(clean) || { activity: [] };
  meta.activity = [...(meta.activity || []), { action, at: new Date().toISOString() }].slice(-200);
  saveMeta(clean, meta);
  return meta;
}
