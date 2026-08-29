/**
 * project-context.ts
 * Madar — Deep "project awareness" block injected into the chat system prompt.
 *
 *   - project === 'all'  → brief summary of every project.
 *   - project === slug   → full context: metadata + WSD_PROJECT.md goals +
 *                          key/entry files + small source files (fully) +
 *                          code signatures + recent logs + workspace tree.
 *
 * Sections are priority-ordered (goals → key files → source files → signatures
 * → logs → tree) so a budget cap always keeps the most useful information.
 * A cheap full-scan signature cache avoids rebuilding when nothing changed.
 */
import fs from 'fs';
import path from 'path';
import { listProjects, getProject, projectLogs, WORKSPACES_ROOT, type ProjectInfo } from './docker-manager';
import { formatNotesForContext, noteCounts, notesSignature } from './project-notes';
import { formatCanvasForContext, canvasSignature as canvasSig } from './project-canvas';

export const DEFAULT_MAX_CHARS = 24000;
const BRIEF_MAX_CHARS = 4000;
const GOALS_MAX_CHARS = 4000;
const TREE_MAX_CHARS = 3000;
const SMALL_FILE_BYTES = 8 * 1024;
const KEY_FILE_MAX_BYTES = 64 * 1024;
const TREE_MAX_DEPTH = 6;
const TREE_MAX_ENTRIES = 400;
const MAX_SCAN_FILES = 2000;
const MAX_SCAN_DEPTH = 8;
const MAX_LOG_LINES = 60;

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'coverage',
  '.idea',
  '.vscode',
]);

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.mts', '.cts', '.py', '.pyw', '.go', '.java', '.kt', '.kts', '.rs', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.hh', '.cs', '.php', '.rb', '.html', '.htm', '.css',
  '.scss', '.less', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.csv', '.env', '.gitignore',
  '.dockerignore', '.editorconfig', '.log', '.vue', '.svelte', '.svg',
  '.tf', '.properties', '.plist', '.lock', 'dockerfile',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.bmp', '.pdf',
  '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.mp3', '.mp4', '.webm', '.mov', '.avi', '.wav', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.pyc', '.class', '.jar', '.wasm',
  '.map', '.db', '.sqlite', '.sqlite3', '.deb', '.rpm',
]);

const KEY_FILE_NAMES = [
  'README.md',
  'readme.md',
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  '.env.example',
  'Makefile',
  'CMakeLists.txt',
  'Dockerfile',
  'docker-compose.yml',
  '.gitignore',
];

const ENTRY_PATTERNS = [
  /^src\/index\.(ts|tsx|js|jsx)$/,
  /^src\/main\.(ts|tsx|js|jsx|py|go)$/,
  /^src\/app\.(tsx|jsx|ts|js)$/,
  /^index\.(ts|tsx|js|jsx)$/,
  /^main\.(ts|tsx|js|jsx|py|go)$/,
  /^app\.(tsx|jsx|ts|js)$/,
  /^server\.(ts|js)$/,
  /^manage\.py$/,
];

