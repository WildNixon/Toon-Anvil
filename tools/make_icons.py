"""Render Toon Anvil's PNG icons.

The SVG at app/icons/icon.svg is the master, but PWA manifests and Chrome
extensions still want PNGs. PIL cannot rasterise SVG, so the same artwork -
a closed book with an orange spine and a d20 face - is drawn with primitives.

    python tools/make_icons.py
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"

IRON = (28, 33, 36, 255)
MOLTEN = (184, 74, 22, 255)
STEEL = (210, 214, 211, 255)
PLATE = (192, 198, 196, 255)
SLAG = (58, 66, 71, 255)
VERDIGRIS = (47, 107, 98, 255)

SS = 4  # supersample factor - draw big, downscale for clean edges


def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    """Flat-topped hexagon: the classic d20 silhouette."""
    pts = []
    for i in range(6):
        angle = math.radians(60 * i - 90)
        pts.append((cx + r * math.sin(angle + math.pi / 2) * 0.866,
                    cy - r * math.cos(angle + math.pi / 2) * 0.866))
    return [
        (cx, cy - r), (cx + r * 0.866, cy - r * 0.5),
        (cx + r * 0.866, cy + r * 0.5), (cx, cy + r),
        (cx - r * 0.866, cy + r * 0.5), (cx - r * 0.866, cy - r * 0.5),
    ]


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Maskable icons get cropped to a circle by the launcher, so keep the art
    # inside the safe zone (the middle 80%) and bleed the background to edges.
    pad = s * 0.14 if maskable else 0
    radius = 0 if maskable else s * 0.14
    d.rounded_rectangle([0, 0, s, s], radius=radius, fill=IRON)

    inner = s - pad * 2
    x0 = pad + inner * 0.16
    y0 = pad + inner * 0.16
    x1 = pad + inner * 0.86
    y1 = pad + inner * 0.84

    # spine
    d.rectangle([x0, y0, x0 + inner * 0.075, y1], fill=MOLTEN)
    # pages
    d.rounded_rectangle([x0 + inner * 0.075, y0, x1, y1],
                        radius=inner * 0.035, fill=STEEL)
    # top edge shading
    d.rectangle([x0 + inner * 0.075, y0, x1, y0 + inner * 0.07], fill=PLATE)

    # d20 face
    cx = (x0 + inner * 0.075 + x1) / 2
    cy = (y0 + y1) / 2 + inner * 0.02
    r = inner * 0.235
    hexa = hexagon(cx, cy, r)
    d.polygon(hexa, fill=IRON)

    top = (cx, cy - r)
    ur = (cx + r * 0.866, cy - r * 0.5)
    lr = (cx + r * 0.866, cy + r * 0.5)
    bot = (cx, cy + r)
    ll = (cx - r * 0.866, cy + r * 0.5)
    ul = (cx - r * 0.866, cy - r * 0.5)
    c = (cx, cy)

    d.polygon([top, ur, c, ul], fill=VERDIGRIS)
    d.polygon([c, ur, lr], fill=SLAG)
    d.polygon([c, lr, bot], fill=MOLTEN)
    d.polygon([c, bot, ll], fill=SLAG)
    d.polygon([c, ll, ul], fill=VERDIGRIS)

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-128.png", 128, False),
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable.png", 512, True),
    ]
    for name, size, maskable in targets:
        img = draw_icon(size, maskable)
        path = OUT / name
        img.save(path, "PNG", optimize=True)
        print(f"  wrote {name:<22} {size}x{size}  {path.stat().st_size:>7,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
