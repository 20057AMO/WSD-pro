/**
 * workspace-janitor.test.ts
 * Unit coverage for the automatic orphaned-workspace cleanup:
 *  - orphan dirs (no project meta) are archived out of the workspaces root
 *  - live projects are never touched
 *  - dot-dirs are ignored (they hide runtime state)
 *  - expired archive entries are purged (WSD_ARCHIVE_DAYS=0 ⇒ immediate)
 *
 * Runs fully offline against a temp dir — no server, no Docker.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('Workspace janitor', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-janitor-'));
  const wsRoot = path.join(tmp, 'workspaces');
  const dataDir = path.join(tmp, 'data');

  // Env is read at module-import time, so set it before the dynamic import.
  process.env.WSD_DATA_DIR = dataDir; // audits (transitively imported) stay in temp

  let runSweep!: () => { archived: string[]; purged: string[] };

  const ready = (async () => {
    const { sweepWorkspaces } = await import('../src/services/janitor-core.ts');
    const listMetaSlugs = (): string[] => {
      const metaDir = path.join(dataDir, 'projects');
      try {
        return fs
          .readdirSync(metaDir)
          .filter((s) => s && !s.startsWith('.') && fs.existsSync(path.join(metaDir, s, 'meta.json')));
      } catch {
        return [];
      }
    };
    runSweep = () => sweepWorkspaces(wsRoot, listMetaSlugs(), 0);

    // Fixtures: two orphans, one live project, one runtime dot-dir.
    fs.mkdirSync(path.join(wsRoot, 'orphan-a', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'orphan-a', 'file.txt'), 'x');
    fs.writeFileSync(path.join(wsRoot, 'orphan-a', 'nested', 'deep.txt'), 'y');
    fs.mkdirSync(path.join(wsRoot, 'orphan-b'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'orphan-b', 'f'), 'z');
    fs.mkdirSync(path.join(wsRoot, 'live-proj'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'live-proj', 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(dataDir, 'projects', 'live-proj'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'projects', 'live-proj', 'meta.json'),
      JSON.stringify({ activity: [] }),
    );
    fs.mkdirSync(path.join(wsRoot, '.runtime-cache'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, '.runtime-cache', 'junk'), 'j');
  })();

  test('first sweep archives orphans, keeps live projects and dot-dirs', async () => {
    await ready;
    const r = runSweep();
    assert.ok(r.archived.includes('orphan-a'), `orphan-a not archived: ${r.archived}`);
    assert.ok(r.archived.includes('orphan-b'), `orphan-b not archived: ${r.archived}`);
    assert.ok(!r.archived.includes('live-proj'), 'live project must never be archived');
    assert.strictEqual(
      fs.existsSync(path.join(wsRoot, 'live-proj', 'keep.txt')),
      true,
      'live project files must stay put',
    );
    assert.strictEqual(fs.existsSync(path.join(wsRoot, 'orphan-a')), false);
    const archive = path.join(wsRoot, '.archive');
    const movedA = fs.readdirSync(archive).find((n) => n.endsWith('-orphan-a'));
    assert.ok(movedA, 'archived copy must exist under .archive');
    assert.strictEqual(
      fs.existsSync(path.join(archive, String(movedA), 'nested', 'deep.txt')),
      true,
      'archived tree must be complete',
    );
    assert.strictEqual(fs.existsSync(path.join(wsRoot, '.runtime-cache')), true, 'dot-dirs must be ignored');
  });

  test('second sweep purges expired archive entries (ARCHIVE_DAYS=0)', async () => {
    await ready;
    const r = runSweep();
    assert.ok(r.purged.length >= 2, `expected purged entries, got ${r.purged.length}`);
    const remaining = fs.existsSync(path.join(wsRoot, '.archive'))
      ? fs.readdirSync(path.join(wsRoot, '.archive'))
      : [];
    assert.strictEqual(remaining.filter((n) => n.endsWith('-orphan-a') || n.endsWith('-orphan-b')).length, 0);
    assert.ok(!r.archived.includes('live-proj'));
  });

  test('sweep over an empty root is a clean no-op', async () => {
    await ready;
    const r = runSweep();
    assert.deepStrictEqual(r, { archived: [], purged: [] });
  });

  test('live project created AFTER fixtures still survives sweeps', async () => {
    await ready;
    fs.mkdirSync(path.join(dataDir, 'projects', 'late-live'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'projects', 'late-live', 'meta.json'),
      JSON.stringify({ activity: [] }),
    );
    fs.mkdirSync(path.join(wsRoot, 'late-live'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'late-live', 'data.txt'), 'd');
    runSweep();
    assert.strictEqual(fs.existsSync(path.join(wsRoot, 'late-live', 'data.txt')), true);
  });
});
