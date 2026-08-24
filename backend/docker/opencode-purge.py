#!/usr/bin/env python3
"""Purge stale WSD-Pro project rows from the opencode SQLite store.

Usage:
  opencode-purge.py <dataDir>             boot mode: purge ALL stale rows
  opencode-purge.py <dataDir> <slug> ...  targeted: only these slugs

A row is stale when its worktree sits under /workspaces/<slug> and no live
meta store exists at <dataDir>/projects/<slug>/meta.json. The global root
instance ('/') is always kept. At boot this runs BEFORE `opencode web`
launches (no locking concerns); at runtime it is best-effort while opencode
is up - WAL plus a busy timeout keep it safe, and any failure is non-fatal
because the next restart re-purges everything.
"""
import os
import sqlite3
import sys

WORKTREE_PREFIX = "/workspaces/"


def stale_slugs(cur, live_dir, targets):
    dead_ids = []
    for pid, worktree in cur.execute("SELECT id, worktree FROM project").fetchall():
        if not isinstance(worktree, str) or not worktree.startswith(WORKTREE_PREFIX):
            continue  # leave the global/root instance alone
        slug = worktree[len(WORKTREE_PREFIX):].split("/")[0]
        if not slug or slug.startswith("."):
            continue
        if targets and slug not in targets:
            continue
        if os.path.isfile(os.path.join(live_dir, slug, "meta.json")):
            continue  # still a live project
        dead_ids.append(pid)
    return dead_ids


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print("usage: opencode-purge.py <dataDir> [slug ...]", file=sys.stderr)
        return 1
    data_dir = args[0]
    targets = {s for s in args[1:] if s}
    db_path = os.path.join(data_dir, "opencode", "opencode", "opencode.db")
    if not os.path.isfile(db_path):
        return 0  # nothing stored yet
    live_dir = os.path.join(data_dir, "projects")
    try:
        con = sqlite3.connect(db_path, timeout=5)
        try:
            cur = con.cursor()
            dead_ids = stale_slugs(cur, live_dir, targets)
            for pid in dead_ids:
                cur.execute(
                    "DELETE FROM project_directory WHERE project_id=?", (pid,)
                )
                cur.execute("DELETE FROM project WHERE id=?", (pid,))
            con.commit()
        finally:
            con.close()
    except Exception as exc:  # non-fatal by design
        print(f"opencode-purge: skipped ({exc})", file=sys.stderr)
        return 0
    print(f"opencode-purge: removed {len(dead_ids)} stale project row(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
