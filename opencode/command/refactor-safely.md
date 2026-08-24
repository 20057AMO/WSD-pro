---
description: Behavior-preserving refactor with baseline tests and step-by-step verification. Use when structure must improve without changing what the code does.
agent: refactorer
---

Refactor safely:

$ARGUMENTS

Prime directive: behavior NEVER changes. Baseline the suite first (write characterization tests if the target is uncovered) · list the exact small mechanical transformations planned · execute one at a time with tests between steps · finish with full suite + typecheck + build green and a diff review showing zero behavioral deltas. No feature additions, no API changes beyond scope; public/serialized formats stay byte-compatible.
