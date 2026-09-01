/**
 * projects-cache.ts
 * Madar — TTL cache + singleflight for the project-LIST endpoint
 * (GET /api/projects).
 *
 * Every Dashboard poll used to fan out to `docker listContainers({all:true})`
 * + per-project `loadMeta` + `canvas.loadCanvas` file reads per request
 * (~200 req/s at scale). This module gives the list a short TTL cache with a
 * singleflight guard (the factory lives in the import-free
 * projects-cache-core.ts so `node --test` can exercise it offline). The full
 * enriched array — the exact shape the old route computed inline
 * (serve/crash/ports/limits from meta inside `listProjects`, plus the
 * `canvasEditedAt` enrichment) — is built first and only then swapped into the
 * cache: partial data is never observable.
 *
 * `invalidateProjectsCache()` is called by every lifecycle point that already
 * invalidates the storage cache (create / duplicate / start / stop / recreate
 * / delete in docker-manager.ts; create / duplicate / import / restore /
 * delete in index.ts), so a mutation is visible to the next list call.
 */

import { createProjectsCache, PROJECTS_CACHE_DEFAULT_TTL_MS, PROJECTS_CACHE_MIN_TTL_MS, type ProjectsCache } from './projects-cache-core';
import { listProjects, type ProjectInfo } from './docker-manager';
import * as canvas from './project-canvas';

export { createProjectsCache, PROJECTS_CACHE_DEFAULT_TTL_MS, PROJECTS_CACHE_MIN_TTL_MS };
export type { ProjectsCache };

/** The real builder: listProjects() + the canvasEditedAt enrichment the
 *  GET /api/projects route used to do inline per request. */
async function buildProjectsList(): Promise<ProjectInfo[]> {
  const projects = await listProjects();
  for (const p of projects) {
    (p as ProjectInfo & { canvasEditedAt?: string | null }).canvasEditedAt = canvas.loadCanvas(p.slug).updatedAt;
  }
  return projects;
}

const projectsCache = createProjectsCache(buildProjectsList);

/** Cached (or freshly built) enriched project list — used by GET /api/projects. */
export const getCachedProjects: () => Promise<ProjectInfo[]> = projectsCache.get;
/** Drop the cached list — wire alongside invalidateStorageCache() at lifecycle points. */
export const invalidateProjectsCache: () => void = projectsCache.invalidate;
export function getProjectsCacheDebug(): { cacheAt: number | null; ttlMs: number } {
  return projectsCache.debug();
}