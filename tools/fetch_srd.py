"""Fetch the CC-BY-4.0 SRD 5.2.1 markdown corpus.

Source: https://github.com/downfallx/dnd-5e-srd-markdown
License: Creative Commons Attribution 4.0 International (SRD 5.2.1, Wizards of the Coast LLC)

One-time. Writes to toon-anvil/srd_raw/. Idempotent - skips files already present
unless --force is passed.
"""
from __future__ import annotations

import sys
import urllib.error
import urllib.request
from pathlib import Path

# This box runs a TLS-intercepting AV whose CA cert has non-critical Basic
# Constraints, which OpenSSL rejects outright. truststore defers to the Windows
# certificate store, which accepts it. Same fix the LiveKit work needed.
try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:  # pragma: no cover - falls back to OpenSSL defaults
    print("note: truststore unavailable; TLS may fail behind an intercepting proxy")

REPO = "downfallx/dnd-5e-srd-markdown"
BRANCHES = ("main", "master")

FILES = [
    "LICENSE",
    "README.md",
    "character-creation.md",
    "character-origins.md",
    "classes.md",
    "equipment.md",
    "feats.md",
    "spells.md",
    "magic-items.md",
    "playing-the-game.md",
    "gameplay-toolbox.md",
    "monsters.md",
    "monsters-A-Z.md",
    "animals.md",
    "rules-glossary.md",
]

OUT = Path(__file__).resolve().parent.parent / "srd_raw"


def fetch(path: str, branch: str) -> bytes:
    url = f"https://raw.githubusercontent.com/{REPO}/{branch}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "toon-anvil-srd-fetch"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def main() -> int:
    force = "--force" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)

    branch = None
    for candidate in BRANCHES:
        try:
            fetch("README.md", candidate)
            branch = candidate
            break
        except urllib.error.HTTPError:
            continue
    if branch is None:
        print("FAIL: could not reach the SRD repo on any known branch.", file=sys.stderr)
        return 1
    print(f"branch: {branch}")

    total = 0
    failed: list[str] = []
    for name in FILES:
        dest = OUT / name
        if dest.exists() and not force:
            size = dest.stat().st_size
            total += size
            print(f"  skip  {name:<24} {size:>9,} B (already present)")
            continue
        try:
            blob = fetch(name, branch)
        except urllib.error.HTTPError as exc:
            failed.append(f"{name} (HTTP {exc.code})")
            print(f"  FAIL  {name:<24} HTTP {exc.code}")
            continue
        dest.write_bytes(blob)
        total += len(blob)
        print(f"  ok    {name:<24} {len(blob):>9,} B")

    print(f"\ntotal: {total:,} bytes in {OUT}")
    if failed:
        print(f"failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
