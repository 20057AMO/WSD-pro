/**
 * storage-cleanup.test.ts
 * Offline unit coverage for the "Clean up now" storage action, focused on the
 * pure filesystem rules that do NOT need Docker:
 *  - `purgeArchiveEntries` clears EVERY .archive entry regardless of age
 *    (the point of on-demand cleanup vs the janitor's WSD_ARCHIVE_DAYS window)
 *  - orphan workspace dirs are archived while live projects survive
 *
 * These helpers are the filesystem half of `services/storage-cleanup.ts`
 * (`cleanupStorage`). The Docker parts of that service (stale-orphan container
 * removal + `docker builder prune`) cannot run offline and are covered by the
 * real-Docker suite / a manual orchestrator check — every step of
 * `cleanupStorage` is individually try/caught so a missing socket simply
 * degrades that step to its empty/zero result rather than throwing.

 * Runs fully offline against temp dirs — no server, no Docker.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-cleanup-'));
const wsRoot = path.join(tmp, 'workspaces');
const dataDir = path.join(tmp, 'data');

let purgeArchiveEntries!: (root: string) => string[];
let sweepWorkspaces!: (
  root: string,
  live: Iterable<string>,
  archiveDays: number,
) => { archived: string[]; purged: string[] };

const ready = (async () => {
  const core = await import('../src/services/janitor-core.ts');
  purgeArchiveEntries = core.purgeArchiveEntries;
  sweepWorkspaces = core.sweepWorkspaces;

  // Fixtures: one live project (+ meta) to protect from archiving.
  fs.mkdirSync(path.join(wsRoot, 'live-proj'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'live-proj', 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(dataDir, 'projects', 'live-proj'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'projects', 'live-proj', 'meta.json'),
    JSON.stringify({ activity: [] }),
  );
})();

describe('purgeArchiveEntries (pure)', () => {
  test('removes every archive entry regardless of age', async () => {
    await ready;
    // Two fresh (NOT age-expired) archive entries.
    fs.mkdirSync(path.join(wsRoot, '.archive', 'm-orphan-a'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, '.archive', 'm-orphan-a', 'deep.txt'), 'x');
    fs.mkdirSync(path.join(wsRoot, '.archive', 'm-orphan-b'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, '.archive', 'm-orphan-b', 'f'), 'y');

    const purged = purgeArchiveEntries(wsRoot);
    assert.ok(purged.includes('m-orphan-a'), `expected m-orphan-a purged: ${purged}`);
    assert.ok(purged.includes('m-orphan-b'), `expected m-orphan-b purged: ${purged}`);
    const remaining = fs.existsSync(path.join(wsRoot, '.archive'))
      ? fs.readdirSync(path.join(wsRoot, '.archive'))
      : [];
    assert.strictEqual(remaining.filter((n) => n.startsWith('m-')).length, 0);
    // A live workspace outside .archive must be untouched.
    assert.ok(fs.existsSync(path.join(wsRoot, 'live-proj', 'keep.txt')));
  });

  test('missing .archive is a clean no-op', async () => {
    await ready;
    fs.rmSync(path.join(wsRoot, '.archive'), { recursive: true, force: true });
    const purged = purgeArchiveEntries(wsRoot);
    assert.deepStrictEqual(purged, []);
  });

  test('rejects dot-dir entries', async () => {
    await ready;
    fs.mkdirSync(path.join(wsRoot, '.archive', '.runtime'), { recursive: true });
    const purged = purgeArchiveEntries(wsRoot);
    assert.ok(!purged.includes('.runtime'));
    assert.ok(fs.existsSync(path.join(wsRoot, '.archive', '.runtime')));
    fs.rmSync(path.join(wsRoot, '.archive', '.runtime'), { recursive: true, force: true });
  });
});

describe('orphan archiving (sweepWorkspaces)', () => {
  test('archives orphan workspace dirs, keeps live projects', async () => {
    await ready;
    fs.mkdirSync(path.join(wsRoot, 'orphan-c'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'orphan-c', 'payload.txt'), 'z');

    const r = sweepWorkspaces(wsRoot, ['live-proj'], 0);
    assert.ok(r.archived.includes('orphan-c'), `orphan-c not archived: ${r.archived}`);
    assert.ok(!r.archived.includes('live-proj'), 'live project must never be archived');
    assert.ok(fs.existsSync(path.join(wsRoot, 'live-proj', 'keep.txt')));
    assert.ok(!fs.existsSync(path.join(wsRoot, 'orphan-c')));
  });

  test('archived orphan is immediately removeable by purgeArchiveEntries', async () => {
    await ready;
    fs.mkdirSync(path.join(wsRoot, 'orphan-d'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'orphan-d', 'x.txt'), 'x');

    // Simulate the cleanup flow: archive the orphan, then purge ALL of .archive.
    const archived = sweepWorkspaces(wsRoot, ['live-proj'], 0).archived;
    assert.ok(archived.includes('orphan-d'));
    const moved = fs.readdirSync(path.join(wsRoot, '.archive')).find((n) => n.endsWith('-orphan-d'));
    assert.ok(moved, `no archive copy of orphan-d: ${fs.readdirSync(path.join(wsRoot, '.archive'))}`);
    const purged = purgeArchiveEntries(wsRoot);
    assert.ok(
      purged.some((n) => n.endsWith('-orphan-d')),
      `archive copy not purged in the same run: ${purged}`,
    );
    assert.ok(
      !fs.existsSync(path.join(wsRoot, '.archive', moved)),
      'archived orphan-d must be gone after the purge',
    );
  });
});
