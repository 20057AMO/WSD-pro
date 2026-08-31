/**
 * storage-metrics.ts
 * Madar — Disk-usage visibility: per-project workspace size, per-project
 * snapshot-archive size, the whole data-directory footprint, per-container
 * writable-layer sizes and Docker-level aggregates.
 *
 * Compute is ON-DEMAND with a short TTL cache (storage changes rarely and is
 * not latency-sensitive) + a singleflight guard so simultaneous viewers share
 * one scan instead of fanning out duplicate `du`-style walks or Docker calls.
 * Cache is invalidated on project create / duplicate / delete / import /
 * restore (the moments a workspace or archive set appears or disappears).
 *
 * The pure walk/sum rules live in storage-core.ts (import-free).
 */
import path from 'path';

import { listMetaSlugs, loadMeta } from './projects-meta';
import { dirSize } from './storage-core';
import { getContainersStorage, getDockerSystemDF, type ProjectContainerStorage } from './storage-docker';
import { WORKSPACES_ROOT } from './docker-manager';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROJECTS_DATA_DIR = path.join(DATA_DIR, 'projects');

export interface ProjectStorage {
  slug: string;
  name: string;
  workspaceBytes: number;
  snapshotBytes: number;
  workspaceTruncated?: boolean;
  container?: ProjectContainerStorage;
}

export interface StorageMetrics {
  generatedAt: string;
  /** Whole WSD_DATA_DIR footprint (includes per-project archives). */
  dataDirBytes: number;
  totalWorkspaceBytes: number;
  totalSnapshotBytes: number;
  containerWritableBytes: number;
  docker: {
    /** Aggregate disk usage via the /system/df endpoint; null when unreadable. */
    system: {
      totalBytes: number;
      imagesBytes: number;
      containersBytes: number;
      volumesBytes: number;
      buildCacheBytes: number;
    } | null;
    perProject: Record<string, ProjectContainerStorage>;
  };
  projects: ProjectStorage[];
}

const CACHE_TTL_MS = 45_000;

let cache: { at: number; data: StorageMetrics } | null = null;
let inflight: Promise<StorageMetrics> | null = null;

/** Drop the cached snapshot — call after any workspace/archive lifecycle change. */
export function invalidateStorageCache(): void {
  cache = null;
}

/** Env override for tests only; the default keeps the UI snappy. */
const VOLATILE_TTL = process.env.WSD_TESTING === '1' ? 2_000 : CACHE_TTL_MS;
const TTL_MS = Math.max(200, Number(process.env.WSD_STORAGE_TTL_MS) || VOLATILE_TTL);

export function getStorageCacheDebug(): { cacheAt: number | null; ttlMs: number } {
  return { cacheAt: cache?.at ?? null, ttlMs: TTL_MS };
}

/**
 * Compute (or serve cached) storage metrics. `fresh` bypasses the TTL but
 * still singleflights concurrent scans. Never throws: every per-item failure
 * degrades to a missing number rather than a 500.
 */
export async function getStorageMetrics(opts?: { fresh?: boolean }): Promise<StorageMetrics> {
  if (!opts?.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = compute()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function compute(): Promise<StorageMetrics> {
  const slugs = listMetaSlugs();
  const started = Date.now();
  // Hard outer ceiling: the whole scan must finish within ~60s even with many
  // projects; the per-walk budget inside dirSize enforces each individual walk.
  const outerDeadline = started + 60_000;

  const [containerMap, dockerSystem] = await Promise.all([
    getContainersStorage(),
    getDockerSystemDF(),
  ]);

  const projects: ProjectStorage[] = [];
  let totalWorkspaceBytes = 0;
  let totalSnapshotBytes = 0;

  for (const slug of slugs) {
    if (Date.now() > outerDeadline) break;
    const ws = dirSize(path.join(WORKSPACES_ROOT, slug), { budgetMs: 8_000 });
    const snap = dirSize(path.join(PROJECTS_DATA_DIR, slug, 'snapshots'), { budgetMs: 5_000 });
    const meta = loadMeta(slug);
    totalWorkspaceBytes += ws.size;
    totalSnapshotBytes += snap.size;
    projects.push({
      slug,
      name: meta?.name || slug,
      workspaceBytes: ws.size,
      snapshotBytes: snap.size,
      workspaceTruncated: ws.truncated || undefined,
      container: containerMap[slug],
    });
  }

  const dataDir = dirSize(DATA_DIR, { budgetMs: 20_000 });
  const containerWritableBytes = Object.values(containerMap).reduce((a, c) => a + c.writableBytes, 0);

  return {
    generatedAt: new Date().toISOString(),
    dataDirBytes: dataDir.size,
    totalWorkspaceBytes,
    totalSnapshotBytes,
    containerWritableBytes,
    docker: {
      system: dockerSystem,
      perProject: containerMap,
    },
    projects,
  };
}