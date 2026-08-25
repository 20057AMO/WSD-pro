import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Unified opencode integration layer.
 *
 * Every runtime call to opencode (session management, version probing,
 * self-update) goes through here so a future major version only needs new
 * implementations behind the same facade. The SUPPORTED_MAJORS gate drives
 * the Studio update channel: majors we have not adapted are never offered.
 */

const PORT = process.env.WSD_OPENCODE_PORT || '4096';

function baseUrl(): string {
  return process.env.WSD_OPENCODE_URL || `http://localhost:${PORT}`;
}

/** Directory holding the user-level opencode config (agents, skills, json). */
export function opencodeConfigDir(): string {
  return (
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), '.config', 'opencode')
  );
}

function dataDir(): string {
  return process.env.WSD_DATA_DIR || '/app/data';
}

/** Majors this integration layer is verified against. Extend to unlock v2. */
export const SUPPORTED_MAJORS: number[] = [1];

let cachedMajor: number | null = null;
let cachedVersion: string | null = null;

export interface VersionInfo {
  version: string;
  major: number | null;
  supported: boolean;
}

/** Probe the installed opencode CLI version (`opencode --version`). */
export function probeOpencodeVersion(): Promise<VersionInfo> {
  return new Promise((resolve) => {
    execFile('opencode', ['--version'], { timeout: 8000 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        cachedVersion = stdout.trim();
        const m = /(\d+)\./.exec(cachedVersion);
        if (m) cachedMajor = Number(m[1]);
      }
      resolve({
        version: cachedVersion || 'unknown',
        major: cachedMajor,
        supported: cachedMajor === null ? false : SUPPORTED_MAJORS.includes(cachedMajor),
      });
    });
  });
}

// ── Session integration ────────────────────────────────────────────────
// V1 server contract: GET /session?directory=, POST /session?directory=,
// DELETE /session/:id. A future V2 branch replaces these three primitives.

async function v1ListSessions(directory: string): Promise<Array<{ id?: unknown }>> {
  const r = await fetch(`${baseUrl()}/session?directory=${encodeURIComponent(directory)}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}

async function v1CreateSession(directory: string): Promise<void> {
  await fetch(`${baseUrl()}/session?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
}

async function v1DeleteSession(id: string): Promise<void> {
  await fetch(`${baseUrl()}/session/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(3000),
  });
}

/** Create an opencode session for a workspace directory (best-effort). */
export function createOpencodeSession(slug: string): void {
  const directory = path.join(
    process.env.WSD_PROJECTS_DIR || '/workspaces',
    slug,
  );
  seedOpencodeProjectId(directory);
  v1CreateSession(directory).catch(() => {
    /* opencode not ready yet — startup sync in entrypoint covers it */
  });
}

/** Ensure at least one session exists for the project (no duplicates). */
export function ensureOpencodeSession(slug: string): void {
  const directory = path.join(
    process.env.WSD_PROJECTS_DIR || '/workspaces',
    slug,
  );
  v1ListSessions(directory)
    .then((sessions) => {
      if (sessions.length > 0) return;
      createOpencodeSession(slug);
    })
    .catch(() => {
      // opencode unreachable or unexpected shape — plain registration is
      // idempotent enough for this purpose.
      createOpencodeSession(slug);
    });
}

/** Best-effort cleanup of sessions bound to a deleted project's directory. */
export function unregisterOpencodeProjectSessions(slug: string): void {
  const directory = path.join(
    process.env.WSD_PROJECTS_DIR || '/workspaces',
    slug,
  );
  v1ListSessions(directory)
    .then((sessions) => {
      for (const s of sessions) {
        if (!s || typeof s.id !== 'string') continue;
        v1DeleteSession(s.id).catch(() => {});
      }
    })
    .catch(() => {
      /* non-fatal */
    });
}

/** Seed <dir>/.git/opencode with a deterministic project id (V1 resolution). */
function seedOpencodeProjectId(dir: string): void {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    }
    const sha = crypto
      .createHash('sha1')
      .update(path.basename(dir))
      .digest('hex');
    fs.writeFileSync(path.join(dir, '.git', 'opencode'), sha);
  } catch {
    /* best effort — startup sync in entrypoint covers it */
  }
}

// ── Update machinery (Studio Update button backend) ─────────────────────

let updateInFlight = false;

export function isUpdateRunning(): boolean {
  return updateInFlight;
}

export interface RegistryInfo {
  latest: string | null;
  latestMajor: number | null;
  channelUnlocked: boolean;
}

/** Latest published version on npm (1.x `latest` dist-tag). */
export function fetchLatestVersion(): Promise<RegistryInfo> {
  return fetch('https://registry.npmjs.org/opencode-ai/latest', {
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: any) => {
      const latest = typeof j?.version === 'string' ? j.version : null;
      const m = latest ? /(\d+)\./.exec(latest) : null;
      const latestMajor = m ? Number(m[1]) : null;
      return {
        latest,
        latestMajor,
        channelUnlocked:
          latestMajor !== null && SUPPORTED_MAJORS.includes(latestMajor),
      };
    })
    .catch(() => ({ latest: null, latestMajor: null, channelUnlocked: false }));
}

export interface UpdateResult {
  ok: boolean;
  updatedTo?: string;
  restarted?: boolean;
  error?: string;
}

/**
 * Install the newest compatible release inside the container and restart
 * the supervised opencode web process into it. Single-flight; refuses
 * unsupported target majors via the caller-side gate as well as here.
 */
export function performOpencodeUpdate(): Promise<UpdateResult> {
  if (updateInFlight) {
    return Promise.resolve({ ok: false, error: 'An update is already running' });
  }
  updateInFlight = true;
  const done = (r: UpdateResult): UpdateResult => {
    updateInFlight = false;
    return r;
  };

  return fetchLatestVersion()
    .then((reg) => {
      if (!reg.latest || !reg.channelUnlocked) {
        return done({
          ok: false,
          error: `Latest release (${reg.latest ?? 'unknown'}) is not supported by this Madar build yet`,
        });
      }
      return new Promise<UpdateResult>((resolve) => {
        execFile(
          'npm',
          ['install', '-g', `opencode-ai@${reg.latest}`, '--no-fund', '--no-audit'],
          { timeout: 180_000 },
          (err) => {
            if (err) {
              resolve(done({ ok: false, error: `npm install failed: ${err.message}` }));
              return;
            }
            const restarted = restartSupervisedWeb();
            // Give the supervisor a moment before reporting fresh version.
            setTimeout(() => {
              probeOpencodeVersion().then((v) =>
                resolve(
                  done({
                    ok: true,
                    updatedTo: v.version,
                    restarted,
                  }),
                ),
              );
            }, 1500);
          },
        );
      });
    })
    .catch((e: Error) => done({ ok: false, error: e.message }));
}

/** Kill the supervised opencode child so entrypoint revives it (new binary). */
function restartSupervisedWeb(): boolean {
  try {
    const pidFile = path.join(dataDir(), 'opencode-web.pid');
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 1) {
      process.kill(pid, 'SIGTERM');
      return true;
    }
  } catch {
    /* pid file missing/stale — next container restart applies the update */
  }
  return false;
}
