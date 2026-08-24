---
name: debugging-methodology
description: Systematic root-cause debugging — reproduce, isolate, hypothesize, bisect, fix at root, verify with evidence. Use when any misbehavior's cause is unknown. Use PROACTIVELY whenever a "fix" didn't hold or an error resists the obvious explanation.
---

# Debugging Methodology skill

Scope: unknown-cause problems. If you already know the cause and it's a Docker-level issue, use docker-debug; if production is actively down, incident-responder owns containment first.

## The loop
1. **Reproduce reliably** — exact steps; minimize to one. No repro = rumor → gather data, don't guess
2. **Read the real error** — full stack, FIRST occurrence not last echo; logs around the timestamp, not just tail
3. **Isolate the layer** — input correct? transformation correct? output handling correct? Each answer halves the search space
4. **Hypothesize explicitly** — H1/H2/H3 ranked by likelihood × cost-to-test, each with its cheapest killing experiment
5. **Bisect history on regressions** — `git bisect` with known-good commit; else diff against a similar working path
6. **Fix at root** — keep asking "why did invalid state ever arise?" until you hit a design answer
7. **Verify + pin + sweep** — repro passes (evidence shown) · regression test added · siblings of same bug class checked

## Evidence journal (keep while debugging)
| Tried | Expected | Observed | Conclusion |
|---|---|---|---|
Prevents circular debugging; becomes the incident report for free.

**Example**
```
"Uploads fail sometimes"
Journal: tried 10MB ✓ / 100MB ✗ → expected size cap? no, error is ECONNRESET.
Isolation: direct curl vs UI — both fail → not frontend.
Root: proxy body limit, not app code. Fix: raise limit + explicit 413 handling.
```

## Pitfalls
- ❌ Shotgun changes hoping something helps ✅ One hypothesis killed per experiment
- ❌ Silencing the error (null-check the crash) ✅ Fixing why invalid state arose
- ❌ Declaring victory without re-running the ORIGINAL repro ✅ Evidence in the report

Every bug teaches twice: once when found, once when pinned by a test.