const CODE_SIG_PATTERNS: { exts: string[]; re: RegExp }[] = [
  {
    exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b[^;=]*$/gm,
  },
  { exts: ['py', 'pyw'], re: /^\s*(?:async\s+)?(?:def|class)\s+[\w_]+.*$/gm },
  { exts: ['go'], re: /^\s*(?:func|type)\s+[\w*(].*$/gm },
  {
    exts: ['java', 'kt', 'kts', 'scala'],
    re: /^\s*(?:(?:public|private|protected|internal)\s+)*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+\w+|^\s*(?:(?:public|private|protected)\s+)*(?:static\s+)?[\w<>,[\]\s]+\s+\w+\s*\([^)]*\)\s*(?:throws[\s\w]+)?\{?$/gm,
  },
  { exts: ['rs'], re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+[\w_]+.*$/gm },
  { exts: ['rb'], re: /^\s*(?:def|class|module)\s+[\w:]+.*$/gm },
  { exts: ['php'], re: /^\s*(?:public|private|protected|final|static|abstract)?\s*(?:function|class)\s+\w+.*$/gm },
  { exts: ['sh', 'bash', 'zsh', 'fish'], re: /^\s*[a-zA-Z_]\w*\s*\(\)\s*\{?\s*$/gm },
];

export interface ProjectContextResult {
  /** 'all' or a project slug. */
  slug: string;
  text: string;
  truncated: boolean;
}

interface ScannedFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  textLike: boolean;
  codeExt: string | null;
}

export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…(truncated, ${text.length} chars)`, truncated: true };
}

/** Resolve a project workspace dir safely (no path traversal outside root). */
export function safeWorkspaceDir(slug: string): string {
  const clean = String(slug).trim().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  if (!clean) throw new Error('Invalid project slug');
  const base = path.resolve(WORKSPACES_ROOT);
  const dir = path.resolve(base, clean);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error('Invalid project slug');
  return dir;
}

function textLike(ext: string, size: number): boolean {
  if (BINARY_EXTS.has(ext)) return false;
  if (TEXT_EXTS.has(ext)) return true;
  return size <= 64 * 1024;
}

function codeExtOf(ext: string): string | null {
  for (const p of CODE_SIG_PATTERNS) if (p.exts.includes(ext)) return ext;
  return null;
}

/** One full workspace scan (caps applied). Returns the text-like files. */
function scanWorkspace(dir: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  while (stack.length > 0 && out.length < MAX_SCAN_FILES) {
    const { rel, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_SCAN_FILES) break;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (depth < MAX_SCAN_DEPTH) stack.push({ rel: child, depth: depth + 1 });
      } else if (e.isFile()) {
        const abs = path.join(dir, child);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!textLike(ext, stat.size)) continue;
        out.push({
          rel: child,
          abs,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          textLike: true,
          codeExt: codeExtOf(ext),
        });
      }
    }
  }
  out.sort((a, b) => {
    const da = a.rel.split('/').length;
    const db = b.rel.split('/').length;
    return da - db || a.size - b.size || a.rel.localeCompare(b.rel);
  });
  return out;
}

/** Indented tree of the workspace, depth/entry capped, ignoring heavy dirs. */
function buildTree(base: string, rel: string, depth: number, budget: { count: number }): string[] {
  if (depth > TREE_MAX_DEPTH || budget.count <= 0) return [];
  const dir = rel ? path.join(base, rel) : base;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
  );
  const lines: string[] = [];
  for (const e of entries) {
    if (budget.count <= 0) return lines;
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const child = rel ? path.join(rel, e.name).split(path.sep).join('/') : e.name;
      lines.push(`${'  '.repeat(depth)}${e.name}/`);
      budget.count -= 1;
      lines.push(...buildTree(base, child, depth + 1, budget));
    } else {
      lines.push(`${'  '.repeat(depth)}${e.name}`);
      budget.count -= 1;
    }
  }
  return lines;
}

/** Extract declaration signatures from a code file (with line numbers). */
function extractSignatures(file: ScannedFile, maxLines: number): string[] {
  const codeExt = file.codeExt;
  if (!codeExt) return [];
  let content: string;
  try {
    content = fs.readFileSync(file.abs, 'utf8');
  } catch {
    return [];
  }
  const pattern = CODE_SIG_PATTERNS.find((p) => p.exts.includes(codeExt))!;
  const lines: string[] = [];
  const seen = new Set<string>();
  pattern.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.re.exec(content)) !== null && lines.length < maxLines) {
    const text = m[0].trim().slice(0, 140);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const lineNo = content.slice(0, m.index).split('\n').length;
    lines.push(`L${lineNo}: ${text}`);
    if (m[0].length === 0) pattern.re.lastIndex += 1;
  }
  return lines;
}

/** Brief summary of every project (for the 'all' scope). */
export async function listProjectsBrief(maxChars: number = BRIEF_MAX_CHARS): Promise<ProjectContextResult> {
  let projects: ProjectInfo[];
  try {
    projects = await listProjects();
  } catch {
    projects = [];
  }
  const lines = projects.map((p) => {
    const ports =
      p.hostPorts && Object.keys(p.hostPorts).length
        ? ` — preview ${Object.values(p.hostPorts).join(', ')}`
        : '';
    const desc = p.description ? ` — ${p.description}` : '';
    const counts = noteCounts(p.slug);
    const notes =
      counts && (counts.bugs > 0 || counts.goals > 0)
        ? ` — notes: ${counts.bugs} open bug(s), ${counts.goals} active goal(s)`
        : '';
    return `- ${p.name} [${p.slug}] — ${p.status}${desc}${ports}${notes}`;
  });
  const text = lines.length
    ? `[Project context — all projects]\n${lines.join('\n')}`
    : '[Project context — all projects]\n(no projects found yet)';
  const { text: cappedText, truncated } = capText(text, maxChars);
  return { slug: 'all', text: cappedText, truncated };
}

interface ContextCacheEntry {
  sig: string;
  text: string;
  truncated: boolean;
  at: number;
}

const ctxCache = new Map<string, ContextCacheEntry>();
const CTX_CACHE_MAX = 20;
const CTX_CACHE_TTL_MS = 60_000;

function computeSig(files: ScannedFile[]): string {
  const parts: string[] = [];
  for (const f of files) parts.push(`${f.rel}:${f.size}:${Math.round(f.mtimeMs)}`);
  return parts.join('|');
}

/** Cache key = workspace signature + notes signature + canvas signature, so
 * note/canvas edits invalidate the cached context. */
function cacheKey(slug: string, sig: string): string {
  return `${slug}::${sig}::${notesSignature(slug)}::${canvasSig(slug)}`;
}

/** Full context block for one project. */
export async function getProjectContext(
  slug: string,
  maxChars: number = DEFAULT_MAX_CHARS
): Promise<ProjectContextResult> {
  const clean = String(slug).trim();
  const dir = safeWorkspaceDir(clean);
  const exists = fs.existsSync(dir);

  // Developer notes survive workspace loss — always computed, shown either way.
  const notesText = formatNotesForContext(clean);
  const canvasText = formatCanvasForContext(clean);

  if (exists) {
    const files = scanWorkspace(dir);
    const sig = computeSig(files);
    const key = cacheKey(clean, sig);
    const now = Date.now();
    const cached = ctxCache.get(key);
    if (cached && now - cached.at < CTX_CACHE_TTL_MS) {
      return { slug: clean, text: cached.text, truncated: cached.truncated };
    }

    const info = await getProject(clean).catch(() => null);
    const built = await buildFullContext(clean, dir, files, info, maxChars);
    if (ctxCache.size >= CTX_CACHE_MAX) {
      const oldest = ctxCache.keys().next().value;
      if (oldest !== undefined) ctxCache.delete(oldest);
    }
    ctxCache.set(key, { sig, text: built.text, truncated: built.truncated, at: now });
    return { slug: clean, text: built.text, truncated: built.truncated };
  }

  return {
    slug: clean,
    text:
      `[Project context — ${clean}]\n(workspace not found on disk)` +
      (notesText ? `\n\n## Developer notes (from Madar Notes)\n${notesText}` : '') +
      (canvasText ? `\n\n${canvasText}` : ''),
    truncated: false,
  };
}

