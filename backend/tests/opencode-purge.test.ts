/**
 * opencode-purge.test.ts
 * Coverage for the shared opencode SQLite purge helper (docker/opencode-purge.py):
 *  - targeted mode removes only the named stale slug's rows
 *  - live projects and the global root instance survive every run
 *  - boot mode (no slugs) purges all remaining stale rows
 *  - missing db file is a silent no-op
 *
 * Self-skips when python3 is unavailable on the host — inside the container
 * it always runs, and the lifecycle suite exercises it end-to-end there.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docker',
  'opencode-purge.py',
);

function pyAvailable(): boolean {
  try {
    const r = spawnSync('python3', ['--version'], { stdio: 'ignore' });
    return !r.error;
  } catch {
    return false;
  }
}

describe('opencode SQLite purge helper', () => {
  let tmp = '';
  let dataDir = '';
  let dbPath = '';

  before(() => {
    if (!pyAvailable()) return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-opencode-purge-'));
    dataDir = path.join(tmp, 'data');
    dbPath = path.join(dataDir, 'opencode', 'opencode', 'opencode.db');
    fs.mkdirSync(path.join(dataDir, 'projects', 'live'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects', 'live', 'meta.json'), '{}');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    execFileSync('python3', [
      '-c',
      `
import sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)")
cur.execute("CREATE TABLE project_directory (project_id TEXT, directory TEXT)")
rows = [
    ("global", "/"),
    ("id-live", "/workspaces/live"),
    ("id-dead", "/workspaces/dead"),
    ("id-dead2", "/workspaces/dead2"),
]
for pid, wt in rows:
    cur.execute("INSERT INTO project VALUES (?, ?)", (pid, wt))
    if wt != "/":
        cur.execute("INSERT INTO project_directory VALUES (?, ?)", (pid, wt))
con.commit()
con.close()
`,
      dbPath,
    ]);
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const runPurge = (...slugs: string[]): string =>
    execFileSync('python3', [SCRIPT, dataDir, ...slugs], { encoding: 'utf8' });

  const ids = (): string[] =>
    JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import sqlite3,sys,json;print(json.dumps([r[0] for r in sqlite3.connect(sys.argv[1]).execute("SELECT id FROM project")]))`,
          dbPath,
        ],
        { encoding: 'utf8' },
      ),
    );

  const dirCountFor = (pid: string): number =>
    Number(
      execFileSync(
        'python3',
        [
          '-c',
          `import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("SELECT COUNT(*) FROM project_directory WHERE project_id=?",(sys.argv[2],)).fetchone()[0])`,
          dbPath,
          pid,
        ],
        { encoding: 'utf8' },
      ).trim(),
    );

  test('targeted purge removes only the named stale slug', (t) => {
    if (!pyAvailable()) return t.skip('python3 not available on host');
    const out = runPurge('dead');
    assert.match(out, /removed 1 stale/);
    assert.deepEqual(ids().sort(), ['global', 'id-dead2', 'id-live']);
    assert.equal(dirCountFor('id-dead'), 0);
    assert.equal(dirCountFor('id-live'), 1);
  });

  test('boot mode purges every remaining stale row', (t) => {
    if (!pyAvailable()) return t.skip('python3 not available on host');
    const out = runPurge();
    assert.match(out, /removed 1 stale/);
    assert.deepEqual(ids().sort(), ['global', 'id-live']);
  });

  test('missing db file is a silent no-op', (t) => {
    if (!pyAvailable()) return t.skip('python3 not available on host');
    const empty = path.join(tmp, 'empty-data');
    fs.mkdirSync(empty, { recursive: true });
    const out = execFileSync('python3', [SCRIPT, empty], { encoding: 'utf8' });
    assert.equal(out.trim(), '');
  });
});
