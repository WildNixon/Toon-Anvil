"""Measure what the PDF splitter actually yields, per shelved book.

    python tools/yield_eval.py

README limitation #8 says the classifier is the weak link. This is the ruler
that turns that sentence into numbers, so a change to extraction, stitching or
classification is judged by measurement rather than by eyeball.

Ground truth without hand-labelling
-----------------------------------
Every 5e statblock carries exactly one challenge-rating line ("Challenge 3
(700 XP)" in 2014 documents, "CR 3 (XP 700...)" in 2024 ones). Counting those
lines across a book's EXTRACTED TEXT is therefore a census of statblocks the
extraction saw, independent of whether stitching or classification did
anything useful with them. recall = monsters classified / census.

The census is a floor for what the BOOK contains (text the extractor dropped
is invisible to it), which is the honest direction: real recall can only be
worse, never better, than the number reported here.

Two further signals:
- srdNames: classified monster titles that exactly match a bundled SRD 5.2.1
  monster name - certainty that the title is a real creature, not a fragment.
  (2014/2024 name drift means this undercounts; it is a floor, not a score.)
- acOrphans: blocks containing an "Armor Class N" line that did NOT classify
  as a monster - the fragmentation/refusal signal, i.e. statblock material
  the pipeline saw and lost.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRACTED = ROOT / "library" / "extracted"
MONSTERS = ROOT / "app" / "data" / "compendium" / "monsters.json"

# One line per statblock, both editions. The XP parenthesis (or a lone
# "Challenge N" at line end) keeps prose like "a challenge 3 times per day"
# from counting.
CENSUS = re.compile(
    r"(?:Challenge|CR)\s*:?\s+\d+(?:\s*/\s*\d+)?\s*\((?:XP\s*)?[\d,]+",
    re.I,
)
AC_LINE = re.compile(r"(?:Armor Class|AC)\s*:?\s+\d+", re.I)


def norm_name(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def load_blocks(book_dir: Path) -> dict[str, list[dict]]:
    """Every block the splitter wrote for one book, keyed by kind."""
    out: dict[str, list[dict]] = {}
    for fp in sorted(book_dir.glob("*.json")):
        if fp.name.startswith("_"):
            continue
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, list):
            out[fp.stem] = data
    return out


def eval_book(book_dir: Path, srd_names: set[str]) -> dict:
    kinds = load_blocks(book_dir)
    all_blocks = [b for blocks in kinds.values() for b in blocks
                  if isinstance(b, dict) and "text" in b]

    # Subclass files hold assembled subclasses (features nested), not raw
    # blocks - their text lives under features[].text. Flatten for the census.
    texts = []
    for b in all_blocks:
        texts.append(str(b.get("text", "")))
        for f in b.get("features", []) or []:
            texts.append(str(f.get("text", "")))
    joined = "\n".join(texts)

    monsters = kinds.get("monster", [])
    monster_titles = {norm_name(b.get("title")) for b in monsters}

    census = len(CENSUS.findall(joined))
    ac_blocks = [b for blocks in kinds.items() if blocks[0] != "monster"
                 for b in blocks[1]
                 if isinstance(b, dict) and AC_LINE.search(str(b.get("text", "")))]

    report_fp = book_dir / "_report.json"
    written = {}
    if report_fp.is_file():
        try:
            written = json.loads(report_fp.read_text(encoding="utf-8")) \
                .get("written", {})
        except (OSError, json.JSONDecodeError):
            pass

    return {
        "book": book_dir.name,
        "census": census,
        "monsters": len(monsters),
        "recall": round(len(monsters) / census, 3) if census else None,
        "srdNames": sum(1 for t in monster_titles if t in srd_names),
        "acOrphans": len(ac_blocks),
        "spells": written.get("spell", 0),
        "items": written.get("magic_item", 0),
        "unclassified": written.get("unclassified", 0),
        "totalBlocks": sum(written.values()) if written else len(all_blocks),
    }


def run() -> list[dict]:
    srd = json.loads(MONSTERS.read_text(encoding="utf-8"))
    srd_names = {norm_name(m.get("name")) for m in srd}
    rows = []
    for book_dir in sorted(EXTRACTED.iterdir()):
        if book_dir.is_dir():
            rows.append(eval_book(book_dir, srd_names))
    return rows


def main() -> int:
    rows = run()
    hdr = ("book", "census", "mon", "recall", "srd", "acOrph",
           "spl", "itm", "uncl")
    print("%-34s %6s %4s %6s %4s %6s %4s %4s %5s" % hdr)
    for r in rows:
        print("%-34s %6d %4d %6s %4d %6d %4d %4d %5d" % (
            r["book"][:34], r["census"], r["monsters"],
            ("%.2f" % r["recall"]) if r["recall"] is not None else "-",
            r["srdNames"], r["acOrphans"], r["spells"], r["items"],
            r["unclassified"]))
    tot_c = sum(r["census"] for r in rows)
    tot_m = sum(r["monsters"] for r in rows)
    print()
    print("TOTAL census=%d classified=%d recall=%s" % (
        tot_c, tot_m, ("%.3f" % (tot_m / tot_c)) if tot_c else "-"))
    out = EXTRACTED / "_yield.json"
    out.write_text(json.dumps({"rows": rows}, indent=1), encoding="utf-8")
    print("wrote %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