async function buildFullContext(
  clean: string,
  dir: string,
  files: ScannedFile[],
  info: ProjectInfo | null,
  maxChars: number
): Promise<{ text: string; truncated: boolean }> {
  const parts: string[] = [`[Project context — ${clean}]`];
  if (info) {
    parts.push(`Name: ${info.name}`);
    parts.push(`Status: ${info.status}`);
    if (info.description) parts.push(`Description: ${info.description}`);
    if (info.hostPorts && Object.keys(info.hostPorts).length) {
      parts.push(
        `Preview ports: ${Object.entries(info.hostPorts)
          .map(([priv, pub]) => `${pub} → container ${priv}`)
          .join(', ')}`
      );
    }
  } else {
    parts.push('(container metadata unavailable — workspace present on disk)');
  }

  // 1) Goals
  const goalsPath = path.join(dir, 'WSD_PROJECT.md');
  if (fs.existsSync(goalsPath)) {
    try {
      const goals = fs.readFileSync(goalsPath, 'utf8').slice(0, GOALS_MAX_CHARS);
      parts.push(`\n## Project goals (WSD_PROJECT.md)\n${goals || '(empty)'}`);
    } catch {
      /* unreadable goals file */
    }
  }

  // 1.5) Developer notes from the Madar Notes tab (open bugs → goals → ideas).
  const notesText = formatNotesForContext(clean);
  if (notesText) parts.push(`\n## Developer notes (from Madar Notes)\n${notesText}`);

  // 1.6) Visual planning canvas (sticky notes + task cards) — compact flat text.
  const canvasText = formatCanvasForContext(clean);
  if (canvasText) parts.push(`\n${canvasText}`);

  const byRel = new Map(files.map((f) => [f.rel, f]));

  // 2) Key + entry files (fully when small, otherwise head).
  const keySet = new Set<string>();
  const keyParts: string[] = [];
  const keyList: string[] = [];
  for (const name of KEY_FILE_NAMES) {
    if (byRel.has(name) || byRel.has(name.toLowerCase())) keyList.push(name);
  }
  for (const p of ENTRY_PATTERNS) {
    const found = files.find((f) => p.test(f.rel));
    if (found) keyList.push(found.rel);
  }
  for (const rel of [...new Set(keyList)]) {
    const f = byRel.get(rel) || byRel.get(rel.toLowerCase());
    if (!f || keySet.has(f.rel)) continue;
    keySet.add(f.rel);
    try {
      if (f.size > KEY_FILE_MAX_BYTES) continue;
      const content = fs.readFileSync(f.abs, 'utf8');
      const body = f.size <= SMALL_FILE_BYTES ? content : `${content.slice(0, 800)}\n…(file too large, showing head)`;
      keyParts.push(`\n## ${f.rel}\n${body.slice(0, 4000)}`);
    } catch {
      /* skip unreadable key file */
    }
  }
  if (keyParts.length) parts.push(`\n## Key files\n${keyParts.join('\n')}`);

  // 3) Small source files (fully), excluding key/goals already shown.
  const smallParts: string[] = [];
  for (const f of files) {
    if (keySet.has(f.rel) || f.rel === 'WSD_PROJECT.md') continue;
    if (f.size > SMALL_FILE_BYTES) continue;
    try {
      const content = fs.readFileSync(f.abs, 'utf8');
      smallParts.push(`\n### ${f.rel}\n${content}`);
    } catch {
      /* skip */
    }
  }
  if (smallParts.length) parts.push(`\n## Source files (small)\n${smallParts.join('\n')}`);

  // 4) Code signatures of larger files.
  const sigParts: string[] = [];
  for (const f of files) {
    if (f.size <= SMALL_FILE_BYTES || !f.codeExt || f.size > 256 * 1024) continue;
    const sigs = extractSignatures(f, 40);
    if (sigs.length) sigParts.push(`\n### ${f.rel}\n${sigs.join('\n')}`);
  }
  if (sigParts.length) parts.push(`\n## Code signatures\n${sigParts.join('\n')}`);

  // 5) Recent container logs when running.
  if (info?.status === 'running') {
    try {
      const logs = (await projectLogs(clean, MAX_LOG_LINES))
        .split('\n')
        .filter((l) => l.trim())
        .slice(-MAX_LOG_LINES)
        .join('\n');
      if (logs) parts.push(`\n## Recent logs\n${logs}`);
    } catch {
      /* logs unavailable */
    }
  }

  // 6) Workspace tree (capped).
  const budget = { count: TREE_MAX_ENTRIES };
  const tree = buildTree(dir, '', 0, budget);
  if (tree.length) {
    const treeText = capText(tree.join('\n'), TREE_MAX_CHARS).text;
    parts.push(`\n## Workspace layout\n${treeText}`);
  }

  const joined = parts.join('\n\n');
  const { text, truncated } = capText(joined, maxChars);
  return { text, truncated };
}
