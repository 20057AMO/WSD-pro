import type { Project, ProjectLimits } from '../api';

/** Format a canonical CPU string ("2", "500m") for display. */
export function fmtCpu(cpu: string | null | undefined): string {
  if (!cpu) return '';
  const m = /^(\d+)m$/.exec(cpu);
  if (m) return `${Number(m[1]) / 1000} CPU`;
  return `${cpu} CPU`;
}

/** Format a canonical memory string ("128Mi", "1Gi") for display. */
export function fmtMem(memory: string | null | undefined): string {
  if (!memory) return '';
  const m = /^(\d+)(Mi|Gi)$/i.exec(memory);
  if (m) return `${m[1]} ${m[2]}`;
  return memory;
}

/** Whether the configured (meta) limits differ from what the container applies. */
export function limitsPending(p?: Pick<Project, 'limits' | 'liveLimits'> | null): boolean {
  const a = p?.limits ?? {};
  const b = p?.liveLimits ?? {};
  return (a.cpu ?? null) !== (b.cpu ?? null) || (a.memory ?? null) !== (b.memory ?? null);
}

export type { ProjectLimits };