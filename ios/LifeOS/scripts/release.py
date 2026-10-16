#!/usr/bin/env python3
"""Publish the current LifeOS version as a GitHub release.

    python3 scripts/release.py [--dry-run]

Run it AFTER `bump-version.py`, the commit and the push: a release is a tag on a commit that
GitHub already has, so this refuses to run with uncommitted changes or unpushed commits. The
title is "LifeOS <VERSION>", the tag is v<VERSION>, and the notes are that version's entry
from CHANGELOG.md.
"""
import argparse, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = ROOT / "VERSION"
CHANGELOG = ROOT / "CHANGELOG.md"


def git(*a: str) -> str:
    return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    version = VERSION.read_text().strip()
    tag = f"v{version}"
    m = re.search(rf"^## {re.escape(version)} — .*?\n(.*?)(?=^## |\Z)", CHANGELOG.read_text(), re.S | re.M)
    if not m:
        sys.exit(f"Nessuna voce {version} in CHANGELOG.md.")
    notes = m.group(1).strip()

    if git("status", "--porcelain", "--", "."):
        sys.exit("Ci sono modifiche non committate in ios/LifeOS: fai commit e push prima della release.")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    try:
        ahead = git("rev-list", "--count", f"origin/{branch}..HEAD")
    except subprocess.CalledProcessError:
        sys.exit(f"Il branch {branch} non ha un corrispondente su origin: fai prima il push.")
    if ahead != "0":
        sys.exit(f"Ci sono {ahead} commit non spinti su origin/{branch}: fai il push prima della release.")

    print(f"Release {tag} su {branch}\n\n{notes}\n")
    if args.dry_run:
        return
    # Two remotes (origin = this repo, upstream = the original project): name the repo explicitly.
    m = re.search(r"github\.com[:/](.+?)(?:\.git)?$", git("remote", "get-url", "origin"))
    repo = m.group(1) if m else sys.exit("Non riesco a leggere il repository da origin.")
    subprocess.run(["gh", "release", "create", tag, "--repo", repo, "--target", branch, "--title", f"LifeOS {version}", "--notes", notes],
                   cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
