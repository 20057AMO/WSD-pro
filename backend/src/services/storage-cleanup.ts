/**
 * storage-cleanup.ts
 * Madar — on-demand disk-space cleanup ("Clean up now" on the Dashboard's
 * storage section). Frees space immediately rather than waiting on the
 * janitor's WSD_ARCHIVE_DAYS age window:
 *   1. Runs the janitor sweep — archives orphaned workspace dirs into
 *      `.archive` and purges any that are already expired.
 *   2. Purges EVERY archive entry under `<WORKSPACES_ROOT>/.archive` now,
 *      regardless of age (the user explicitly asked to clear storage today).
 *   3. Removes stale orphan containers — those carrying the `wsd.managed`
 *      label but whose `wsd.project` label is missing OR whose meta store no
 *      longer exists (a deleted-but-not-fully-torn-down container).
 *   4. Optionally prunes the Docker build cache (`docker builder prune -f`).
 *
 * Every step is individually try/caught: a partial failure degrades to its
 * empty/zero result and NEVER throws — an editor pressing "Clean up" must get
 * a summary back even if, say, the Docker builder prune or the socket is down.
 */
import Docker from 'dockerode';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { runSweep } from './workspace-janitor';
import { purgeArchiveEntries } from './janitor-core';
import { loadMeta } from './projects-meta';
import { invalidateStorageCache } from './storage-metrics';
import { recordAudit } from './audit-store';
import { WORKSPACES_ROOT } from './docker-manager';

const execFileAsync = promisify(execFile);

// Same default transport as docker-manager (DOCKER_HOST / /var/run/docker.sock).
const docker = new Docker();

export interface CleanupResult {
  /** Workspace dirs moved into `.archive` by the janitor sweep. */
  archived: string[];
  /** `.archive` entries removed (expired by the sweep + every one cleared now). */
  purged: string[];
  /** Stale orphan containers force-removed. */
  containersRemoved: number;
  /** Whether the Docker build cache was pruned (opts.docker) or not. */
  dockerPruned: boolean;
}

/** Force-remove any `wsd.managed` container with no resolvable project. */
async function removeStaleContainers(): Promise<number> {
  let removed = 0;
  const containers = await docker.listContainers({ all: true });
  for (const c of containers) {
    const labels = c.Labels || {};
    if (labels['wsd.managed'] !== 'true') continue; // not one of ours — leave it
    const slug = labels['wsd.project'];
    if (slug && loadMeta(slug)) continue; // live project — keep
    // Missing `wsd.project` label OR missing meta store => stale orphan.
    try {
      await docker.getContainer(c.Id).remove({ force: true });
      removed += 1;
    } catch {
      /* a concurrent remove may have won — ignore */
    }
  }
  return removed;
}

export async function cleanupStorage(opts: { docker?: boolean } = {}): Promise<CleanupResult> {
  const result: CleanupResult = {
    archived: [],
    purged: [],
    containersRemoved: 0,
    dockerPruned: false,
  };

  // 1. Janitor sweep — archive orphaned workspaces, purge expired archives.
  try {
    const sweep = runSweep();
    result.archived = sweep.archived;
    result.purged = [...sweep.purged];
  } catch (e: any) {
    console.warn('[storage-cleanup] janitor sweep failed:', e?.message || e);
  }

  // 2. Purge ALL archive entries immediately — no age window.
  try {
    for (const name of purgeArchiveEntries(WORKSPACES_ROOT)) {
      if (!result.purged.includes(name)) result.purged.push(name);
    }
  } catch (e: any) {
    console.warn('[storage-cleanup] immediate archive purge failed:', e?.message || e);
  }

  // 3. Remove stale orphan containers.
  try {
    result.containersRemoved = await removeStaleContainers();
  } catch (e: any) {
    console.warn('[storage-cleanup] orphan-container cleanup failed:', e?.message || e);
  }

  // 4. Optional Docker build-cache prune (never throws; degrades to false).
  if (opts?.docker === true) {
    try {
      // argv-array exec — no shell interpolation of user/options input.
      await execFileAsync('docker', ['builder', 'prune', '-f'], { timeout: 60_000 });
      result.dockerPruned = true;
    } catch (e: any) {
      console.warn('[storage-cleanup] docker build-cache prune failed:', e?.message || e);
      result.dockerPruned = false;
    }
  }

  // 5. Invalidate the storage cache + record the audit entry.
  invalidateStorageCache();
  recordAudit('storage-cleanup', true);

  // 6. Summary — partial failures already degraded above.
  return result;
}
