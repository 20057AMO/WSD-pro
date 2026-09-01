/**
 * project-context-core.ts
 * Madar — PURE, import-free cache + signature conventions behind the AI chat
 * context block (like janitor-core / serve-core / snapshots-schedule /
 * projects-cache-core): no service imports, so `node --test` can load it
 * offline and drive the EXACT rules the server uses.
 *
 * The docker/notes/canvas-backed wiring lives in project-context.ts and feeds
 * these primitives:
 *   - `computeWorkspaceSignature(files)` – signature excludes the derived
 *     WSD_CANVAS.md mirror (it is rendered as the [Planning canvas] block, so
 *     it must cost no scan and no signature entry).
 *   - `contextCacheKey(...)` – workspace sig + notes sig + canvas sig, so note
 *     and canvas edits (which bump their own signatures) invalidate the cached
 *     context without any explicit bookkeeping.
 *   - `ProjectContextCache` – fixed-cap, TTL'd map with per-slug invalidation
 *     and oldest-first eviction.
 *   - `BriefCache` – single-slot TTL cache for the 'all'-scope brief so the
 *     next prompt never re-queries Docker while warm.
 *   - `buildContextBlock(...)` – the shared join+cap over the assembled parts,
 *     so the section ordering/content is assertion-testable offline with the
 *     exact logic production renders.
 */

export interface ScanSigFile {
  rel: string;
  size: number;
  mtimeMs: number;
}

/** WSD_CANVAS.md is a derived flat-text mirror of canvas.json. The AI block
 *  already renders the board as the [Planning canvas] section, so the mirror
 *  is skipped at SCAN time (costs no stat, no entry) and at signature time
 *  (costs no signature entry) — see project-context.ts scanWorkspace. */
export function isCanvasMirrorFile(name: string): boolean {
  return name === 'WSD_CANVAS.md';
}

/** Signature of a scanned workspace. WSD_CANVAS.md is the derived canvas
 *  mirror — never signatured (and excluded at scan time upstream). */
export function computeWorkspaceSignature(files: ScanSigFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    if (isCanvasMirrorFile(f.rel)) continue;
    parts.push(`${f.rel}:${f.size}:${Math.round(f.mtimeMs)}`);
  }
  return parts.join('|');
}

export function contextCacheKey(slug: string, workspaceSig: string, notesSig: string, canvasSig: string): string {
  return `${slug}::${workspaceSig}::${notesSig}::${canvasSig}`;
}

export interface CtxEntry {
  sig: string;
  text: string;
  truncated: boolean;
  at: number;
}

/** Fixed-cap, TTL'd per-project context cache. Eviction is oldest-first (the
 *  Map's first key), matching the previous first-key eviction pattern. */
export class ProjectContextCache {
  private map = new Map<string, CtxEntry>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max: number, ttlMs: number) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get(key: string, now = Date.now()): CtxEntry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (now - e.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  set(key: string, entry: Omit<CtxEntry, 'at'>, now = Date.now()): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { ...entry, at: now });
  }

  /** Drop every entry belonging to one project (edits invalidate instantly). */
  invalidateProject(slug: string): void {
    const prefix = `${slug}::`;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

export interface BriefResult {
  text: string;
  truncated: boolean;
}

/** Single-slot TTL cache for the 'all'-scope brief. `get` runs the supplied
 *  builder (the Docker-backed brief text) once and serves the cached raw text
 *  while it is fresh — a warm slot means the builder (and thus Docker) is
 *  never re-invoked on the next prompt. Capping stays with the caller so the
 *  truncation semantics match the uncached path exactly. */
export class BriefCache {
  private slot: { text: string; at: number } | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  async get(build: () => Promise<string>, now = Date.now()): Promise<string> {
    if (this.slot && now - this.slot.at < this.ttlMs) return this.slot.text;
    const text = await build();
    this.slot = { text, at: now };
    return text;
  }

  invalidate(): void {
    this.slot = null;
  }
}

/** Cap a block to `max` chars, appending a truncation notice. Mirrors
 *  capText's contract so the assembled block tests match production. */
export function capTextCore(text: string, max: number): BriefResult {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…(truncated, ${text.length} chars)`, truncated: true };
}

/** Join the assembled block parts exactly as production renders them
 *  (`parts.join('\n\n')` then cap). Keeping this here lets the offline test
 *  assert the [Developer notes] / [Planning canvas] section ordering/content
 *  with the identical join+cap the server uses. */
export function buildContextBlock(parts: string[], maxChars: number): BriefResult {
  return capTextCore(parts.filter((p) => p !== undefined && p !== null).join('\n\n'), maxChars);
}
