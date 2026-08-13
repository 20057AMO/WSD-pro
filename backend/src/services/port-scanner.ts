/**
 * port-scanner.ts
 * WSD-Pro — Discover open ports inside a project container (for live previews).
 * Runs `ss -tlnH` via docker exec, cached for 5 seconds per project.
 */
import { execInProject } from './docker-manager';

const TTL_MS = 5000;
const cache = new Map<string, { ports: number[]; at: number }>();

function parseSsOutput(raw: string): number[] {
  const ports = new Set<number>();
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/:(\d+)\s*$/);
    if (m) {
      const p = Number(m[1]);
      // Skip Docker's internal API ports noise; keep userland ports only
      if (p >= 1 && p <= 65535 && p !== 22) ports.add(p);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export async function scanProjectPorts(slug: string, fresh = false): Promise<number[]> {
  const cached = cache.get(slug);
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) {
    return cached.ports;
  }
  try {
    const { output, exitCode } = await execInProject(slug, [
      'bash',
      '-c',
      "ss -tlnH 2>/dev/null | awk '{print $3}' | awk -F: '{print $NF}' | grep -E '^[0-9]+$' | sort -un",
    ]);
    const ports = exitCode === 0 ? parseSsOutput(output) : [];
    cache.set(slug, { ports, at: Date.now() });
    return ports;
  } catch {
    return cached?.ports ?? [];
  }
}

export function getCachedPorts(slug: string): number[] {
  return cache.get(slug)?.ports ?? [];
}