---
name: performance-profiling
description: Measure-first performance work — baselining, hotspot profiling, caching with invalidation strategy, before/after proof
---

# Performance Profiling skill

Use when something is slow — or about to be optimized "just in case" (don't).

## The iron rule
No baseline = no optimization. Numbers first, always.

## Step 1 — Baseline honestly
- Pick the metric that matches the pain: p50/p99 latency, throughput, memory RSS, startup time
- Record environment: hardware, data size, warm/cold
- Repeat ≥3 runs; report the distribution, not the best fantasy run

## Step 2 — Find the real hotspot
- Profile before theorizing; intuition is wrong embarrassingly often
- Stack-appropriate tools: Node `--cpu-prof`/clinic · Chrome DevTools perf panel for UI render loops · `EXPLAIN ANALYZE` for queries · Docker `stats` for container pressure
- Follow one suspicious path end-to-end before optimizing it

## Step 3 — Playbook in preference order
1. **Algorithmic** — O(n²)→O(n log n) beats every micro-trick
2. **Caching** — only pure/repeatable computation; state invalidation explicitly (TTL? event-driven? version bump?) or do not cache
3. **Batching/pipelining** — kill N+1s, amortize round-trips, reuse connections/clients
4. **Allocation hygiene** — stream big payloads instead of buffering; reuse buffers; lazy-load cold paths

## Step 4 — Prove it
Re-measure identically to step 1. Keep wins, revert non-wins. One change at a time so attribution stays honest.

## Output format
| Change | Before | After | How measured | Trade-off accepted |
Correctness outranks speed; a 10x faster wrong answer is worthless.
