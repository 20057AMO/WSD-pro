/**
 * project-canvas.ts
 * Madar — Per-project visual planning canvas stored as JSON under
 * WSD_DATA_DIR/projects/<slug>/canvas.json, next to notes.json.
 *
 * The document is intentionally dumb and portable:
 *   nodes: sticky notes ("note") and task cards ("card") at absolute
 *          world coordinates, plus edges: arrows between node ids.
 * The frontend renders pan/zoom/drag on top of this "camera-free" document,
 * so the whole canvas ships as a plain JSON payload (no transforms saved).
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');

export type CanvasNodeType = 'note' | 'card';
export type CanvasColor = 'yellow' | 'blue' | 'red' | 'green';

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: CanvasColor;
  done?: boolean;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface ProjectCanvas {
  version: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  updatedAt: string | null;
}

export const MAX_NODES = 200;
export const MAX_EDGES = 400;
export const MAX_TEXT = 2000;

const COLORS: CanvasColor[] = ['yellow', 'blue', 'red', 'green'];

function canvasFile(slug: unknown): string {
  return path.join(META_DIR, cleanSlug(slug), 'canvas.json');
}

function cleanSlug(slug: unknown): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  if (!clean) throw new Error('Invalid project slug');
  return clean;
}

function clampNum(v: unknown, floor: number, ceil: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.max(floor, Math.min(ceil, n));
}

function nodeId(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(raw) ? raw : fallback;
}

function freshId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type: CanvasNodeType = r.type === 'card' ? 'card' : 'note';
  return {
    id: nodeId(r.id, freshId('n')),
    type,
    text: typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '',
    x: clampNum(r.x, -100_000, 100_000, 0),
    y: clampNum(r.y, -100_000, 100_000, 0),
    w: clampNum(r.w, 60, 900, 220),
    h: clampNum(r.h, 40, 900, type === 'card' ? 120 : 100),
    color: COLORS.includes(r.color as CanvasColor) ? (r.color as CanvasColor) : 'yellow',
    done: r.done === true,
  };
}

function normalizeEdge(raw: unknown, ids: Set<string>): CanvasEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = typeof r.from === 'string' ? r.from : '';
  const to = typeof r.to === 'string' ? r.to : '';
  if (!ids.has(from) || !ids.has(to) || from === to) return null;
  return { id: nodeId(r.id, freshId('e')), from, to };
}

function emptyCanvas(): ProjectCanvas {
  return { version: 1, nodes: [], edges: [], updatedAt: null };
}

export function loadCanvas(slug: unknown): ProjectCanvas {
  const file = canvasFile(slug);
  if (!fs.existsSync(file)) return emptyCanvas();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawNodes = Array.isArray(raw?.nodes) ? (raw.nodes as unknown[]) : [];
    const rawEdges = Array.isArray(raw?.edges) ? (raw.edges as unknown[]) : [];
    const nodes: CanvasNode[] = [];
    for (const n of rawNodes) {
      if (nodes.length >= MAX_NODES) break;
      const node = normalizeNode(n);
      if (node) nodes.push(node);
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges: CanvasEdge[] = [];
    for (const e of rawEdges) {
      if (edges.length >= MAX_EDGES) break;
      const edge = normalizeEdge(e, ids);
      if (edge) edges.push(edge);
    }
    return {
      version: 1,
      nodes,
      edges,
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch {
    /* corrupt canvas — treat as empty */
    return emptyCanvas();
  }
}

export function saveCanvas(slug: unknown, input: unknown): ProjectCanvas {
  const clean = cleanSlug(slug);
  if (!input || typeof input !== 'object') {
    throw new Error('Body must be { nodes: [...], edges: [...] }');
  }
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) {
    throw new Error('Body must be { nodes: [...], edges: [...] }');
  }
  const rawNodes = r.nodes as unknown[];
  const rawEdges = r.edges as unknown[];
  if (rawNodes.length > MAX_NODES) throw new Error(`Too many canvas nodes (max ${MAX_NODES})`);
  if (rawEdges.length > MAX_EDGES) throw new Error(`Too many canvas edges (max ${MAX_EDGES})`);
  const nodes: CanvasNode[] = [];
  for (const raw of rawNodes) {
    const n = normalizeNode(raw);
    if (n) nodes.push(n);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  for (const raw of rawEdges) {
    const e = normalizeEdge(raw, ids);
    if (e) edges.push(e);
  }
  const doc: ProjectCanvas = { version: 1, nodes, edges, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(canvasFile(clean)), { recursive: true });
  fs.writeFileSync(canvasFile(clean), JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

/** Cheap change-detector for the context cache: mtime+size of canvas.json. */
export function canvasSignature(slug: unknown): string {
  const file = canvasFile(String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64));
  try {
    const st = fs.statSync(file);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return '';
  }
}

/** Node-count for the 'all' project brief (no canvas / empty board → 0). */
export function canvasNodeCount(slug: unknown): number {
  try {
    return loadCanvas(slug).nodes.length;
  } catch {
    return 0;
  }
}

/**
 * Compact planning-canvas summary for the AI context block — flat text of
 * every sticky note + task card, done cards counted. Empty canvases return ''.
 */
export function formatCanvasForContext(slug: unknown, maxChars: number = 1500): string {
  const { nodes } = loadCanvas(slug);
  const withText = nodes.filter((n) => n.text.trim());
  if (!withText.length) return '';
  const lines = withText.map(
    (n) => `- [${n.type === 'card' ? (n.done ? 'done' : 'task') : 'note'}] ${n.text.trim()}`
  );
  const doneCount = nodes.filter((n) => n.type === 'card' && n.done).length;
  let text = `[Planning canvas]\n${lines.join('\n')}`;
  if (doneCount > 0) text += `\n(${doneCount} completed card(s))`;
  text = text.slice(0, maxChars).trimEnd();
  return `${text}\n`;
}