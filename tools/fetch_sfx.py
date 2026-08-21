#!/usr/bin/env python3
"""Build the vendored sound-effects pack from Kenney's CC0 audio packs.

Kenney's download links are hashed behind each asset page, so this does not
fetch anything: download the zips yourself (they are about a megabyte each),
unzip them into one folder, and point this at it. It copies ONLY the clips
named in PICKS, trims and normalises each with ffmpeg into a small mono MP3,
and writes assets/sfx/manifest.json naming where every file came from and
what was done to it. ATTRIBUTION.md's "Sound effects" section mirrors that.

MP3 rather than OGG because iPhones do not play OGG. Mono, 44.1 kHz, 64 kbps:
a short sting is a few kilobytes, the whole pack well under the 400 KB the
gym holds it to.

    python tools/fetch_sfx.py <folder with the unzipped kenney_* packs>

Every pack used here is Creative Commons Zero (the License.txt in each zip
says so); the manifest records that per file rather than per pack.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "assets" / "sfx"
BUDGET_BYTES = 400_000
PER_FILE_BYTES = 60_000

# Pack folder (as unzipped) -> source page. Author for all of them is
# Kenney Vleugels (Kenney.nl), licence CC0-1.0.
PACKS = {
    "kenney_casino-audio": "https://kenney.nl/assets/casino-audio",
    "kenney_impact-sounds": "https://kenney.nl/assets/impact-sounds",
    "kenney_interface-sounds": "https://kenney.nl/assets/interface-sounds",
    "kenney_music-jingles": "https://kenney.nl/assets/music-jingles",
    "kenney_rpg-audio": "https://kenney.nl/assets/rpg-audio",
}

# sting id -> (pack folder, clip name without extension, max seconds)
# Picked by duration and character, not by name alone: many Kenney clips are
# a tenth of a second long (bong_001 is a click, not a bong). The ones here
# ring, rattle or rise long enough to register from a phone on a table.
PICKS = {
    "dice": ("kenney_casino-audio", "dice-throw-1", 1.0),        # several dice, 0.63s
    "crit": ("kenney_impact-sounds", "impactBell_heavy_000", 1.6),  # the long bell, 1.48s
    "fumble": ("kenney_impact-sounds", "impactSoft_heavy_001", 0.8),
    "hit": ("kenney_impact-sounds", "impactPunch_heavy_001", 0.7),
    "heal": ("kenney_interface-sounds", "confirmation_004", 0.7),
    "downed": ("kenney_impact-sounds", "impactPlate_heavy_002", 0.8),
    "death-tick": ("kenney_impact-sounds", "impactSoft_heavy_000", 0.7),
    "revive": ("kenney_music-jingles", "jingles_PIZZI12", 1.4),
    "your-turn": ("kenney_interface-sounds", "question_001", 0.7),   # a rising two-note ask
    "round": ("kenney_rpg-audio", "metalPot1", 1.6),                 # the gong, 1.46s
    "session-start": ("kenney_music-jingles", "jingles_PIZZI03", 1.5),
    "table-closed": ("kenney_interface-sounds", "minimize_004", 0.6),
    "level-up": ("kenney_music-jingles", "jingles_PIZZI07", 1.6),
    "clock-tick": ("kenney_rpg-audio", "metalLatch", 0.4),
    "clock-strike": ("kenney_impact-sounds", "impactBell_heavy_002", 1.0),
    "spell-cast": ("kenney_interface-sounds", "glass_004", 0.9),
    "rest-long": ("kenney_rpg-audio", "doorClose_1", 0.9),          # a door shut for the night
}


def find_clip(packs_dir: Path, pack: str, name: str) -> Path | None:
    base = packs_dir / pack
    for ext in (".ogg", ".wav", ".mp3"):
        hits = list(base.rglob(name + ext))
        if hits:
            return hits[0]
    return None


def convert(src: Path, dst: Path, seconds: float) -> float:
    """ffmpeg: trim, strip leading silence, normalise, fade the tail."""
    fade_start = max(0.05, seconds - 0.06)
    filters = (
        "silenceremove=start_periods=1:start_threshold=-50dB,"
        "loudnorm=I=-16:TP=-1.5:LRA=11,"
        f"afade=t=out:st={fade_start:.2f}:d=0.06"
    )
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-t", f"{seconds:.2f}",
        "-af", filters, "-ac", "1", "-ar", "44100",
        "-c:a", "libmp3lame", "-b:a", "64k", str(dst),
    ]
    subprocess.run(cmd, check=True)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(dst)],
        capture_output=True, text=True, check=True)
    return float(probe.stdout.strip() or 0)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    packs_dir = Path(argv[1]).resolve()
    if shutil.which("ffmpeg") is None:
        print("ffmpeg is not on PATH - install it, or use tools/make_sfx.py instead")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    files = []
    total = 0
    for sting, (pack, name, seconds) in PICKS.items():
        src = find_clip(packs_dir, pack, name)
        if src is None:
            print(f"  MISSING {sting}: {pack}/{name}")
            return 1
        dst = OUT / f"{sting}.mp3"
        length = convert(src, dst, seconds)
        size = dst.stat().st_size
        total += size
        flag = "" if size <= PER_FILE_BYTES else "  (over the per-file cap!)"
        print(f"  {sting:14s} <- {pack}/{src.name:28s} {length:4.2f}s {size:6d} B{flag}")
        files.append({
            "id": sting,
            "file": dst.name,
            "bytes": size,
            "seconds": round(length, 3),
            "source": PACKS[pack],
            "pack": pack,
            "original": src.name,
            "author": "Kenney Vleugels (Kenney.nl)",
            "licence": "CC0-1.0",
            "processing": (
                f"trimmed to {seconds:.1f}s, leading silence removed, "
                "loudness normalised to -16 LUFS, 60 ms fade, mono 44.1 kHz MP3 64 kbps"
            ),
        })

    manifest = {
        "version": 1,
        "licence": "CC0-1.0",
        "note": (
            "Every file here is a trimmed, normalised MP3 of a clip from a "
            "Kenney.nl CC0 pack. ATTRIBUTION.md carries the same list."
        ),
        "files": files,
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\n{len(files)} files, {total:,} bytes total "
          f"({'within' if total <= BUDGET_BYTES else 'OVER'} the {BUDGET_BYTES:,} B budget)")
    return 0 if total <= BUDGET_BYTES else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
