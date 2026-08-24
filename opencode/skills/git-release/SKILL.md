---
name: git-release
description: Prepare versioned releases — semver bumps, user-facing changelogs, annotated tags, migration notes. Use when shipping a release or hotfix. Use PROACTIVELY when merged work has piled up past the last tag or a breaking change just landed.
---

# Git Release skill

Scope: cutting tagged releases for the current repository. NOT for daily commits — those follow the project's commit discipline; come here when work needs to SHIP.

## Decision tree

```
Need to ship
├─ Breaking API/config/data change → MAJOR + migration notes mandatory
├─ User-visible additions only     → MINOR
├─ Fixes/internal only             → PATCH
└─ Production bug RIGHT NOW        → hotfix path: branch FROM tag, fix, re-tag
```

## Procedure
1. **Inventory**: `git log --oneline $(git describe --tags --abbrev=0)..HEAD` grouped Added/Changed/Fixed/Removed/Security
2. **Propose bump BEFORE changing anything** — one-line reasoning; ask if ambiguous
3. **Draft changelog**: newest first, `### Added / Changed / Fixed` sections, each line USER-facing ("Add X" not "refactor X handling")
4. **On approval only**:
   - Update every version field the project uses (search the old string everywhere)
   - Commit `chore(release): vX.Y.Z`
   - Annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`
   - `git push && git push --tags`; draft gh release from changelog if available

## Quick start
```sh
git log --oneline $(git describe --tags --abbrev=0)..HEAD   # what ships
git tag -a v1.2.0 -m "v1.2.0" && git push --tags            # after suite green
```

## Pitfalls
- ❌ Tagging with dirty tree or red CI ✅ Suite green at the EXACT commit being tagged
- ❌ Force-pushing release branches / rewriting published tags ✅ Hotfix branch from the tag instead
- ❌ Changelog written for committers ✅ Written for users — "what changed for me?"

## Verification gate
Clean tree · full suite green at release commit · build succeeds fresh · rollback path stated (previous tag, migration reversibility).

A release nobody can roll back is a bet, not a release.
