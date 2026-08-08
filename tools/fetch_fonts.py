"""Download the woff2 files Toon Anvil's design system uses, for offline use.

The three homebrew source pages pull these from fonts.googleapis.com, which
breaks the moment the app is offline - and "works on a plane / in a basement"
is a requirement here. Self-hosting also removes a third-party request from
every page load.

Fonts: Cinzel (SIL OFL 1.1), Alegreya (SIL OFL 1.1), IBM Plex Mono (SIL OFL 1.1).
Redistribution is permitted under the OFL; see ATTRIBUTION.md.

    python tools/fetch_fonts.py [--force]
"""
from __future__ import annotations

import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "fonts"

# A modern UA is required or the CSS API serves legacy ttf instead of woff2.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

WANTED = [
    ("cinzel-700.woff2",          "Cinzel:wght@700",           "700"),
    ("alegreya-400.woff2",        "Alegreya:wght@400",         "400"),
    ("alegreya-600.woff2",        "Alegreya:wght@600",         "600"),
    ("alegreya-italic-400.woff2", "Alegreya:ital,wght@1,400",  "400"),
    ("plex-mono-400.woff2",       "IBM+Plex+Mono:wght@400",    "400"),
    ("plex-mono-600.woff2",       "IBM+Plex+Mono:wght@600",    "600"),
]


def get(url: str, *, as_text: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    return raw.decode("utf-8") if as_text else raw


def pick_url(css: str, weight: str) -> str | None:
    """Take the latin subset at the requested weight."""
    blocks = re.findall(r"/\*\s*([\w-]+)\s*\*/\s*@font-face\s*\{(.*?)\}", css, re.S)
    candidates = []
    for subset, body in blocks:
        m = re.search(r"src:\s*url\((https://[^)]+\.woff2)\)", body)
        if not m:
            continue
        w = re.search(r"font-weight:\s*(\d+)", body)
        candidates.append((subset, w.group(1) if w else None, m.group(1)))
    for subset, w, url in candidates:
        if subset == "latin" and (w is None or w == weight):
            return url
    for subset, _w, url in candidates:
        if subset == "latin":
            return url
    return candidates[0][2] if candidates else None


def main() -> int:
    force = "--force" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    failed: list[str] = []
    total = 0

    for filename, family, weight in WANTED:
        dest = OUT / filename
        if dest.exists() and not force:
            total += dest.stat().st_size
            print(f"  skip  {filename:<22} {dest.stat().st_size:>8,} B")
            continue
        css_url = f"https://fonts.googleapis.com/css2?family={family}&display=swap"
        try:
            css = get(css_url, as_text=True)
            font_url = pick_url(css, weight)
            if not font_url:
                raise RuntimeError("no woff2 url in css")
            blob = get(font_url)
        except (urllib.error.URLError, RuntimeError) as exc:
            failed.append(f"{filename} ({exc})")
            print(f"  FAIL  {filename:<22} {exc}")
            continue
        dest.write_bytes(blob)
        total += len(blob)
        print(f"  ok    {filename:<22} {len(blob):>8,} B")

    print(f"\ntotal: {total:,} bytes in {OUT}")
    if failed:
        print("\nSome fonts failed. The app still works - design.css falls back to "
              "Impact / Consolas / Georgia.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
