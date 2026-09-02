/**
 * archive-core.ts
 * Madar — Pure, import-free filesystem helpers for the Trash Bin
 * (./.archive management). Mirrors the janitor-core / storage-core /
 * snapshots-schedule pattern: only node built-ins, no local-module imports,
 * so the offline unit tests can load this under `node --test` without Docker.
 *
 * Archive directory layout: <WORKSPACES_ROOT>/.archive/<base36-ts>-<slug>/
 * produced by the workspace janitor. The Trash API layers list / restore /
 * permanent-delete management over this existing layout without changing how
 * the janitor writes it.
 */
import fs from 'fs';
import path from 'path';

/** Same naming guard as janitor-core — no traversal, no dot-dirs. */
export function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.startsWith('.');
}

/**
 * Parse an archive entry name into { slug, date }.
 * Canonical form `<base36-ts>-<slug>`; a non-canonical entry (legacy or
 * hand-created) is still listable/deletable/restorable — its date is null and
 * the slug is the whole entry (traversal-unsafe names yield slug `''`).
 */
export function parseArchiveName(entry: string): { slug: string; date: string | null } {
  if (!safeName(entry)) return { slug: '', date: null };
  const match = /^([0-9a-z]+)-(.*)$/.exec(entry);
  if (match) {
    const ts = Number.parseInt(match[1], 36);
    if (Number.isFinite(ts) && ts > 0) {
      return { slug: match[2] || entry, date: new Date(ts).toISOString() };
    }
  }
  return { slug: entry, date: null };
}

/** List the archive entry names under `<root>/.archive` (safe names only). */
export function listArchiveEntries(root: string): string[] {
  const archiveDir = path.join(root, '.archive');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(archiveDir);
  } catch {
    return [];
  }
  return entries.filter(safeName).sort();
}

/** Resolve the absolute path of a single archive entry (traversal-guarded). */
export function archiveEntryPath(root: string, entry: string): string | null {
  if (!safeName(entry)) return null;
  const archiveDir = path.join(root, '.archive');
  const full = path.join(archiveDir, entry);
  // Ensure `full` really sits under `.archive` (belt-and-braces against /../).
  if (!full.startsWith(path.resolve(archiveDir) + path.sep)) return null;
  return full;
}

/** Recursively copy one directory tree into another, skipping broken entries. */
export function copyTree(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    try {
      const s = path.join(srcDir, entry);
      const d = path.join(dstDir, entry);
      const st = fs.lstatSync(s);
      // Never follow symlinks: an archived dir could contain a link pointing
      // outside `.archive` (e.g. to /etc or another project); copying through
      // it would leak arbitrary files into the restored workspace. Skip links.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        copyTree(s, d);
      } else if (st.isFile()) {
        fs.copyFileSync(s, d);
      }
    } catch {
      /* skip unreadable/broken entries — never fail a restore over one file */
    }
  }
}
