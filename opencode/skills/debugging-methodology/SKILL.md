---
name: debugging-methodology
description: Systematic root-cause debugging — reproduce, isolate, hypothesize, bisect, fix at root, verify with evidence
---

# Debugging Methodology skill

Use when anything misbehaves and the cause is unknown.

## The loop
1. **Reproduce reliably** — exact steps/commands; minimize until one step. No repro = rumor, keep gathering
2. **Read the real error** — full stack, first occurrence not the last echo; check logs around the timestamp, not just the tail
3. **Isolate the layer** — binary-search the pipeline: input correct? transformation correct? output handling correct? Each yes/no halves the search space
4. **Hypothesize explicitly** — write H1/H2/H3 ranked by likelihood × cost-to-test; design the cheapest experiment that kills each
5. **Bisect history when regression** — known-good commit exists → `git bisect`; no known-good → diff behavior against similar working paths
6. **Fix at root** — ask "why did this value/state ever become invalid?" until reaching a design answer, then fix THAT
7. **Verify + pin** — demonstrate original repro now passes; add regression test; sweep for sibling bugs of the same class

## Evidence journal (keep while debugging)
| Tried | Expected | Observed | Conclusion |
|---|---|---|---|
This prevents circular debugging and becomes the incident report.

## Traps to refuse
- Shotgun changes hoping something helps
- Fixing the symptom (silencing the error) instead of the cause
- Declaring victory without re-running the original repro
