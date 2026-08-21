#!/usr/bin/env python3
"""The no-download fallback: author the sound-effects pack from nothing.

tools/fetch_sfx.py builds app/assets/sfx/ from Kenney's CC0 recordings and is
what the shipped pack came from. This script exists for a checkout that has
no such zips to hand: it synthesises the same seventeen stings with numpy -
filtered noise bursts with exponential decays for the dice and the hits,
sine-with-harmonics bells for the round and the clock, short arpeggios for
the ceremonies, low thumps for going down - writes them as WAV, then runs
the same ffmpeg recipe fetch_sfx.py uses, and writes a manifest whose author
is "Toon Anvil (synthesised)". CC0 by construction: nothing here was ever
anybody's recording.

Stylised rather than real, and it says so in the manifest. Seeded, so the
pack is the same pack every time.

    python tools/make_sfx.py
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "assets" / "sfx"
RATE = 44100
rng = np.random.default_rng(20260821)


def env(n: int, attack: float = 0.004, decay: float = 0.3) -> np.ndarray:
    """A percussive envelope: quick attack, exponential decay, in samples."""
    t = np.arange(n) / RATE
    a = np.minimum(1.0, t / max(attack, 1e-4))
    return a * np.exp(-t / max(decay, 1e-3))


def tone(freq: float, seconds: float, harmonics=(1.0,), decay: float = 0.4) -> np.ndarray:
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    out = np.zeros(n)
    for k, amp in enumerate(harmonics, start=1):
        out += amp * np.sin(2 * math.pi * freq * k * t) * np.exp(-t * k / decay)
    return out * env(n, 0.003, decay)


def noise(seconds: float, decay: float, lowpass: float = 0.0) -> np.ndarray:
    n = int(seconds * RATE)
    x = rng.standard_normal(n)
    if lowpass > 0:
        # A one-pole lowpass: enough to turn hiss into a thud.
        alpha = math.exp(-2 * math.pi * lowpass / RATE)
        y = np.zeros(n)
        acc = 0.0
        for i in range(n):
            acc = alpha * acc + (1 - alpha) * x[i]
            y[i] = acc
        x = y * (1 / max(1e-6, np.abs(y).max()))
    return x * env(n, 0.002, decay)


def arpeggio(freqs, step: float = 0.11, hold: float = 0.5) -> np.ndarray:
    total = int((step * len(freqs) + hold) * RATE)
    out = np.zeros(total)
    for i, f in enumerate(freqs):
        start = int(i * step * RATE)
        note = tone(f, hold, harmonics=(1.0, 0.35, 0.15), decay=0.35)
        end = min(total, start + len(note))
        out[start:end] += note[: end - start]
    return out


def dice() -> np.ndarray:
    # Several small clicks tumbling: short noise bursts, spaced unevenly.
    out = np.zeros(int(0.6 * RATE))
    t = 0.0
    for i in range(7):
        burst = noise(0.05, 0.012, lowpass=2400) * (0.9 - i * 0.08)
        start = int(t * RATE)
        out[start:start + len(burst)] += burst[: len(out) - start]
        t += 0.045 + 0.03 * rng.random()
    return out


STINGS = {
    "dice": dice,
    "crit": lambda: tone(880, 1.4, harmonics=(1.0, 0.5, 0.25, 0.12), decay=0.5)
                    + 0.4 * tone(1320, 1.0, harmonics=(1.0, 0.3), decay=0.35),
    "fumble": lambda: noise(0.5, 0.09, lowpass=300),
    "hit": lambda: noise(0.35, 0.05, lowpass=900) + 0.5 * tone(160, 0.25, decay=0.08),
    "heal": lambda: arpeggio([523.25, 659.25, 783.99], step=0.09, hold=0.45),
    "downed": lambda: noise(0.6, 0.16, lowpass=220) + 0.6 * tone(90, 0.5, decay=0.2),
    "death-tick": lambda: tone(70, 0.3, harmonics=(1.0, 0.3), decay=0.12),
    "revive": lambda: arpeggio([392.0, 523.25, 659.25, 783.99, 1046.5], step=0.1, hold=0.6),
    "your-turn": lambda: arpeggio([659.25, 880.0], step=0.12, hold=0.4),
    "round": lambda: tone(196, 1.3, harmonics=(1.0, 0.6, 0.3, 0.2, 0.1), decay=0.7),
    "session-start": lambda: arpeggio([392.0, 493.88, 587.33, 783.99], step=0.13, hold=0.7),
    "table-closed": lambda: arpeggio([587.33, 440.0], step=0.14, hold=0.4),
    "level-up": lambda: arpeggio([523.25, 659.25, 783.99, 1046.5, 1318.5], step=0.1, hold=0.7),
    "clock-tick": lambda: noise(0.08, 0.015, lowpass=3000) + 0.5 * tone(2400, 0.05, decay=0.02),
    "clock-strike": lambda: tone(440, 1.0, harmonics=(1.0, 0.5, 0.3), decay=0.45),
    "spell-cast": lambda: tone(1760, 0.7, harmonics=(1.0, 0.2), decay=0.25)
                          + 0.3 * noise(0.6, 0.15, lowpass=6000),
    "rest-long": lambda: arpeggio([261.63, 196.0], step=0.25, hold=0.8),
}


def write_wav(path: Path, samples: np.ndarray) -> None:
    peak = float(np.abs(samples).max()) or 1.0
    pcm = (np.clip(samples / peak, -1, 1) * 32000).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


def to_mp3(src: Path, dst: Path) -> None:
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ac", "1", "-ar", "44100",
        "-c:a", "libmp3lame", "-b:a", "64k", str(dst),
    ], check=True)


def main() -> int:
    if shutil.which("ffmpeg") is None:
        print("ffmpeg is not on PATH; it is needed to encode the MP3s")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "_wav"
    tmp.mkdir(exist_ok=True)
    files = []
    total = 0
    for sting, make in STINGS.items():
        samples = make()
        wav = tmp / f"{sting}.wav"
        write_wav(wav, samples)
        dst = OUT / f"{sting}.mp3"
        to_mp3(wav, dst)
        size = dst.stat().st_size
        total += size
        print(f"  {sting:14s} {len(samples) / RATE:4.2f}s {size:6d} B")
        files.append({
            "id": sting, "file": dst.name, "bytes": size,
            "seconds": round(len(samples) / RATE, 3),
            "source": "https://github.com/WildNixon/Toon-Anvil/blob/main/tools/make_sfx.py",
            "pack": "synthesised", "original": wav.name,
            "author": "Toon Anvil (synthesised)", "licence": "CC0-1.0",
            "processing": "numpy synthesis, loudness normalised to -16 LUFS, mono 44.1 kHz MP3 64 kbps",
        })
    shutil.rmtree(tmp, ignore_errors=True)
    (OUT / "manifest.json").write_text(json.dumps({
        "version": 1, "licence": "CC0-1.0",
        "note": "Synthesised by tools/make_sfx.py - stylised, not recorded. CC0 by construction.",
        "files": files,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"\n{len(files)} files, {total:,} bytes total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
