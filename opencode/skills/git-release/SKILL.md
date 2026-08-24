---
name: git-release
description: Prepare releases — changelogs, version bumps and tagged GitHub releases following consistent conventions
---

# Git Release skill

Use when preparing a tagged release for the current repository.

## Procedure
1. **Inventory changes**: `git log --oneline $(git describe --tags --abbrev=0)..HEAD` — summarize merged work by category (feat/fix/docs/chore)
2. **Propose the version bump** BEFORE changing anything:
   - Breaking change / behavior removal → MAJOR
   - New user-visible capability → MINOR
   - Fixes and internal work only → PATCH
   - State the reasoning in one line; wait for approval if ambiguous
3. **Draft the changelog** entry: newest first, grouped `### Added / ### Changed / ### Fixed`, each line user-facing ("Add X" not "refactor X handling")
4. **After approval only**:
   - Update the version field(s) the project actually uses
   - Commit as `chore(release): vX.Y.Z`
   - Tag annotated: `git tag -a vX.Y.Z -m "vX.Y.Z"`
   - Push with tags: `git push && git push --tags`
   - If `gh` is available: draft the release from the changelog section

## Guardrails
- Never rewrite published tags or force-push release branches
- Never include uncommitted working-tree changes in a release commit
