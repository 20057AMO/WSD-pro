/**
 * archive-core.test.ts
 * Madar — offline unit coverage for the pure Trash Bin filesystem rules
 * (archive-core.ts). Mirrors the janitor-core.test.ts pattern: only node
 * built-ins + temp dirs, no server, no Docker.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  safeName,
  parseArchiveName,
  listArchiveEntries,
  archiveEntryPath,
  copyTree,
} from '../src/services/archive-core.ts';

describe('archive-core', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-archive-core-'));
  const root = path.join(tmp, 'workspaces');

  test('safeName rejects traversal and dot-dirs', () => {
    assert.strictEqual(safeName('my-proj'), true);
    assert.strictEqual(safeName('m1abc2def-my-proj'), true);
    assert.strictEqual(safeName('.archive'), false);
    assert.strictEqual(safeName('..'), false);
    assert.strictEqual(safeName('../etc'), false);
    assert.strictEqual(safeName('-leading'), false);
  });

  test('parseArchiveName extracts timestamp + slug from canonical form', () => {
    // 0x1abc2def (= 449430511 ms) is a fixed timestamp; Date is deterministic.
    const { slug, date } = parseArchiveName('1abc2def-my-proj');
    assert.strictEqual(slug, 'my-proj');
    const d = new Date(Number.parseInt('1abc2def', 36));
    assert.strictEqual(date, d.toISOString());
  });

  test('parseArchiveName tolerates non-canonical entries', () => {
    // An entry with no separator still yields its name as the slug, date null.
    const a = parseArchiveName('strayfile');
    assert.strictEqual(a.slug, 'strayfile');
    assert.strictEqual(a.date, null);
    // Unsafe/traversal entry -> empty slug (guarded, never a path escape).
    assert.strictEqual(parseArchiveName('..').slug, '');
    assert.strictEqual(parseArchiveName('.archive').slug, '');
  });

  test('listArchiveEntries returns only safe entries, missing dir -> empty', () => {
    assert.deepStrictEqual(listArchiveEntries(root), []);
    fs.mkdirSync(path.join(root, '.archive'), { recursive: true });
    fs.writeFileSync(path.join(root, '.archive', 'm1-ok'), 'x');
    fs.writeFileSync(path.join(root, '.archive', '..bad'), 'y');
    fs.writeFileSync(path.join(root, '.archive', '.hidden'), 'z');
    const entries = listArchiveEntries(root);
    assert.ok(entries.includes('m1-ok'), `expected m1-ok in ${entries}`);
    assert.ok(!entries.includes('..bad'));
    assert.ok(!entries.includes('.hidden'), 'dot-leading names must be filtered');
  });

  test('archiveEntryPath resolves only inside .archive, rejects traversal', () => {
    fs.mkdirSync(path.join(root, '.archive'), { recursive: true });
    const ok = archiveEntryPath(root, 'm1-ok');
    assert.ok(ok);
    assert.ok(ok!.startsWith(path.resolve(path.join(root, '.archive')) + path.sep));
    assert.strictEqual(archiveEntryPath(root, '..'), null);
    assert.strictEqual(archiveEntryPath(root, '../etc'), null);
    assert.strictEqual(archiveEntryPath(root, '.archive'), null);
  });

  test('copyTree duplicates a nested tree like a workspace', () => {
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');
    fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(src, 'file.txt'), 'a');
    fs.writeFileSync(path.join(src, 'nested', 'deep.txt'), 'b');
    copyTree(src, dst);
    assert.strictEqual(fs.readFileSync(path.join(dst, 'file.txt'), 'utf8'), 'a');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'nested', 'deep.txt'), 'utf8'), 'b');
  });

  test('copyTree skips symlinks — never follows external targets', () => {
    const src = path.join(tmp, 'sym-src');
    const dst = path.join(tmp, 'sym-dst');
    const outside = path.join(tmp, 'outside-secret.txt');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(outside, 'SECRET');
    try {
      fs.symlinkSync(outside, path.join(src, 'link'));
    } catch {
      return; // symlinks unsupported on this filesystem — skip
    }
    fs.writeFileSync(path.join(src, 'real.txt'), 'ok');
    copyTree(src, dst);
    assert.strictEqual(fs.readFileSync(path.join(dst, 'real.txt'), 'utf8'), 'ok');
    assert.ok(!fs.existsSync(path.join(dst, 'link')), 'symlink must not be copied through');
  });
});
