---
description: Prepare a release — semver bump, user-facing changelog, annotated tag and migration notes. Use when work is ready to ship past the last tag.
agent: release-manager
---

Prepare a release:

$ARGUMENTS

Procedure: confirm clean tree + green CI · inventory everything since the last tag grouped Added/Changed/Fixed/Removed/Security · propose the semver bump with one-line reasoning (wait for approval if ambiguous) · draft the changelog entry in user-facing language with breaking-change migration notes · on approval: bump version strings everywhere they live, commit `chore(release): vX.Y.Z`, annotated tag, push with tags, draft gh release. Never tag red or dirty trees; state the rollback path.
