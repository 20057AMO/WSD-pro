/**
 * storage-docker.ts
 * Madar — Docker-side storage readings for the storage-metrics feature.
 *
 * Per-project container writable-layer sizes come from one `listContainers`
 * call with `size: true` (SizeRw/SizeRootFs per container — the same data the
 * Docker API returns when inspecting individually, at list cost). Aggregates
 * come from the `/system/df` endpoint (dockerode's `df()`), which dockerode
 * does not type — read defensively via a cast and null-out on failure so a
 * Docker hiccup can never fail a read-only metrics request.
 */
import Docker from 'dockerode';

const docker = new Docker();

export interface ProjectContainerStorage {
  writableBytes: number;
  rootFsBytes: number;
}

export interface DockerSystemDF {
  totalBytes: number;
  imagesBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
}

/** Writable-layer + rootfs size for every managed (wsd.*) project container. */
export async function getContainersStorage(): Promise<Record<string, ProjectContainerStorage>> {
  try {
    const list = (await (docker.listContainers as any)({ all: true, size: true })) as any[];
    const out: Record<string, ProjectContainerStorage> = {};
    for (const c of list || []) {
      const labels = (c?.Labels || {}) as Record<string, string>;
      if (labels['wsd.managed'] !== 'true') continue;
      const slug = labels['wsd.project'] || String(c?.Names?.[0] || '').replace(/^\//, '').replace(/^wsd-/, '');
      if (!slug) continue;
      out[slug] = {
        writableBytes: typeof c?.SizeRw === 'number' ? c.SizeRw : 0,
        rootFsBytes: typeof c?.SizeRootFs === 'number' ? c.SizeRootFs : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Aggregate disk usage across images/containers/volumes/build-cache (df). */
export async function getDockerSystemDF(): Promise<DockerSystemDF | null> {
  try {
    const res: any = await (docker as any).df();
    const read = (item: any, key: string): number => {
      const val = key.split('.').reduce((o, k) => o?.[k], item);
      return typeof val === 'number' ? val : 0;
    };
    const sum = (list: any[], key: string): number =>
      (list || []).reduce((a, item: any) => a + read(item, key), 0);
    const imagesBytes = sum(res?.Images, 'Size');
    const containersBytes = sum(res?.Containers, 'SizeRw');
    const volumesBytes = sum(res?.Volumes, 'UsageData.Size');
    const buildCacheBytes = sum(res?.BuildCache, 'Size');
    return {
      imagesBytes,
      containersBytes,
      volumesBytes,
      buildCacheBytes,
      totalBytes: imagesBytes + containersBytes + volumesBytes + buildCacheBytes,
    };
  } catch {
    return null;
  }
}