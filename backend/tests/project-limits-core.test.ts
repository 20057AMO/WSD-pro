/**
 * project-limits-core.test.ts
 * Pure unit coverage for the CPU/memory limit helpers (parsing, canonical
 * forms, patch merge / removal semantics, host-cap ceilings, equality, host
 * introspection). No server, no Docker — fully offline.
 *
 * Mirrors the plan: cpu as full CPUs ("2") or milli-CPUs ("500m"); memory in
 * binary units ("128Mi"/"1Gi"); `null`/blank removes a limit; partial patches
 * preserve untouched fields; ceilings cap mem at 90% of host RAM and cpu at
 * 4× host cores, with a 0.1 cpu / 32 MiB floor.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  parseCpu,
  parseMemory,
  sanitizeLimitsPatch,
  limitsEqual,
  isEmptyLimits,
  checkCeilings,
  resolveDefaultLimits,
  formatMemory,
  formatCpu,
  type ProjectLimits,
} from '../src/services/project-limits.ts';

const HOST = { cpu: 8, memBytes: 16 * 1024 ** 3 }; // 8 cores, 16 GiB

describe('parseCpu', () => {
  test('full CPUs', () => {
    const p = parseCpu('2');
    assert.ok(p);
    assert.strictEqual(p!.nano, 2 * 1e9);
    assert.strictEqual(p!.canonical, '2');
  });

  test('milli-CPUs', () => {
    const p = parseCpu('500m');
    assert.ok(p);
    assert.strictEqual(p!.nano, 500 * 1e6);
    assert.strictEqual(p!.canonical, '500m');
  });

  test('milli-CPUs that divide evenly canonicalize to whole CPUs (round-trip safety)', () => {
    const p = parseCpu('2000m');
    assert.ok(p);
    assert.strictEqual(p!.nano, 2 * 1e9);
    assert.strictEqual(p!.canonical, '2', 'matches what formatCpu(nano) reports back');
  });

  test('null / empty → null', () => {
    assert.strictEqual(parseCpu(null), null);
    assert.strictEqual(parseCpu(''), null);
    assert.strictEqual(parseCpu(undefined), null);
  });

  test('garbage and non-positive reject', () => {
    for (const bad of ['abc', '1.5', '-1', 'm', '1.5m']) {
      assert.throws(() => parseCpu(bad), /Invalid cpu format/);
    }
    for (const bad of ['0', '0m']) {
      assert.throws(() => parseCpu(bad), /positive number/);
    }
  });

  test('absurdly long digit strings reject cleanly (no Infinity leak)', () => {
    assert.throws(() => parseCpu('9'.repeat(400)), /positive number/);
  });
});

describe('parseMemory', () => {
  test('binary units (Mi/Gi)', () => {
    assert.deepStrictEqual(parseMemory('128Mi'), { bytes: 128 * 1024 ** 2, canonical: '128Mi' });
    assert.deepStrictEqual(parseMemory('1Gi'), { bytes: 1024 ** 3, canonical: '1Gi' });
  });

  test('SI units canonicalize to the exact whole-MiB value the live inspector reports', () => {
    assert.deepStrictEqual(parseMemory('500M'), { bytes: 500 * 1000 ** 2, canonical: '477Mi' });
    assert.deepStrictEqual(parseMemory('2G'), { bytes: 2 * 1000 ** 3, canonical: '1908Mi' });
  });

  test('plain bytes canonicalize to binary units', () => {
    assert.deepStrictEqual(parseMemory('1048576'), { bytes: 1048576, canonical: '1Mi' });
  });

  test('canonical forms round-trip through formatMemory', () => {
    for (const input of ['128Mi', '1Gi', '512Mi', '500M', '2G', '1048576']) {
      const parsed = parseMemory(input)!;
      assert.strictEqual(formatMemory(parsed.bytes), parsed.canonical, `${input} must round-trip`);
    }
  });

  test('garbage rejects, case-insensitive units accepted', () => {
    assert.deepStrictEqual(parseMemory('128Mi'), parseMemory('128mi'));
    for (const bad of ['abc', '1.5Gi', 'Gi', '128Ki']) {
      assert.throws(() => parseMemory(bad), /Invalid memory format/);
    }
  });

  test('absurdly long digit strings reject cleanly (no Infinity leak)', () => {
    assert.throws(() => parseMemory('9'.repeat(400) + 'M'), /too large/);
  });
});

describe('sanitizeLimitsPatch', () => {
  test('partial patch preserves untouched fields', () => {
    const merged = sanitizeLimitsPatch({ cpu: '2' }, { memory: '128Mi' });
    assert.deepStrictEqual(merged, { cpu: '2', memory: '128Mi' });
  });

  test('null / empty string remove a limit', () => {
    const removed = sanitizeLimitsPatch({ cpu: null }, { cpu: '2', memory: '128Mi' });
    assert.strictEqual(removed.cpu, undefined, 'cpu key is cleared');
    assert.strictEqual(removed.memory, '128Mi', 'untouched memory survives');
    const memRm = sanitizeLimitsPatch({ memory: '' }, { memory: '128Mi' });
    assert.strictEqual(memRm.memory, undefined, 'blank clears memory');
  });

  test('values are canonicalized', () => {
    assert.deepStrictEqual(sanitizeLimitsPatch({ memory: '1G' }), { memory: '954Mi' });
    assert.deepStrictEqual(sanitizeLimitsPatch({ cpu: '2000m' }), { cpu: '2' });
  });

  test('junk raw values throw', () => {
    assert.throws(() => sanitizeLimitsPatch({ cpu: 'many' }), /Invalid cpu format/);
    assert.throws(() => sanitizeLimitsPatch({ memory: 'lotz' }), /Invalid memory format/);
  });
});

describe('limitsEqual / isEmptyLimits', () => {
  test('equal sets', () => {
    assert.ok(limitsEqual({ cpu: '2', memory: '128Mi' }, { cpu: '2', memory: '128Mi' }));
    const both: { a: ProjectLimits; b: ProjectLimits } = { a: {}, b: {} };
    assert.ok(limitsEqual(both.a, both.b));
  });

  test('differing / absent sets', () => {
    assert.ok(!limitsEqual({ cpu: '2' }, { cpu: '3' }));
    assert.ok(!limitsEqual(undefined, { cpu: '2' }));
    assert.ok(limitsEqual(undefined, undefined));
    // A limit vs "unlimited" must never read as equal.
    assert.ok(!limitsEqual({ cpu: null, memory: null }, undefined));
  });

  test('isEmptyLimits', () => {
    assert.ok(isEmptyLimits(undefined));
    assert.ok(isEmptyLimits({}));
    assert.ok(isEmptyLimits({ cpu: null, memory: null }));
    assert.ok(!isEmptyLimits({ cpu: '2' }));
    assert.ok(!isEmptyLimits({ memory: '128Mi' }));
  });
});

describe('checkCeilings', () => {
  test('valid limits pass', async () => {
    await assert.doesNotReject(checkCeilings({ cpu: '4', memory: '4Gi' }, HOST));
  });

  test('cpu above 4× host cores rejects', async () => {
    await assert.rejects(checkCeilings({ cpu: '33' }, HOST), /exceeds host capacity/);
  });

  test('cpu below 0.1 rejects', async () => {
    await assert.rejects(checkCeilings({ cpu: '50m' }, HOST), /too low \(minimum 0\.1\)/);
  });

  test('memory above 90% host RAM rejects', async () => {
    await assert.rejects(checkCeilings({ memory: '15Gi' }, HOST), /exceeds host capacity/);
  });

  test('memory below 32 MiB rejects', async () => {
    await assert.rejects(checkCeilings({ memory: '16Mi' }, HOST), /minimum 32/);
  });

  test('exact boundary values pass', async () => {
    // 8 cores × 4 = 32 exactly; 32 MiB floor exactly; 14 GiB < 14.4 GiB cap.
    await assert.doesNotReject(checkCeilings({ cpu: '32', memory: '32Mi' }, HOST));
    await assert.doesNotReject(checkCeilings({ memory: '14Gi' }, HOST));
  });
});

describe('resolveDefaultLimits', () => {
  test('no env → undefined', async () => {
    delete process.env.WSD_DEFAULT_CPU;
    delete process.env.WSD_DEFAULT_MEMORY;
    assert.strictEqual(await resolveDefaultLimits(), undefined);
  });

  test('env defaults resolve + canonicalize', async () => {
    process.env.WSD_DEFAULT_CPU = '500m';
    process.env.WSD_DEFAULT_MEMORY = '1G';
    try {
      const limits = await resolveDefaultLimits();
      assert.ok(limits);
      assert.strictEqual(limits!.cpu, '500m');
      assert.strictEqual(limits!.memory, '954Mi');
    } finally {
      delete process.env.WSD_DEFAULT_CPU;
      delete process.env.WSD_DEFAULT_MEMORY;
    }
  });

  test('junk / too-small / over-cap defaults throw — caller falls back to unlimited', async () => {
    for (const [cpuEnv, memEnv, pattern] of [
      ['lotz', undefined, /Invalid/],
      [undefined, '16Mi', /minimum 32/],
      [undefined, '999Gi', /exceeds host capacity/],
      [undefined, 'abc', /Invalid/],
    ] as const) {
      if (cpuEnv) process.env.WSD_DEFAULT_CPU = cpuEnv as string;
      else delete process.env.WSD_DEFAULT_CPU;
      if (memEnv) process.env.WSD_DEFAULT_MEMORY = memEnv as string;
      else delete process.env.WSD_DEFAULT_MEMORY;
      await assert.rejects(resolveDefaultLimits(), pattern);
      delete process.env.WSD_DEFAULT_CPU;
      delete process.env.WSD_DEFAULT_MEMORY;
    }
  });
});

describe('formatMemory / formatCpu', () => {
  test('whole binary units', () => {
    assert.strictEqual(formatMemory(128 * 1024 ** 2), '128Mi');
    assert.strictEqual(formatMemory(1024 ** 3), '1Gi');
  });

  test('non-aligned bytes round to whole MiB', () => {
    assert.strictEqual(formatMemory(500 * 1000 ** 2), Math.ceil((500 * 1000 ** 2) / 1024 ** 2) + 'Mi');
  });

  test('formatCpu', () => {
    assert.strictEqual(formatCpu(2 * 1e9), '2');
    assert.strictEqual(formatCpu(500 * 1e6), '500m');
  });
});