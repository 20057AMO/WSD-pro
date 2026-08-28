import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Project templates — reusable "runtime recipes". A template bundles the
 * image, host ports and environment variables that a project should start
 * with, so a user can stand up the same stack repeatedly without re-typing
 * the config. Logical config only (no files): lives in data/templates.json.
 */

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'templates.json');

export interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  defaultName?: string;
  image?: string;
  ports: number[];
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type ProjectTemplateInput = Pick<ProjectTemplate, 'name'> &
  Partial<Omit<ProjectTemplate, 'id' | 'createdAt' | 'updatedAt'>>;

let templatesCache: ProjectTemplate[] | null = null;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTemplates(): ProjectTemplate[] {
  if (templatesCache) return templatesCache;
  ensureDataDir();
  if (fs.existsSync(STORE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      templatesCache = Array.isArray(raw) ? raw : [];
    } catch {
      /* corrupt file — start fresh; a copy is not worth quarantining (no secrets) */
      templatesCache = [];
    }
  } else {
    templatesCache = [];
    saveTemplates(templatesCache);
  }
  return templatesCache;
}

function saveTemplates(templates: ProjectTemplate[]): void {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(templates, null, 2), 'utf8');
  templatesCache = templates;
}

function genId(): string {
  return `template-${randomUUID().slice(0, 8)}`;
}

/** Same normalization as docker-manager's normalizeEnv (valid keys, ≤4000 chars). */
function normalizeEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object') return out;
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (typeof v === 'string' && v.length <= 4000) out[k] = v;
  }
  return out;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

/** Rejects the same port classes the project create path rejects. */
function cleanPorts(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Ports must be an array of integers');
  const PORT = Number(process.env.PORT) || 3000;
  const IDE_PORT = Number(process.env.WSD_IDE_PORT) || 8100;
  const OPENCODE_PORT = Number(process.env.WSD_OPENCODE_PORT) || 4096;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of value) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid port: ${raw} (must be 1024-65535)`);
    }
    if (port === PORT || port === IDE_PORT || port === OPENCODE_PORT) {
      throw new Error(`Port ${port} is reserved for the Madar dashboard/IDE/opencode services`);
    }
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(port);
  }
  return out;
}

function normalize(input: ProjectTemplateInput): Omit<ProjectTemplate, 'id' | 'createdAt' | 'updatedAt'> {
  const name = cleanText(input?.name, 100);
  if (!name) throw new Error('Template name is required');
  return {
    name,
    description: cleanText(input?.description, 500),
    defaultName: cleanText(input?.defaultName, 100),
    image: cleanText(input?.image, 200),
    ports: cleanPorts(input?.ports),
    env: normalizeEnv(input?.env),
  };
}

export function listTemplates(): ProjectTemplate[] {
  return loadTemplates();
}

export function getTemplate(id: string): ProjectTemplate | undefined {
  return loadTemplates().find((t) => t.id === id);
}

export function createTemplate(input: ProjectTemplateInput): ProjectTemplate {
  const templates = loadTemplates();
  const clean = normalize(input);
  const now = new Date().toISOString();
  const template: ProjectTemplate = { id: genId(), ...clean, createdAt: now, updatedAt: now };
  templates.push(template);
  saveTemplates(templates);
  return template;
}

export function updateTemplate(id: string, input: ProjectTemplateInput): ProjectTemplate | null {
  const templates = loadTemplates();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const current = templates[idx];
  const merged: ProjectTemplateInput = {
    name: input.name !== undefined ? input.name : current.name,
    description: input.description !== undefined ? input.description : current.description,
    defaultName: input.defaultName !== undefined ? input.defaultName : current.defaultName,
    image: input.image !== undefined ? input.image : current.image,
    ports: input.ports !== undefined ? input.ports : current.ports,
    env: input.env !== undefined ? input.env : current.env,
  };
  const clean = normalize(merged);
  templates[idx] = { ...current, ...clean, updatedAt: new Date().toISOString() };
  saveTemplates(templates);
  return templates[idx];
}

export function deleteTemplate(id: string): boolean {
  const templates = loadTemplates();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  templates.splice(idx, 1);
  saveTemplates(templates);
  return true;
}