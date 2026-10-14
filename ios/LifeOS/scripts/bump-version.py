#!/usr/bin/env python3
"""Bump the LifeOS app version and log it in CHANGELOG.md.

    python3 scripts/bump-version.py <major|minor|patch> [--added TEXT]... [--changed TEXT]... [--fixed TEXT]...

Rules (see the legend in CHANGELOG.md): exactly one level goes up by exactly 1 and every level
below it resets to 0, so 1.0.0 can only become 2.0.0, 1.1.0 or 1.0.1 — never 5.0.1.
VERSION is the single source of truth; this script also writes project.yml (marketing version +
a build number that rises on every bump) and regenerates the Xcode project.
"""
import argparse, datetime, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = ROOT / "VERSION"
CHANGELOG = ROOT / "CHANGELOG.md"
PROJECT = ROOT / "project.yml"
MARKER = "<!-- nuove versioni sotto questa riga -->"


def bump(current: str, level: str) -> str:
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", current)
    if not m:
        sys.exit(f"VERSION non valido: {current!r} (atteso X.Y.Z)")
    major, minor, patch = map(int, m.groups())
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("level", choices=["major", "minor", "patch"])
    ap.add_argument("--added", action="append", default=[], metavar="TEXT", help="novità (ripetibile)")
    ap.add_argument("--changed", action="append", default=[], metavar="TEXT", help="modifiche a cose esistenti")
    ap.add_argument("--fixed", action="append", default=[], metavar="TEXT", help="correzioni di errori")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not (args.added or args.changed or args.fixed):
        sys.exit("Serve almeno una voce: --added / --changed / --fixed.")

    current = VERSION.read_text().strip()
    new = bump(current, args.level)

    project = PROJECT.read_text()
    build_m = re.search(r'CURRENT_PROJECT_VERSION: "(\d+)"', project)
    build = int(build_m.group(1)) + 1 if build_m else 1

    lines = [f"## {new} — {datetime.date.today().isoformat()}", ""]
    for title, items in (("Aggiunto", args.added), ("Modificato", args.changed), ("Corretto", args.fixed)):
        if items:
            lines.append(f"**{title}**")
            lines += [f"- {t}" for t in items]
            lines.append("")
    entry = "\n".join(lines)

    if args.dry_run:
        print(f"{current} -> {new} (build {build})\n\n{entry}")
        return

    text = CHANGELOG.read_text()
    if MARKER not in text:
        sys.exit(f"Marcatore non trovato in CHANGELOG.md: {MARKER}")
    CHANGELOG.write_text(text.replace(MARKER, f"{MARKER}\n\n{entry}", 1))
    VERSION.write_text(new + "\n")
    project = re.sub(r'MARKETING_VERSION: "[^"]*"', f'MARKETING_VERSION: "{new}"', project)
    project = re.sub(r'CURRENT_PROJECT_VERSION: "\d+"', f'CURRENT_PROJECT_VERSION: "{build}"', project)
    PROJECT.write_text(project)
    subprocess.run(["xcodegen", "generate"], cwd=ROOT, check=False, stdout=subprocess.DEVNULL)
    print(f"{current} -> {new} (build {build})")


if __name__ == "__main__":
    main()
