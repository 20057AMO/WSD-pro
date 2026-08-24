---
name: planning-methodology
description: Feature planning workflow — vertical-goal clarity, area-by-area decomposition, session-sized tasks, precise questions. Use when starting any non-trivial feature. Use PROACTIVELY whenever a request is bigger than a one-line fix or mixes multiple concerns.
---

# Planning Methodology skill

Scope: BEFORE code exists. Once implementation starts, switch to the relevant specialist; come back here if scope grows mid-task.

## Step 1 — Vertical goal
Write the end result as ONE sentence from the USER's perspective ("admin can X so that Y"). Cannot? Requirements aren't understood — do not proceed.

## Step 2 — Reality survey
- Which existing files/layers does this touch? Read them first
- Which conventions/helpers/tests must the implementation reuse?
- What exists that could be extended instead of built new?

## Step 3 — Area-by-area decomposition (بالقطع)
Split into areas sized for ONE focused session each (code+tests+verify+commit). Order by dependency; mark parallelizable items. Each area ships independently.

## Decision tree

```
Request arrives
├─ One-line, single-file change → skip planning, just do it well
├─ Multi-file but one concern   → 3-question check below, then build
└─ Multiple concerns / unclear scope → full steps 1-4 before any edit
```

## Step 4 — Question pass
Ask ONLY questions whose answers change what you would build:
1. Scope: "Is X included or deliberately excluded?"
2. Edges: "What happens when Y fails / is empty / already exists?"
3. Constraints: security, performance, compatibility expectations?

**Example**
Input: "add project templates"
Question that matters: "Must templates include running post-create scripts, or files only?" — doubles the design either way.
Output: goal sentence + 4 session-sized areas (schema → backend CRUD → UI picker → docs), each with its own gate run.

## Pitfalls
- ❌ Coding while the goal sentence is fuzzy ✅ One more clarifying exchange
- ❌ One giant change across five areas ✅ Five shippable commits
- ❌ Assuming answers when a wrong guess means rework ✅ Ask the question

An hour of planning questions saves a week of rebuilding the wrong thing.
