/**
 * workspace-janitor.ts
 * WSD-Pro — automatic cleanup of orphaned workspace directories.
 *
 * A "orphan" is a directory under WORKSPACES_ROOT that has no live project
 * meta store (data/projects/<slug>/meta.json). These appear when a project
 * delete crashed mid-way, from pre-upgrade leftovers, or manual host-side
 * directories. Left alone they haunt code-server (which is rooted at
 * /workspaces) and opencode (which registers every visible directory).
 *
 * Sweep behaviour (pure logic lives in janitor-core.ts):
 *  - Orphans are MOVED into <WORKSPACES_ROOT>/.archive/<ts>-<slug>/ — same
 *    filesystem so the rename is instant, and dot-dirs are skipped by every
 *    registration loop, so archived projects vanish from both tools.
 *  - Archive entries older than WSD_ARCHIVE_DAYS (default 7) are purged.
 *  - Runs once at boot, then every WSD_JANITOR_INTERVAL_MS (default 6h).
 *    Both knobs exist for tests.
 */
import { listMetaSlugs } from './projects-meta';
import { recordAudit } from './audit-store';
import { sweepWorkspaces } from './janitor-core';
import { purgeOpencodeProjectRows } from './opencode-store';

const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';
const ARCHIVE_DAYS = Math.max(0, Number(process.env.WSD_ARCHIVE_DAYS ?? '7') || 0);
const INTERVAL_MS = Math.max(250, Number(process.env.WSD_JANITOR_INTERVAL_MS ?? '') || 6 * 60 * 60 * 1000);

export function runSweep(): { archived: string[]; purged: string[] } {
  const r = sweepWorkspaces(WORKSPACES_ROOT, listMetaSlugs(), ARCHIVE_DAYS);
  if (r.archived.length > 0) purgeOpencodeProjectRows(r.archived);
  if (r.archived.length > 0 || r.purged.length > 0) recordAudit('workspace-janitor', true);
  return r;
}

/** Boot sweep + fixed-interval sweeps. Returns a stop handle (for tests). */
export function startJanitor(): () => void {
  // Defer slightly so boot stays fast and first paint is unaffected.
  const boot = setTimeout(() => {
    try {
      runSweep();
    } catch {
      /* never crash startup over cleanup */
    }
  }, 5_000);
  const timer = setInterval(() => {
    try {
      runSweep();
    } catch {
      /* ignore */
    }
  }, INTERVAL_MS);
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
