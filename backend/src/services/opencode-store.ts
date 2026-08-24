import { spawn } from 'node:child_process';
import path from 'node:path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PURGE_SCRIPT = process.env.WSD_OPENCODE_PURGE_SCRIPT || '/app/opencode-purge.py';

/**
 * Best-effort removal of a project's rows from opencode's SQLite store
 * (project + project_directory). Runs the shared python purge script so a
 * deleted project never haunts the opencode web UI until the next restart.
 * Fire-and-forget: python3 or the script being absent, DB locks, anything —
 * the boot-time entrypoint purge is the safety net.
 */
export function purgeOpencodeProjectRows(slugs: string[]): void {
  const names = [...new Set(slugs.filter((s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s)))];
  if (names.length === 0) return;
  try {
    const child = spawn('python3', [PURGE_SCRIPT, DATA_DIR, ...names], {
      stdio: 'ignore',
      timeout: 8000,
    });
    child.on('error', () => {});
  } catch {
    /* non-fatal */
  }
}
