/**
 * project-context.test.ts
 * Offline coverage for the AI-chat context cache + brief + signature rules
 * (the import-free `project-context-core.ts` that `project-context.ts` wires).
 *
 * Covers the Phase C context-injection requirements:
 *   - brief-cache hit returns the cached result WITHOUT re-running the Docker
 *     builder (stub `listProjects`-equivalent source).
 *   - the full context block contains goals + notes + canvas flat text in the
 *     production section format/order.
 *   - WSD_CANVAS.md (the derived planning-board mirror) is excluded from the
 *     workspace signature.
 *   - `invalidateProjectContext` clears a project's cached context (what the
 *     notes-save path calls) so edits invalidate instantly.
 *   - the per-project context cache is capped and evicts oldest-first.
 *
 * Runs fully offline — no server, no Docker (the core is import-free).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  computeWorkspaceSignature,
  contextCacheKey,
  ProjectContextCache,
  BriefCache,
  buildContextBlock,
  isCanvasMirrorFile,
} from '../src/services/project-context-core.ts';

describe('brief cache (all-scope) — a warm slot never re-runs the builder', () => {
  test('hit returns the same text without invoking the Docker source again', async () => {
    const brief = new BriefCache(15_000);
    let buildCalls = 0;
    const source = {
      listProjects: async () => {
        buildCalls += 1;
        return [
          {
            id: '1',
            name: 'Alpha',
            slug: 'alpha',
            status: 'running',
            hostPorts: {},
          } as any,
        ];
      },
    };

    const build = async () => {
      // Mirrors listProjectsBrief's builder: pull the (stubbed) project list.
      const projects = await source.listProjects();
      return projects.length
        ? `[Project context — all projects]\n- Alpha [alpha] — running`
        : '[Project context — all projects]\n(no projects found yet)';
    };

    const first = await brief.get(build);
    // Fresh window → second call is a cache hit; the builder (→ listProjects)
    // must not be re-invoked.
    const second = await brief.get(build);
    assert.strictEqual(first, second);
    assert.strictEqual(buildCalls, 1, 'a warm brief cache must not re-query the project source');
  });

  test('after TTL expiry the builder runs again', async () => {
    const brief = new BriefCache(1000);
    let builds = 0;
    const now = 1_000_000;
    await brief.get(async () => {
      builds += 1;
      return 'first';
    }, now);
    // past the 1s TTL
    await brief.get(async () => {
      builds += 1;
      return 'second';
    }, now + 1500);
    assert.strictEqual(builds, 2, 'expired brief should rebuild');
  });
});

describe('workspace signature — WSD_CANVAS.md is excluded', () => {
  test('the scan-time rule recognises the derived board mirror', () => {
    assert.strictEqual(isCanvasMirrorFile('WSD_CANVAS.md'), true);
    assert.strictEqual(isCanvasMirrorFile('WSD_PROJECT.md'), false);
    assert.strictEqual(isCanvasMirrorFile('wsc_canvas.md'), false);
    assert.strictEqual(isCanvasMirrorFile('src/WSD_CANVAS.md'), false, 'mirror only exists at root; deeper names are legit files');
  });

  test('the derived board mirror never enters the signature', () => {
    const files = [
      { rel: 'src/index.ts', size: 100, mtimeMs: 1000 },
      { rel: 'WSD_PROJECT.md', size: 50, mtimeMs: 999 },
      { rel: 'WSD_CANVAS.md', size: 1234, mtimeMs: 5555 },
    ];
    const sig = computeWorkspaceSignature(files);
    assert.ok(sig.includes('src/index.ts:100:1000'), 'normal file in signature');
    assert.ok(sig.includes('WSD_PROJECT.md:50:999'), 'goals file in signature');
    assert.ok(!sig.includes('WSD_CANVAS.md'), 'WSD_CANVAS.md must be excluded from the signature');
    // Editing WSD_CANVAS.md alone must not change the signature.
    const edited = [
      { rel: 'src/index.ts', size: 100, mtimeMs: 1000 },
      { rel: 'WSD_PROJECT.md', size: 50, mtimeMs: 999 },
      { rel: 'WSD_CANVAS.md', size: 99999, mtimeMs: 123456789 },
    ];
    assert.strictEqual(computeWorkspaceSignature(edited), sig);
  });

  test('cache key folds notes + canvas signatures alongside the workspace sig', () => {
    const key = contextCacheKey('proj-b', 'ws-sig', 'notes-sig', 'canvas-sig');
    assert.strictEqual(key, 'proj-b::ws-sig::notes-sig::canvas-sig');
    // A new notes sig → new key → cache miss (edits invalidate via signature).
    assert.notStrictEqual(
      contextCacheKey('proj-b', 'ws-sig', 'notes-sig-v2', 'canvas-sig'),
      key
    );
  });
});

describe('context cache — invalidation + cap eviction', () => {
  test('invalidateProject clears every entry for one slug (notes-save semantics)', () => {
    const cache = new ProjectContextCache(40, 300_000);
    const k = contextCacheKey('slug-a', 'ws1', 'n1', 'c1');
    cache.set(k, { sig: 'x', text: 'A', truncated: false });
    cache.set(contextCacheKey('slug-b', 'ws1', 'n1', 'c1'), { sig: 'x', text: 'B', truncated: false });

    assert.strictEqual(cache.size(), 2);
    cache.invalidateProject('slug-a');
    assert.strictEqual(cache.size(), 1, 'only slug-a entries dropped');
    assert.ok(!cache.has(k), 'slug-a entry gone');
    assert.ok(cache.has(contextCacheKey('slug-b', 'ws1', 'n1', 'c1')), 'other slug untouched');
  });

  test('expired entries are treated as misses', () => {
    const cache = new ProjectContextCache(40, 1000);
    const k = 'proj-x::sig';
    cache.set(k, { sig: 'x', text: 't', truncated: false }, 1000);
    assert.ok(cache.get(k, 1500), 'within TTL → hit');
    assert.strictEqual(cache.get(k, 3000), undefined, 'after TTL → miss');
  });

  test('cache is capped and evicts oldest-first', () => {
    const cache = new ProjectContextCache(2, 300_000);
    cache.set('k1', { sig: 'x', text: '1', truncated: false }, 100);
    cache.set('k2', { sig: 'x', text: '2', truncated: false }, 200);
    // third insert at cap → evicts the oldest (first key = k1)
    cache.set('k3', { sig: 'x', text: '3', truncated: false }, 300);

    assert.strictEqual(cache.size(), 2);
    assert.ok(cache.has('k2') && cache.has('k3'), 'newest two retained');
    assert.ok(!cache.has('k1'), 'oldest-first eviction dropped k1');
  });
});

describe('full context block assembly', () => {
  test('goals + developer notes + planning canvas render as flat text in order', () => {
    // Mirrors buildFullContext's parts (same `\n## …` prefixes production pushes).
    const parts = [
      '[Project context — demo]',
      'Name: Demo',
      'Status: running',
      '\n## Project goals (WSD_PROJECT.md)\n- Ship feature A\n- Ship feature B',
      '\n## Developer notes (from Madar Notes)\n[Developer notes]\n### Known issues (open)\n- Bug: login 500',
      '\n[Planning canvas]\n- [note] Plan launch\n- [task] Review the login flow',
    ];
    const { text } = buildContextBlock(parts, 24_000);

    assert.match(text, /\[Project context — demo\]/);
    assert.match(text, /## Project goals[\s\S]*Ship feature A/);
    assert.match(text, /Developer notes[\s\S]*Bug: login 500/);
    assert.match(text, /\[Planning canvas\]/);
    assert.match(text, /- \[note\] Plan launch/);
    assert.match(text, /- \[task\] Review the login flow/);

    // Section ordering: goals header before notes before canvas.
    const goalIdx = text.indexOf('## Project goals');
    const notesIdx = text.indexOf('## Developer notes');
    const canvasIdx = text.indexOf('[Planning canvas]');
    assert.ok(goalIdx < notesIdx && notesIdx < canvasIdx, 'sections stay priority-ordered');
  });

  test('block cap truncates with the production notice', () => {
    const parts = ['[Project context — x]', 'a'.repeat(500)];
    const full = parts.join('\n\n');
    const { text, truncated } = buildContextBlock(parts, 50);
    assert.ok(truncated);
    assert.match(text, /…\(truncated, \d+ chars\)/);
    assert.strictEqual(text, `${full.slice(0, 50)}\n…(truncated, ${full.length} chars)`);
  });
});
