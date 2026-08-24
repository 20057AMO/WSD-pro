---
name: planning-methodology
description: Feature planning workflow — clarify the vertical goal, decompose area-by-area, size tasks for single sessions, ask precise questions before building
---

# Planning Methodology skill

Use when starting any non-trivial feature or change, BEFORE writing code.

## Step 1 — Vertical goal
Write the end result as ONE sentence from the USER's perspective ("admin can X so that Y").
If you cannot, the requirements are not understood yet — do not proceed.

## Step 2 — Reality survey
- Which existing files/layers will this touch? Read them first.
- What conventions apply (patterns, helpers, test styles) that the implementation must reuse?
- What exists that could be extended instead of built new?

## Step 3 — Area-by-area decomposition (بالقطع)
- Split into areas small enough for one focused session each: code + tests + verification + commit
- Order by dependency; mark parallelizable items
- Each area gets its own: build gate run, test run, and commit — never batch unrelated changes

## Step 4 — Question pass
Ask ONLY questions whose answers change what you would build:
1. Scope boundaries: "Should X be included or deliberately excluded?"
2. Behavior on edge: "What should happen when Y fails/is empty/already exists?"
3. Constraints: security, performance, compatibility expectations

## Anti-patterns to refuse
- Starting to code while the goal sentence is still fuzzy
- One giant change touching five areas
- Assuming answers instead of asking when a wrong guess means rework
