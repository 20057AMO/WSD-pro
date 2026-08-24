---
name: performance-profiling
description: Measure-first performance work — baselining, hotspot profiling, caching with invalidation strategy, before/after proof. Use when something is measurably slow or resource-hungry. Use PROACTIVELY to STOP any "optimization" that lacks a baseline number.
---

# Performance Profiling skill

Scope: making slow things provably faster. The iron rule: **no baseline = no optimization**.

## Step 1 — Baseline honestly
- Match metric to pain: p50/p99 latency · throughput · memory RSS · startup time
- Record environment (hardware, data size, warm/cold)
- ≥3 runs; report the distribution, never the best fantasy run

## Step 2 — Find the real hotspot
Profile before theorizing — intuition is embarrassingly wrong:
- Node: `--cpu-prof`, clinic · UI render loops: DevTools perf panel
- Queries: `EXPLAIN ANALYZE` before/after · containers: `docker stats`

## Decision tree

```
Slow thing confirmed by numbers?
├─ No  → stop here; report numbers; refuse to optimize
└─ Yes → profile → hotspot found?
          ├─ Algorithmic (O(n²))     → fix complexity first, always
          ├─ Repeated pure compute   → cache + EXPLICIT invalidation strategy
          ├─ Many I/O round-trips    → batch / pipeline / reuse connections
          └─ Big allocations/copies  → stream instead of buffer; lazy-load cold paths
```

## Step 3 — Prove it
Re-measure IDENTICALLY to step 1. One change at a time so attribution stays honest. Keep wins; revert non-wins loudly.

**Example**
```
Baseline: GET /api/projects p95=2100ms (40 projects).
Profile: status() docker call PER project inside map = 40 round-trips (N+1).
Change: single `docker ps --format` batch parse → one round-trip.
After: p95=180ms (11.6x). Trade-off accepted: freshness ≤ poll interval.
```

## Pitfalls
- ❌ Optimizing what wasn't measured ✅ Numbers first or no work
- ❌ Cache without invalidation plan ✅ State TTL/event/version strategy or don't cache
- ❌ Micro-tricks on cold paths ✅ Hotspot discipline

Correctness outranks speed — a 10x faster wrong answer is worthless.
