"""Copy app/ into extension/app/ so the Chrome side panel ships the same code.

    python sync_extension.py

Why a copy rather than an iframe of localhost: the side panel should work when
serve.py is not running. The tradeoff is that the extension is a DIFFERENT
ORIGIN from the installed PWA, so their IndexedDB stores are separate.

That is exactly what the "shared server" data source exists to solve - with
serve.py running, both surfaces read and write the same JSON files on disk and
you see one dataset. Local mode gives you two.

The service worker is deliberately NOT copied: MV3 extensions cannot register
one from a page, and the extension is already served from local files.
"""
from __future__ import annotations

import filecmp
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "app"
DEST = ROOT / "extension" / "app"

SKIP_NAMES = {"sw.js"}
SKIP_SUFFIXES = {".map"}


def should_copy(path: Path) -> bool:
    if path.name in SKIP_NAMES:
        return False
    if path.suffix in SKIP_SUFFIXES:
        return False
    return True


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 1

    copied = changed = skipped = 0
    for src in SRC.rglob("*"):
        if src.is_dir():
            continue
        if not should_copy(src):
            skipped += 1
            continue
        rel = src.relative_to(SRC)
        dest = DEST / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and filecmp.cmp(src, dest, shallow=False):
            copied += 1
            continue
        shutil.copy2(src, dest)
        copied += 1
        changed += 1

    # Remove files that no longer exist in app/, or the extension slowly rots.
    removed = 0
    if DEST.exists():
        for stale in DEST.rglob("*"):
            if stale.is_dir():
                continue
            rel = stale.relative_to(DEST)
            if not (SRC / rel).exists():
                stale.unlink()
                removed += 1

    print(f"synced {copied} files ({changed} updated, {removed} removed, "
          f"{skipped} skipped) -> {DEST}")
    print("\nLoad it in Chrome:")
    print("  chrome://extensions -> Developer mode -> Load unpacked")
    print(f"  {ROOT / 'extension'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
