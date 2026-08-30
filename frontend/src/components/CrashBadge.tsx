import { crashTitle, type CrashInfo } from '../api';

/**
 * Red "crashed" badge shown next to a project's status when the background
 * alert sweeper detected a non-user-initiated exit / OOM / auto-restart.
 */
export function CrashBadge({ crash }: { crash: CrashInfo }) {
  return <span class="status-badge error" title={crashTitle(crash)}>crashed</span>;
}