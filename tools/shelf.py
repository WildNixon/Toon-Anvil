"""shelf.py - the library shelf: detect what a PDF is, file it, extract it.

The inbox answers "how do I get a file in"; the shelf answers "where do the
books LIVE". Every source PDF gets one home under library/shelf/<category>/,
a manifest entry keyed by content hash, and an extraction under
library/extracted/<slug>/ - so dropping the same book twice is a no-op and
the app can list a DM's whole collection by what each book is FOR.

Categories:
    settings    - campaign settings (feed the Deck: regions, factions, lore)
    adventures  - modules and one-shots (also Deck material)
    options     - player options: UA, subclass/spell/feat archives (workshop)
    bestiaries  - monster books (workshop)
    unsorted    - the detector could not tell; refile by hand, one click

The detector is pure and deterministic - filename rules first, then keyword
scoring over a few sampled pages. It prefers an honest "unsorted" over a
confident wrong guess, and always says WHY in its evidence list.

Usage:
    python tools/shelf.py --dry <files-or-folders...>       classify, no writes
    python tools/shelf.py --seed-existing <files...>        record hashes of
                                            already-extracted books (run FIRST,
                                            or --apply re-splits them)
    python tools/shelf.py --apply <files-or-folders...>     move + extract
    python tools/shelf.py --selftest                        detector + shelving

Folders are searched one level deep (*.pdf, non-recursive). Run --apply with
the app server STOPPED: a browsing tab rewrites the manifest.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = ROOT / "library"
EXTRACTED = LIBRARY / "extracted"
SHELF = LIBRARY / "shelf"
MANIFEST = LIBRARY / "_manifest.json"

CATEGORIES = ("settings", "adventures", "options", "bestiaries", "unsorted")


def default_paths() -> dict:
    return {"shelf": SHELF, "extracted": EXTRACTED, "manifest": MANIFEST}


# --------------------------------------------------------------------------
# small shared helpers (same formats serve.py uses; kept standalone so the
# CLI works without importing the server)
# --------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def slug_for(name: str) -> str:
    # Identical to split_pdf.py's stem slug, so shelf entries and extraction
    # folders always agree on a document's identity.
    return re.sub(r"[^A-Za-z0-9._-]+", "-", Path(name).stem).strip("-")


def read_manifest(paths: dict | None = None) -> dict:
    p = (paths or default_paths())["manifest"]
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"processed": {}}


def write_manifest(man: dict, paths: dict | None = None) -> None:
    p = (paths or default_paths())["manifest"]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(man, ensure_ascii=False, indent=1),
                 encoding="utf-8")


# --------------------------------------------------------------------------
# the detector
# --------------------------------------------------------------------------
#
# Stage 1: filename rules - cheap and precise (AL module codes, "Plane Shift",
# "Monster Manual", UA prefixes). First match wins.
#
# Stage 2: keyword scores over sampled page text. Weights were calibrated
# against the thirteen real books this shipped with (see --selftest): the
# generic phrase "dungeon master" is deliberately ABSENT - it appears in
# every book's boilerplate and once mis-scored the Monster Manual as an
# adventure - and the adventure signal is "adventure for", not "an adventure
# for", because covers say "A Rat Queens adventure for 3rd-level characters".

FILENAME_RULES = (
    (r"^(ddex|ddal|ddhc|ddep|ddia|ccc|dra)[-_ ]?\d", "adventures", 0.95),
    (r"plane[-_ ]?shift", "settings", 0.90),
    (r"monster manual|bestiary|monstrous|creature codex|tome of beasts",
     "bestiaries", 0.95),
    # \bUA\b would miss "UA_Waterborne" - the underscore is a word character.
    (r"^(dnd)?ua[-_0-9]|unearthed", "options", 0.90),
    (r"subclass|archetype|player'?s? (option|companion)", "options", 0.85),
)

CONTENT_SIGNALS = {
    "settings": (
        (r"gazetteer", 3), (r"the world of", 2), (r"the plane of", 2),
        (r"pantheon", 2), (r"geography", 2), (r"\bcultures?\b", 1),
        (r"its people", 1), (r"\bnations?\b", 1), (r"\bdeit(y|ies)\b", 1),
    ),
    "adventures": (
        (r"adventurers league", 3), (r"adventure for", 3),
        (r"read[- ]?aloud", 3), (r"for characters of", 3),
        (r"boxed text", 2), (r"\bone[- ]shot\b", 2), (r"\bencounters?\b", 1),
    ),
    "options": (
        (r"unearthed arcana", 3), (r"playtest", 3), (r"\bsubclass(es)?\b", 2),
        (r"\barchetypes?\b", 2), (r"at 3rd level", 2), (r"new spells", 2),
        (r"when you (choose|reach)", 1), (r"\bfeats?\b", 1),
    ),
}

# Bestiaries are a density gate, not a keyword vote: pages that are wall-to-
# wall statblocks all carry these three markers together.
BEAST_MARKERS = (r"armor class", r"hit points", r"challenge \d")

SCORE_FLOOR = 4      # best score must reach this ...
SCORE_LEAD = 2       # ... and beat the runner-up by this, or it's unsorted


def _norm_pages(pages) -> list[tuple[int, str]]:
    """Accept a string, a list of strings, or (page_no, text) pairs."""
    if isinstance(pages, str):
        return [(1, pages)]
    out = []
    for i, item in enumerate(pages):
        if isinstance(item, (tuple, list)) and len(item) == 2:
            out.append((int(item[0]), str(item[1])))
        else:
            out.append((i + 1, str(item)))
    return out


def detect_book(filename: str, pages) -> tuple[str, float, list[str]]:
    """Classify a whole document. Pure - no I/O, deterministic."""
    stem = Path(str(filename)).stem.lower()
    for pattern, category, conf in FILENAME_RULES:
        if re.search(pattern, stem):
            return category, conf, [f"filename matches '{pattern}'"]

    # Collapse ALL whitespace to single spaces before matching: some PDFs
    # encode every space as a tab ("a\trat\tqueens\tadventure\tfor..."), and a
    # multi-word pattern with a literal space silently misses the whole book.
    pairs = [(no, re.sub(r"\s+", " ", t).lower())
             for no, t in _norm_pages(pages)]
    joined = " \n ".join(t for _, t in pairs)

    scores: dict[str, float] = {}
    hits: dict[str, list[str]] = {}
    for category, signals in CONTENT_SIGNALS.items():
        score = 0
        found = []
        for pattern, weight in signals:
            n = min(5, len(re.findall(pattern, joined)))
            if n:
                score += weight * n
                found.append(f"'{pattern}' x{n}")
        scores[category] = score
        hits[category] = found

    # Bestiary gate first: every marker at least 4 times overall AND at least
    # two sampled mid-pages (past the cover matter) carrying all three -
    # unless the adventure score says this is a module with a monster
    # appendix.
    marker_counts = [len(re.findall(p, joined)) for p in BEAST_MARKERS]
    mid_all3 = sum(
        1 for no, text in pairs
        if no > 6 and all(re.search(p, text.lower()) for p in BEAST_MARKERS))
    if (min(marker_counts) >= 4 and mid_all3 >= 2
            and scores["adventures"] < 6):
        return "bestiaries", 0.80, [
            f"statblock density: {marker_counts[0]}x armor class, "
            f"{marker_counts[1]}x hit points, {marker_counts[2]}x challenge; "
            f"{mid_all3} sampled pages are full statblocks"]

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    (best_cat, best), (_, second) = ranked[0], ranked[1]
    if best >= SCORE_FLOOR and best - second >= SCORE_LEAD:
        conf = min(0.85, 0.4 + best / 20)
        return best_cat, conf, hits[best_cat][:4]

    evidence = [f"score {best:.0f} (needs >= {SCORE_FLOOR}, "
                f"lead >= {SCORE_LEAD} over {second:.0f})"]
    evidence += hits[best_cat][:3]
    return "unsorted", 0.0, evidence


def sniff_pdf(path: Path, first: int = 6,
              marks=(0.25, 0.5, 0.75)) -> list[tuple[int, str]]:
    """Sampled page text for the detector: the front matter plus a few spread
    pages, so a bestiary without a helpful filename still shows its density.
    pypdf, not pdfplumber - this is a sniff, not the extraction."""
    from pypdf import PdfReader   # local: the CLI --selftest needs no PDF lib
    reader = PdfReader(str(path))
    total = len(reader.pages)
    idx = sorted({*range(min(first, total)),
                  *(min(total - 1, int(total * m)) for m in marks)})
    pages = []
    for i in idx:
        try:
            text = reader.pages[i].extract_text() or ""
        except Exception:                                  # noqa: BLE001
            text = ""
        pages.append((i + 1, text))
    return pages


# --------------------------------------------------------------------------
# shelving
# --------------------------------------------------------------------------


def _unique_dest(dest: Path) -> Path:
    if not dest.exists():
        return dest
    n = 2
    while True:
        cand = dest.with_name(f"{dest.stem} ({n}){dest.suffix}")
        if not cand.exists():
            return cand
        n += 1


def _run_split(pdf: Path, extracted_root: Path) -> dict:
    sys.path.insert(0, str(ROOT / "tools"))
    import split_pdf                                       # noqa: PLC0415
    # split_pdf writes to its module-level OUT_ROOT; point it at ours for the
    # duration so the selftest can extract into a temp tree. The default paths
    # ARE split_pdf's default, so production behaviour is unchanged.
    prev = split_pdf.OUT_ROOT
    split_pdf.OUT_ROOT = extracted_root
    try:
        return split_pdf.split(pdf)
    finally:
        split_pdf.OUT_ROOT = prev


def shelve_file(src: Path, category: str | None = None, *,
                origin: str, paths: dict | None = None) -> dict:
    """File one PDF onto the shelf. Idempotent by content hash, two notches:

    - hash known AND its shelf copy exists  -> no-op, alreadyKnown
    - hash known but never categorised (seeded from an old extraction)
                                            -> detect + move, SKIP the split
    - hash unknown                          -> detect + move + split

    A failed split still shelves the file and records the error - same
    posture as the inbox autosplit: record, don't crash.
    """
    paths = paths or default_paths()
    src = Path(src)
    if category is not None and category not in CATEGORIES:
        raise ValueError(f"unknown category '{category}'")

    digest = file_hash(src)
    man = read_manifest(paths)
    done = man.setdefault("processed", {})
    entry = done.get(digest)

    shelf_path = Path(entry["shelfPath"]) if entry and entry.get("shelfPath") else None
    if entry and entry.get("category") and shelf_path and shelf_path.exists():
        return {**entry, "alreadyKnown": True}

    # What is it?
    if category is None:
        try:
            pages = sniff_pdf(src)
            category, confidence, evidence = detect_book(src.name, pages)
        except Exception as exc:                           # noqa: BLE001
            category, confidence = "unsorted", 0.0
            evidence = [f"unreadable: {type(exc).__name__}: {exc}"]
    else:
        confidence, evidence = 1.0, ["filed by hand"]

    # Move it home.
    dest_dir = paths["shelf"] / category
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if src.resolve() != dest.resolve():
        dest = _unique_dest(dest)
        shutil.move(str(src), str(dest))

    # Extract it - unless a previous run already did.
    new_entry = dict(entry or {})
    slug = slug_for(dest.name)
    have_output = (entry or {}).get("outputDir") and Path(entry["outputDir"]).exists()
    if not have_output and (paths["extracted"] / slug / "_report.json").exists():
        have_output = True
        new_entry["outputDir"] = str(paths["extracted"] / slug)
    if not have_output:
        try:
            report = _run_split(dest, paths["extracted"])
            new_entry["outputDir"] = report.get("outputDir")
            new_entry["written"] = report.get("written", {})
            new_entry["pages"] = report.get("pages")
            new_entry.pop("error", None)
        except Exception as exc:                           # noqa: BLE001
            new_entry["error"] = f"{type(exc).__name__}: {exc}"

    new_entry.update({
        "file": dest.name, "hash": digest, "category": category,
        "confidence": confidence, "evidence": evidence,
        "shelfPath": str(dest), "at": now_iso(),
        "origin": new_entry.get("origin", origin),
    })
    done[digest] = new_entry
    write_manifest(man, paths)
    return {**new_entry, "alreadyKnown": False}


def seed_existing(files, paths: dict | None = None) -> list[dict]:
    """Record hashes for PDFs whose extraction already exists, so --apply
    will not re-split them. Run BEFORE anything else touches the files -
    the six pre-shelf extractions were made via explicit CLI paths and the
    manifest never learned their hashes."""
    paths = paths or default_paths()
    man = read_manifest(paths)
    done = man.setdefault("processed", {})
    out = []
    changed = False
    for f in files:
        f = Path(f)
        digest = file_hash(f)
        slug = slug_for(f.name)
        report_path = paths["extracted"] / slug / "_report.json"
        if digest in done:
            out.append({"file": f.name, "seeded": False,
                        "reason": "hash already known"})
            continue
        if not report_path.exists():
            out.append({"file": f.name, "seeded": False,
                        "reason": "no existing extraction"})
            continue
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            report = {}
        done[digest] = {
            "file": f.name, "hash": digest, "at": now_iso(),
            "outputDir": str(report_path.parent),
            "written": report.get("written", {}),
            "pages": report.get("pages"),
            "origin": "cli",
        }
        changed = True
        out.append({"file": f.name, "seeded": True, "reason": "linked"})
    if changed:
        write_manifest(man, paths)
    return out


# --------------------------------------------------------------------------
# sections - a shelved book, in reading order, for the Deck's review rows
# --------------------------------------------------------------------------

# Statblock kinds are deliberately left out: a bestiary would hand the Deck
# thousands of rows, and those records already surface one-by-one in the
# workshop. Settings prose lands almost entirely in "unclassified", which is
# exactly what region/faction/lore filing wants.
SECTION_SKIP = {"monster", "spell", "magic_item"}


def sections_for(slug: str, include_all: bool = False,
                 paths: dict | None = None) -> list[dict]:
    paths = paths or default_paths()
    doc_dir = paths["extracted"] / slug
    if not doc_dir.is_dir():
        return []
    rows = []
    for fp in sorted(doc_dir.glob("*.json")):
        if fp.name == "_report.json":
            continue
        kind = fp.stem
        if not include_all and kind in SECTION_SKIP:
            continue
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if kind == "subclasses":
            for sub in data:
                page = (sub.get("pages") or [0])[0]
                for feat in sub.get("features", []):
                    if feat.get("name") and feat.get("text"):
                        rows.append({"title": f"{sub.get('name', '?')}: {feat['name']}",
                                     "body": feat["text"], "page": page,
                                     "kind": "subclass"})
        else:
            for block in data:
                if block.get("title") and block.get("text"):
                    rows.append({"title": block["title"], "body": block["text"],
                                 "page": int(block.get("page") or 0),
                                 "kind": kind})
    rows.sort(key=lambda r: r["page"])
    return rows


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _collect(args: list[str]) -> list[Path]:
    """Explicit files, or one level of *.pdf inside a folder. Never recursive
    (grimoire itself lives under D:/Dnd - a recursive sweep would eat the
    app's own generated character sheets), never files already shelved."""
    out = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            out.extend(sorted(x for x in p.glob("*.pdf") if x.is_file()))
        elif p.is_file() and p.suffix.lower() == ".pdf":
            out.append(p)
        else:
            print(f"  skip (not a pdf): {a}")
    shelf_root = default_paths()["shelf"].resolve()
    return [p for p in out if shelf_root not in p.resolve().parents]


def _print_verdict(name: str, category: str, conf: float, evidence: list):
    print(f"  {name}\n    -> {category}  ({conf:.2f})  "
          f"[{'; '.join(str(e) for e in evidence[:3])}]")


def main(argv: list[str]) -> int:
    flags = {a for a in argv if a.startswith("--")}
    args = [a for a in argv if not a.startswith("--")]

    if "--selftest" in flags:
        return run_selftest()

    files = _collect(args)
    if not files:
        print(__doc__)
        return 1

    if "--seed-existing" in flags:
        for row in seed_existing(files):
            mark = "seeded" if row["seeded"] else "-"
            print(f"  {mark:7s} {row['file']}  ({row['reason']})")
        return 0

    if "--apply" in flags:
        for f in files:
            r = shelve_file(f, origin="cli")
            note = "already on the shelf" if r.get("alreadyKnown") else \
                   f"error: {r['error']}" if r.get("error") else \
                   f"split {sum((r.get('written') or {}).values())} blocks"
            _print_verdict(r["file"], r["category"], r.get("confidence", 0),
                           r.get("evidence", []))
            print(f"    {note} -> {r.get('shelfPath')}")
        return 0

    # default / --dry: classify only, touch nothing
    for f in files:
        try:
            pages = sniff_pdf(f)
            cat, conf, ev = detect_book(f.name, pages)
        except Exception as exc:                           # noqa: BLE001
            cat, conf, ev = "unsorted", 0.0, [f"unreadable: {exc}"]
        _print_verdict(f.name, cat, conf, ev)
    return 0


# --------------------------------------------------------------------------
# selftest - the thirteen real books this shipped with, as recorded fixtures
# (filename + genuine sniffed text), so a signal tweak can never silently
# reshuffle the library. Plus threshold edges and a real temp-dir shelving.
# --------------------------------------------------------------------------

FIXTURES = [
    # Filename-rule books: the rule decides, the snippet is corroboration.
    ("Monster Manual.pdf", "bestiaries",
     "Armor Class 17 Hit Points 135 Challenge 9"),
    ("Plane Shift Zendikar.pdf", "settings",
     "PLANE SHIFT: ZENDIKAR the world of Zendikar, its people and cultures"),
    ("Plane-Shift_Kaladesh.pdf", "settings",
     "the world of Kaladesh and its people"),
    ("DDEX16_TheScrollThief.pdf", "adventures",
     "D&D Adventurers League. Read-aloud text appears in boxes."),
    ("DRA18_CryptsKelemvor.pdf", "adventures",
     "a one-shot Dungeons & Dragons adventure for characters of levels 3 to 5"),
    ("DRA12_barbersilverymoon_jbt.pdf", "adventures",
     "People have been disappearing at night in the city of Silverymoon."),
    ("DNDUA2021.pdf", "options",
     "Unearthed Arcana: Feats for Races. This Is Playtest Material."),
    ("UA2026-MysticSubclasses.pdf", "options",
     "UNEARTHED ARCANA 2026 MYSTIC SUBCLASSES This playtest document"),
    ("UA_ModernMagic.pdf", "options",
     "Unearthed Arcana: Modern Magic archetypes"),
    ("UA_Waterborne_v3.pdf", "options",
     "Unearthed Arcana: Waterborne Adventures playtest archetypes"),
    ("Armokil's Archive of Subclasses (V3) (2).pdf", "options",
     "ARCHIVE OF SUBCLASSES These 39 subclasses are designed by me"),
    # Content-only books - the snippets are what the real sniff found.
    ("FoFD.pdf", "adventures",
     "Our heroes take a contract. An adventure for four players. The forest "
     "encounters are keyed. Random encounters occur at night. deities"),
    # Recorded verbatim: this PDF encodes spaces as TABS. The fixture pins
    # the whitespace-normalisation step - without it the book scores 3 and
    # lands unsorted, exactly as it did on first contact.
    ("Wiebe_TheHangover.pdf", "adventures",
     "the hangover a\trat\tqueens\tadventure\tfor\t3rd-level\tcharacters\t\t"
     "encounter one. encounter\ttwo. encounter three."),
]


def run_selftest() -> int:
    import tempfile
    fails = []

    def check(label, ok):
        print(f"  {'ok ' if ok else 'FAIL'} {label}")
        if not ok:
            fails.append(label)

    print("detector fixtures (the 13 real books):")
    for name, expect, snippet in FIXTURES:
        cat, conf, ev = detect_book(name, snippet)
        check(f"{name} -> {expect} (got {cat} {conf:.2f})", cat == expect)
        if cat == expect and cat != "unsorted":
            check(f"{name} confidence >= 0.4", conf >= 0.4)
            check(f"{name} has evidence", bool(ev))

    print("threshold edges:")
    cat, _, ev = detect_book("mystery.pdf", "a gazetteer of somewhere")
    check(f"score 3 -> unsorted with reasons (got {cat})",
          cat == "unsorted" and len(ev) >= 1)
    cat, _, _ = detect_book(
        "mystery.pdf", "gazetteer pantheon adventurers league encounter")
    check(f"lead 1 (5 vs 4)  -> unsorted (got {cat})", cat == "unsorted")
    cat, _, _ = detect_book(
        "mystery.pdf", "defeat the feature and its features in one defeat")
    check(f"'feature'/'defeat' never count as feats (got {cat})",
          cat == "unsorted")
    cat, _, _ = detect_book("mystery.pdf", [
        (1, "intro"), (8, "armor class 12 hit points 8 challenge 1"),
        (9, "armor class 13 hit points 20 challenge 2"),
        (10, "armor class 14 hit points 30 challenge 3"),
        (11, "armor class 15 hit points 40 challenge 4")])
    check(f"statblock density -> bestiaries (got {cat})", cat == "bestiaries")

    print("shelving in a temp tree:")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        paths = {"shelf": tmp / "shelf", "extracted": tmp / "extracted",
                 "manifest": tmp / "_manifest.json"}
        pdf = tmp / "Tiny Gazetteer.pdf"
        _make_fixture_pdf(pdf)

        spare = tmp / "copy of Tiny Gazetteer.pdf"
        shutil.copy2(pdf, spare)

        r1 = shelve_file(pdf, origin="cli", paths=paths)
        check(f"fixture files as settings (got {r1['category']})",
              r1["category"] == "settings")
        check("fixture was split",
              not r1.get("error") and sum((r1.get("written") or {}).values()) >= 1)
        check("file moved onto the shelf",
              Path(r1["shelfPath"]).exists() and not pdf.exists())

        r2 = shelve_file(spare, origin="cli", paths=paths)
        check("same bytes again -> alreadyKnown", r2.get("alreadyKnown") is True)
        check("duplicate copy not moved", spare.exists())

        secs = sections_for(slug_for(r1["file"]), paths=paths)
        check(f"sections_for returns rows in page order (got {len(secs)})",
              len(secs) >= 2 and
              all(a["page"] <= b["page"] for a, b in zip(secs, secs[1:])))

        # Seeding: a fresh manifest + an existing extraction = linked, no split.
        paths2 = {"shelf": tmp / "shelf2", "extracted": paths["extracted"],
                  "manifest": tmp / "_manifest2.json"}
        shutil.copy2(Path(r1["shelfPath"]), tmp / "Tiny Gazetteer.pdf")
        rows = seed_existing([tmp / "Tiny Gazetteer.pdf"], paths=paths2)
        check("seed-existing links the old extraction",
              rows[0]["seeded"] is True)
        r3 = shelve_file(tmp / "Tiny Gazetteer.pdf", origin="cli", paths=paths2)
        check("seeded book still gets moved + categorised",
              r3["category"] == "settings" and not r3.get("alreadyKnown")
              and Path(r3["shelfPath"]).exists())

    print(f"\n{'PASS' if not fails else 'FAIL'} - "
          f"{len(fails)} failure(s)" if fails else "\nPASS - all checks green")
    return 1 if fails else 0


def _make_fixture_pdf(path: Path) -> None:
    """A tiny real PDF (reportlab) with enough setting-flavoured prose for
    the detector and two headed sections for the splitter.

    Everything sits on one uniform 14pt baseline grid: a bigger heading font
    makes pdfplumber emit a blank line under the title, and blocks_from
    requires the very NEXT line to be prose - the heading is recognised by
    its text shape, not its size."""
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(path), pagesize=letter)
    for title, lines in (
        ("The Tiny Gazetteer", [
            "A gazetteer of the world of Testia, its people and cultures.",
            "The pantheon of Testia is small. The geography is smaller.",
            "Nations rise and fall between breakfast and lunch."]),
        ("The Vale Of Gyms", [
            "The vale holds one town and a stubborn weather pattern.",
            "Its people measure everything, then measure it again."]),
    ):
        y = 720
        c.setFont("Helvetica-Bold", 12)
        c.drawString(72, y, title)
        y -= 14
        c.setFont("Helvetica", 12)
        for ln in lines:
            c.drawString(72, y, ln)
            y -= 14
        c.showPage()
    c.save()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
