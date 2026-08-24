---
description: Full code review of the given scope (diff, files, or feature) with severity-ranked findings
agent: code-reviewer
---

Review the following scope for correctness, security, performance and maintainability:

$ARGUMENTS

If no specific files were named, review the uncommitted changes first (`git status`, `git diff`), falling back to the most recently changed source areas. Deliver findings CRITICAL → LOW with file:line, impact and concrete fixes, list what you verified clean, and end with the ship / fix-first / rework verdict.
