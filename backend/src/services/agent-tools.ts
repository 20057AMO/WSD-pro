import fs from 'fs';
import path from 'path';
import { execSync, type ExecSyncOptions } from 'child_process';
import { WORKSPACES_ROOT } from './docker-manager';

const MAX_OUTPUT = 50000;
const EXEC_TIMEOUT = 30000;
const MAX_FILE_READ = 200000;
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.cache', '__pycache__', '.venv', 'venv', 'target', 'coverage',
]);

function safeSlug(slug: string): string {
  return String(slug).replace(/[^a-z0-9._-]+/gi, '').slice(0, 32);
}

function safePath(slug: string, rel: string): string | null {
  const clean = safeSlug(slug);
  const base = path.resolve(WORKSPACES_ROOT, clean);
  if (!fs.existsSync(base)) return null;

  const relClean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relClean || relClean === '.') return base;

  const normalized = path.posix.normalize(relClean);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;

  const target = path.resolve(base, normalized);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export function readFile(slug: string, rel: string): string {
  const target = safePath(slug, rel);
  if (!target || !fs.existsSync(target)) return `[File not found: ${rel}]`;
  const buf = fs.readFileSync(target);
  if (buf.length > 0 && buf.subarray(0, 8192).includes(0)) return `[Binary file: ${rel}]`;
  let text = buf.toString('utf8');
  if (text.length > MAX_FILE_READ) text = text.slice(0, MAX_FILE_READ) + '\n…(truncated)';
  return text;
}

export function writeFile(slug: string, rel: string, content: string): string {
  const target = safePath(slug, rel);
  if (!target) return 'Invalid path';
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return `Wrote ${content.length} bytes to ${rel}`;
}

export function listFiles(slug: string, rel: string): string {
  const target = safePath(slug, rel);
  if (!target || !fs.existsSync(target)) return `[Directory not found: ${rel}]`;
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { return `[Cannot read: ${rel}]`; }
  if (!stat.isDirectory()) return `[Not a directory: ${rel}]`;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return `[Cannot list: ${rel}]`; }

  const lines: string[] = [];
  entries
    .filter((e) => !IGNORED_DIRS.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 200)
    .forEach((e) => {
      lines.push(e.isDirectory() ? `${e.name}/` : e.name);
    });
  return lines.join('\n') || '(empty)';
}

export function execCommand(slug: string, cmd: string): string {
  const clean = safeSlug(slug);
  const cwd = path.resolve(WORKSPACES_ROOT, clean);
  if (!fs.existsSync(cwd)) return `Workspace not found: ${slug}`;

  const opts: ExecSyncOptions = {
    cwd,
    timeout: EXEC_TIMEOUT,
    maxBuffer: MAX_OUTPUT,
    encoding: 'utf8',
    shell: '/bin/bash',
  };

  try {
    const stdout = execSync(cmd, opts);
    const str = stdout ? stdout.toString('utf8') : '';
    const trimmed = str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + '\n…(truncated)' : str;
    return trimmed || '(no output)';
  } catch (err: any) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    const msg = err.message || String(err);
    return [stdout, stderr, msg].filter(Boolean).join('\n').slice(0, MAX_OUTPUT);
  }
}

export function getProjectTree(slug: string, maxDepth = 3): string {
  const clean = safeSlug(slug);
  const base = path.resolve(WORKSPACES_ROOT, clean);
  if (!fs.existsSync(base)) return '(workspace not found)';

  const lines: string[] = [];
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];

  while (stack.length > 0 && lines.length < 300) {
    const { rel, depth } = stack.pop()!;
    const dir = rel ? path.join(base, rel) : base;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .forEach((e) => {
        if (lines.length >= 300) return;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) return;
          if (depth < maxDepth) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            lines.push(`${'  '.repeat(depth)}${e.name}/`);
            stack.push({ rel: child, depth: depth + 1 });
          }
        } else {
          lines.push(`${'  '.repeat(depth)}${e.name}`);
        }
      });
  }
  return lines.join('\n') || '(empty workspace)';
}
