"""Split a mixed homebrew PDF into typed content files.

    python tools/split_pdf.py inbox/your-compendium.pdf
    python tools/split_pdf.py --all


Homebrew PDFs are rarely one thing. A single Unearthed Arcana carries
subclasses, spells and equipment in one document; a community archive carries
forty subclasses. Feeding the whole file to the subclass analyser produces
nonsense, so this classifies each block first and routes it.


Classification is SIGNATURE-based, the same approach srd_convert.py uses:

    spell        "Casting Time:" with a Range or Duration line
    magic item   a rarity plus an item category, or "requires attunement"
    monster      Armor Class + Hit Points + a STR/DEX/CON run
    feat         "Prerequisite:" near the top of a block
    species      "Ability Score Increase" with Age/Size/Speed traits
    subclass     level-gated feature phrasing ("At 3rd level", "Beginning at")
    equipment    a cost-and-weight table row shape


Output goes to data/extracted/<pdf-stem>/ as one JSON file per type, plus
subclasses written into drop/ so the app picks them up like any other homebrew.


Everything that does NOT classify is written to _unclassified.json rather than
dropped. A splitter that silently discards what it does not understand is how
you end up believing a 40-subclass archive contained 6.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "inbox"
OUT_ROOT = ROOT / "library" / "extracted"
INBOX = ROOT / "inbox"


DMG = ("Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|Poison|"
       "Psychic|Radiant|Slashing|Thunder")
RARITY = "common|uncommon|rare|very rare|legendary|artifact"
ITEM_KIND = ("wondrous item|weapon|armor|ring|rod|staff|wand|potion|scroll|"
             "ammunition")
LEVEL_RE = re.compile(
    # Three phrasings occur in the wild and all three matter:
    #   "Level 3:"                      2024 style
    #   "At 3rd level" / "Beginning at" 2014 style
    #   "5th level Wyrmforger feature"  bare subheading, very common
    # The prefix is OPTIONAL. Requiring it missed all 295 feature markers in
    # Armokil's archive, which is why a 39-subclass document read as one.
    r"Level\s+(\d+)\s*:"
    r"|(?:(?:at|beginning at|starting at|when you reach)\s+)?"
    r"(\d+)(?:st|nd|rd|th)\s+level",
    re.I)


def level_of(text: str, default: int = 3) -> int:
    """First level referenced in the text, whichever phrasing it uses."""
    m = LEVEL_RE.search(text)
    if not m:
        return default
    raw = m.group(1) or m.group(2)
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return n if 1 <= n <= 20 else default


# --------------------------------------------------------------------------
# extraction
# --------------------------------------------------------------------------


def _pick_gutter(words: list[dict], left: float, right: float):
    """The gutter DECISION, split from the pdfplumber glue so the selftest
    can feed it synthetic word boxes.

    A vertical band through the middle of the page that no word crosses is
    essentially always a real gutter - running prose spans the centre. The
    old rule additionally demanded a near-balanced word split (>0.35), which
    rejected the Monster Manual's commonest layout: art in one column, a
    statblock in the other. Every such page then extracted with its columns
    ZIPPED line-by-line, which is where "Languages Infernal, telepathy
    120ft. The creature then makes a DC 17 Dexterity saving throw" came
    from. Balance is now only a tiebreak; the gate is that both sides hold
    enough words to be columns at all.
    """
    if len(words) < 40:
        return None
    width = right - left
    if width <= 0:
        return None

    best = None
    for frac in [0.40 + i * 0.01 for i in range(21)]:
        x = left + width * frac
        crossing = sum(1 for w in words if w["x0"] < x < w["x1"])
        if crossing == 0:
            l_n = sum(1 for w in words if w["x1"] <= x)
            r_n = sum(1 for w in words if w["x0"] >= x)
            if l_n < 8 or r_n < 8:
                continue
            balance = min(l_n, r_n) / max(l_n, r_n)
            if best is None or balance > best[1]:
                best = (x, balance)
    return best[0] if best else None


def _column_split(page):
    """Find the x of a two-column gutter, or None for single-column pages.

    D&D documents are overwhelmingly two-column, and naive extraction reads
    across the gutter: Armokil's archive produced lines like "create new ones,
    at As an action, so long as you have", which is column one and column two
    welded together. Every downstream heuristic then fails on text that is not
    actually a sentence.
    """
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    return _pick_gutter(words, float(page.bbox[0]), float(page.bbox[2]))


def extract_pages(path: Path) -> list[str]:
    """Layout-aware page text, column by column.

    pypdf reads glyphs in layout order, which interleaves columns and, on some
    documents, returns the encoded space glyph verbatim (UA_ModernMagic extracts
    every space as ")"). pdfplumber reconstructs spacing from glyph geometry and
    lets us crop each column, so the text comes out in reading order.
    """
    import pdfplumber

    pages: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            try:
                gutter = _column_split(page)
            except Exception:                          # noqa: BLE001
                gutter = None
            try:
                if gutter:
                    x0, top, x1, bottom = page.bbox
                    left_col = page.crop((x0, top, gutter, bottom))
                    right_col = page.crop((gutter, top, x1, bottom))
                    text = "\n".join([
                        left_col.extract_text(layout=True) or "",
                        right_col.extract_text(layout=True) or "",
                    ])
                else:
                    text = page.extract_text(layout=True) or ""
            except Exception:                          # noqa: BLE001
                text = page.extract_text() or ""
            # layout=True pads with runs of spaces to preserve position; collapse
            # them so line content is comparable to any other adapter's output.
            text = re.sub(r"[ \t]{2,}", " ", text)
            text = "\n".join(ln.rstrip() for ln in text.split("\n"))
            pages.append(text)
    return pages


LIGATURES = {"\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
             "\ufb03": "ffi", "\ufb04": "ffl"}


def repair_spaces(text: str) -> str:
    """Some PDFs encode the space glyph as punctuation.


    UA_ModernMagic extracts as "Unearthed)Arcana:)Modern)Magic)When)the" - every
    word is present, but each space is a ")". Without repairing this the whole
    document reads as one enormous token and nothing downstream can parse it.


    The tell is a character appearing far more often than any real punctuation
    would while actual spaces are almost absent.

    Repaired per RUN, not per page or per line.

    The corruption belongs to one FONT, so a two-column page can carry a broken
    sidebar beside a clean body column - and column splitting often merges the
    two into a single line, like:

        depend&on&a&character's&presence&in&an&urban& From 1st level, you are

    Any whole-line or whole-page test lets the clean half vouch for the broken
    half and the damage survives. UA_ModernMagic extracted a subclass literally
    named "Many&of&the&class&features&and&spells&in&this&article&" that way.

    So target the runs themselves: three or more word-tokens welded together by
    the same punctuation character with no spaces anywhere among them. Real
    prose never looks like that, and "Bob & Alice" has spaces around its
    ampersand, so it cannot match.
    """
    if not text:
        return text
    # How many welds it takes before a run is certainly corruption.
    #
    # "&" is the only one of these with real no-space usage in English - R&D,
    # AT&T - so it needs three tokens before we touch it. Nobody writes
    # "Bonus)Proficiencies", so one weld is already proof for the others, and
    # requiring three there left short headings mangled.
    MIN_WELDS = {"&": 2, ")": 1, "|": 1, "~": 1}

    # ")" only counts as a space when the document is using it as one, and the
    # tell is that closing parens massively outnumber opening ones. Without
    # this check, ordinary prose that lost a space - "(rounded down)applies" -
    # gets its closing paren eaten and the parentheses left unbalanced.
    if text.count(")") <= text.count("(") * 3 + 3:
        MIN_WELDS.pop(")")

    for ch, welds in MIN_WELDS.items():
        esc = re.escape(ch)
        text = re.sub(
            rf"\w+(?:{esc}[\w',.:;!?-]+){{{welds},}}{esc}?",
            lambda m: m.group(0).replace(ch, " ").rstrip(),
            text,
        )
    return text


def normalise(text: str) -> str:
    for lig, rep in LIGATURES.items():
        text = text.replace(lig, rep)
    text = repair_spaces(text)
    text = text.replace("\t", " ")
    text = text.replace("\u00a0", " ").replace("\u2019", "'")
    text = text.replace("\u2014", "-").replace("\u2013", "-")
    # PDF extraction frequently hyphen-breaks across lines.
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    # Art boxes and page furniture leave runs of dozens of blank lines
    # (layout=True preserves vertical position). They carry nothing, and a
    # thirty-line void in the middle of a statblock reads as a chapter break
    # to every heuristic downstream.
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def blocks_from(pages: list[str]) -> list[dict]:
    """Split page text into candidate blocks on heading-shaped lines.


    With no markup, a heading is guessed from typography: a short, title-cased
    line that is not a sentence, followed by prose. This is the weakest link in
    the whole pipeline and the reason PDF is reported as low fidelity.
    """
    out = []
    for pageno, raw in enumerate(pages, start=1):
        text = normalise(raw)
        lines = text.split("\n")
        marks = []
        for i, line in enumerate(lines):
            t = line.strip()
            if not (3 <= len(t) <= 64):
                continue
            # A trailing colon is HEADING punctuation ("Quint Farm:",
            # "Upriver:") - a whole adventure produced two blocks because
            # every one of its headings ended this way. Sentence punctuation
            # still disqualifies.
            if t.endswith((".", ",", ";")):
                continue
            if not re.match(r"^[A-Z0-9]", t):
                continue
            words = t.split()
            if len(words) > 8:
                continue
            caps = sum(1 for w in words if re.match(r"^[A-Z0-9(]", w))
            if caps / max(1, len(words)) < 0.55:
                continue
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            # A size-and-type line under a caps heading is a creature header
            # no matter how short it runs - "Tiny beast, Unaligned" is 21
            # characters and the 25-char floor was eating the creature name.
            if len(nxt) < 25 and not SIZE_LINE.match(nxt):
                continue
            marks.append(i)

        # No text left behind. Text before the first heading - or a whole
        # page with no heading-shaped line at all - used to VANISH, which
        # broke the splitter's own credo (unclassified is kept, silence is
        # not) and put a floor under every downstream number: the census
        # cannot count a statblock the block stream never carried.
        if not marks:
            body = text.strip()
            if len(body) >= 60:
                out.append({"title": "", "text": body, "page": pageno,
                            "chars": len(body), "untitled": True})
            continue
        lead = "\n".join(lines[:marks[0]]).strip()
        if len(lead) >= 60:
            out.append({"title": "", "text": lead, "page": pageno,
                        "chars": len(lead), "untitled": True})

        for j, at in enumerate(marks):
            end = marks[j + 1] if j + 1 < len(marks) else len(lines)
            body = "\n".join(lines[at + 1:end]).strip()
            # Short bodies are NOT discarded any more: a statblock's own
            # label lines ("Armor Class 17" over a one-line body) are
            # heading-shaped, and dropping them deleted the very lines the
            # stitcher needs. The 60-char floor now applies only to
            # untitled fragments above.
            if not body and not lines[at].strip():
                continue
            out.append({
                "title": lines[at].strip().rstrip(":"),
                "text": body,
                "page": pageno,
                "chars": len(body),

            })
    return stitch_statblocks(out)


# A statblock is one thing to a reader and several blocks to this splitter: the
# ability table, "Challenge", and every action name are all heading-shaped, so
# each starts a new block. On a real Monster Manual that left BUGBEAR as 116
# characters ending at "Speed 30ft." - correct AC and hit points, and no
# abilities, challenge rating or actions, because they were in the next four
# blocks. The parser was blamed for this before the cause was found.
STATBLOCK_START = re.compile(r"Armor Class\s*\d+", re.I)
STATBLOCK_END = re.compile(r"Challenge\s*[\d/]+|CR\s*[\d/]+", re.I)
# The size-and-type line every 5e statblock opens with ("Large aberration,
# Lawful Evil"). It is how the next creature's HEADER is told apart from one
# more action heading once the challenge rating has been seen.
SIZE_LINE = re.compile(
    r"^\s*(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\b", re.I)
# Headings that continue a statblock rather than beginning something new.
CONTINUATION = re.compile(
    r"^\s*(?:actions?|reactions?|bonus actions?|legendary actions?|traits?"
    r"|lair actions?|regional effects?|villain actions?"
    r"|(?:str|dex|con|int|wis|cha)\b.*"
    r"|[A-Z][A-Za-z'()\-\d/ ]{0,40}\.?)\s*$",
)


def _starts_statblock(b: dict) -> bool:
    """The run's start signal, in the TITLE or the head of the text.

    blocks_from no longer discards short-bodied label blocks, so "Armor
    Class 17" now arrives as a block TITLE with a one-line body - the old
    text-only test never saw it.
    """
    return bool(STATBLOCK_START.search(b["title"])
                or STATBLOCK_START.search(b["text"][:400]))


def _is_name_block(b: dict) -> bool:
    """A creature-name heading directly above its statblock: a real name for
    a title (not a label or container) over a size line or nothing at all."""
    if not b.get("title") or is_heading_title(b["title"]):
        return False
    body = b["text"].strip()
    return not body or (len(body) <= 200 and bool(SIZE_LINE.match(body)))


def _name_shaped(line: str) -> bool:
    """A line that could be a creature's name heading."""
    t = line.strip()
    if not (2 <= len(t) <= 40) or len(t.split()) > 5:
        return False
    if t.endswith((".", ",", ";", ":")) or not re.match(r"^[A-Z0-9]", t):
        return False
    return not (is_heading_title(t) or SIZE_LINE.match(t))


def _rescue_name_from_tail(prev: dict):
    """Cut a creature name (and its size line) off the END of a block.

    In the Monster Manual, 209 of 216 refused AC-orphans were fully
    stitched statblocks whose NAME line sat at the tail of the preceding
    lore block or the previous page's last block - the statblock itself
    started at its Armor Class line, classify refused the label title, and
    a complete creature was lost for want of two lines. This fires only
    when a statblock run needs a name, and a heading directly above a
    statblock is almost always that name.

    Returns (name, size_line_or_None) and MUTATES prev, or None.
    """
    lines = prev["text"].rstrip().split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return None
    if SIZE_LINE.match(lines[-1].strip()) and len(lines) >= 2 \
            and _name_shaped(lines[-2]):
        size = lines.pop().strip()
        name = lines.pop().strip()
    elif _name_shaped(lines[-1]):
        size = None
        name = lines.pop().strip()
    else:
        return None
    prev["text"] = "\n".join(lines).rstrip()
    prev["chars"] = len(prev["text"])
    return name, size


def stitch_statblocks(blocks: list[dict]) -> list[dict]:
    """Re-join the pieces of a statblock into one block.

    Starts at a block whose title or head carries "Armor Class N", pulls the
    creature-NAME block back in from just above (its body is the size line,
    so it is never mistaken for a trailing action), and absorbs following
    blocks until the challenge rating has been seen AND a following block
    looks like a new creature rather than a continuation. Conservative on
    purpose: over-merging two creatures is worse than under-merging one, so
    a second "Armor Class" always ends the run, and so does the next
    creature's size line.
    """
    out: list[dict] = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if not _starts_statblock(b):
            out.append(b)
            i += 1
            continue

        merged = dict(b)
        # The start block's own title is content when it is a LABEL ("Armor
        # Class 17") - fold it into the text. A name title stays a title.
        if STATBLOCK_START.search(b["title"]):
            parts = [f"{b['title']}\n{b['text']}"]
        else:
            parts = [b["text"]]
        # Pull the creature's name back in from the block above - either a
        # whole name block, or a name line stranded at the tail of whatever
        # was emitted last (the page-break case).
        if out and _is_name_block(out[-1]) and b["page"] - out[-1]["page"] <= 1:
            name = out.pop()
            merged["title"] = name["title"]
            merged["page"] = name["page"]
            if name["text"].strip():
                parts.insert(0, name["text"])
        elif ((not merged["title"] or is_heading_title(merged["title"]))
                and out and b["page"] - out[-1]["page"] <= 1):
            rescued = _rescue_name_from_tail(out[-1])
            if rescued:
                merged["title"] = rescued[0]
                if rescued[1]:
                    parts.insert(0, rescued[1])
        seen_cr = bool(STATBLOCK_END.search(parts[0]))
        j = i + 1
        while j < len(blocks):
            nxt = blocks[j]
            # A second statblock always ends the run, whatever else is true -
            # and so does the next creature's header (a size line right under
            # a name-shaped title).
            if _starts_statblock(nxt):
                break
            if seen_cr and SIZE_LINE.match(nxt["text"]):
                break
            # Once the challenge rating has been seen, only continuation-shaped
            # headings keep the run going.
            if seen_cr and not CONTINUATION.match(nxt["title"]):
                break
            # Never swallow more than a couple of pages: a runaway merge would
            # turn a chapter into one "monster".
            if nxt["page"] - b["page"] > 2:
                break
            parts.append(f"{nxt['title']}\n{nxt['text']}")
            seen_cr = seen_cr or bool(STATBLOCK_END.search(nxt["text"]))
            j += 1

        merged["text"] = "\n".join(parts)
        merged["chars"] = len(merged["text"])
        merged["stitched"] = j - i
        out.append(merged)
        i = j
    return out


# --------------------------------------------------------------------------
# classification
# --------------------------------------------------------------------------


# Titles that are a section heading or an extraction fragment, never a record.
#
# Real output contained "STR DEX CON INT WIS CHA" and "Armor Class 18" filed as
# monsters, and "Spell Descriptions" and "ACTIONS" filed as spells. Each of
# those then PARSED, because the fields of the first real record inside the
# section were sitting right there - producing a confident, fully-covered,
# entirely wrong entry. Rejecting the container is the only honest fix; the
# records inside it are picked up as their own blocks.
HEADING_TITLE = re.compile(
    r"^\s*(?:"
    r"(?:spell|tattoo|item|monster|creature|feat|trait|action)s?\s+"
    r"(?:descriptions?|list|table|options?)"
    r"|new\s+(?:spell|item|monster|feat|species)s?"
    r"|actions?|reactions?|bonus actions?|legendary actions?|traits?"
    # A statblock or spell LABEL captured as a title - "Components: V, S",
    # "Prerequisite: 10th-level artificer", "Armor Class 18".
    r"|(?:armor class|hit points|speed|challenge|casting time|components?"
    r"|duration|range|prerequisite|target|classes|saving throw|hit)\b.*"
    r"|(?:str|dex|con|int|wis|cha)(?:\s+(?:str|dex|con|int|wis|cha)){2,}"
    # A phrase left hanging on a conjunction is the middle of a sentence.
    r"|.*\b(?:and|or|of|the|with|for|to|by|in|that|which)\s*"
    r")\s*$",
    re.I,
)

RUNS_INTO_PROSE = re.compile(r"\.\s+[A-Z]")


def is_heading_title(title: str) -> bool:
    """A container or a fragment, rather than the name of a thing."""
    t = (title or "").strip()
    if not t or len(t) < 3:
        return True
    # "Healing Touch (1/Day). The celestial touches..." is a captured line, not
    # a name. So is anything long enough to be a sentence.
    if len(t) > 60 or RUNS_INTO_PROSE.search(t):
        return True
    return bool(HEADING_TITLE.match(t))


def classify(block: dict) -> tuple[str, float, str]:
    """Return (kind, confidence, evidence)."""
    t = block["text"]
    title = block["title"]
    head = t[:600]

    # A block whose TITLE is a heading is a container, whatever its body looks
    # like. Checked first so the strong body signals below cannot override it.
    if is_heading_title(title):
        return "unclassified", 0.0, f"heading or fragment title: {title[:40]!r}"

    if re.search(r"Casting Time:", head, re.I) and re.search(
            r"\bRange:|\bDuration:", head, re.I):
        # More than one "Casting Time" means this is a run of spells, not a
        # spell. Splitting them is a separate job; claiming to be one of them
        # is worse than admitting we cannot tell.
        if len(re.findall(r"Casting Time:", t, re.I)) > 1:
            return "unclassified", 0.0, "several spells in one block"
        return "spell", 0.95, "Casting Time + Range/Duration"

    if re.search(r"requires attunement", t, re.I):
        return "magic_item", 0.9, "requires attunement"
    m = re.search(rf"\b({ITEM_KIND})\b[^.\n]{{0,40}}\b({RARITY})\b", head, re.I)
    if m:
        return "magic_item", 0.85, m.group(0)[:48]

    if (re.search(r"Armor Class\s*\d+", head, re.I)
            and re.search(r"Hit Points\s*\d+", head, re.I)):
        # Same again: two AC lines means several statblocks ran together.
        if len(re.findall(r"Armor Class\s*\d+", t, re.I)) > 1:
            return "unclassified", 0.0, "several statblocks in one block"
        return "monster", 0.9, "AC + Hit Points"
    # An ability run ALONE is not a monster - it is most often the header row
    # of a table. Require a second statblock signal before believing it.
    if re.search(r"\bSTR\b.{0,30}\bDEX\b.{0,30}\bCON\b", t, re.S) and (
            re.search(r"Armor Class|Hit Points|Challenge\b", t, re.I)):
        return "monster", 0.7, "ability run + a statblock label"

    if re.search(r"Prerequisite:", head, re.I):
        return "feat", 0.85, "Prerequisite:"

    if re.search(r"Ability Score Increase", head, re.I) and re.search(
            r"\bAge\b|\bSize\b|\bSpeed\b", head, re.I):
        return "species", 0.85, "Ability Score Increase + Age/Size/Speed"

    if LEVEL_RE.search(t):
        return "subclass_feature", 0.75, LEVEL_RE.search(t).group(0).strip()

    # Equipment tables survive extraction as cost/weight runs.
    if re.search(r"\b\d+\s*(?:gp|sp|cp)\b", t, re.I) and re.search(
            r"\b\d+(?:\.\d+)?\s*lb", t, re.I):
        return "equipment", 0.6, "cost + weight"

    if re.search(rf"\d+d\d+\s+({DMG})\s+damage", t, re.I):
        return "mechanic", 0.4, "damage expression, type unclear"

    return "unclassified", 0.0, ""


# --------------------------------------------------------------------------
# subclass assembly
# --------------------------------------------------------------------------


CLASSES = ["barbarian", "bard", "cleric", "druid", "fighter", "monk",
           "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard",
           "artificer", "blood hunter", "mystic"]


SUBCLASS_HINT = re.compile(
    r"\b(path|college|domain|circle|archetype|oath|conclave|school|patron|way|"
    r"order|tradition|discipline|creed|bloodline|origin)\b", re.I)


# "3rd level Toymaker feature" / "15th-level Wyrmforger feature".
#
# This is the single best signal a community-authored PDF gives us, and it was
# being thrown away. Grouping by level ordering alone named subclasses after
# their FIRST FEATURE - a document full of "CLOCKWORK COMPANIONS" and "ARMOR
# REPLICATION" rather than Toymaker and Wyrmforger - and split one subclass
# into several whenever the level run was interrupted. In one real archive this
# phrasing names 103 of 117 features.
SUBCLASS_IN_TEXT = re.compile(
    r"\b\d+\s*(?:st|nd|rd|th)[-\s]+level\s+"
    r"([A-Z][A-Za-z'’\-]*(?:\s+[A-Z][A-Za-z'’\-]*){0,3}?)\s+feature",
    re.I,
)


def subclass_named_in(text: str) -> str | None:
    """The subclass this feature says it belongs to, if it says so at all."""
    m = SUBCLASS_IN_TEXT.search(text[:300])
    if not m:
        return None
    name = " ".join(m.group(1).split()).strip(" -'’")
    # "3rd level Optional feature" and friends name a category, not a subclass.
    if name.lower() in {"optional", "class", "subclass", "bonus", "additional"}:
        return None
    return name if 2 <= len(name) <= 40 else None


def assemble_subclasses(features: list[dict], doc_title: str) -> list[dict]:
    """Group level-gated feature blocks into subclasses.

    Two signals, in order of trustworthiness:

    1. The text says which subclass it belongs to - "3rd level Toymaker
       feature". Explicit, so features are grouped by that name no matter how
       far apart they sit or how their levels run.
    2. Nothing says. Fall back to level ordering: a new subclass starts where
       the level sequence resets. Imperfect, and stated as such - WotC's own
       Unearthed Arcana writes "At 3rd level" with no subclass name, so this
       path still carries the whole document's uncertainty.

    Every result keeps its page range and records which signal named it, so a
    human can check the guesses and ignore the certainties.
    """
    named: dict[str, dict] = {}
    unnamed: list[dict] = []

    for f in features:
        lvl = level_of(f["title"] + " " + f["text"][:300])
        entry = {"name": f["title"], "level": lvl, "text": f["text"], "page": f["page"]}
        sub = subclass_named_in(f["text"]) or subclass_named_in(f["title"])
        if sub:
            g = named.setdefault(sub, {
                "name": sub, "features": [], "firstPage": f["page"],
                "candidateNames": [sub], "nameSource": "text",
            })
            g["features"].append(entry)
            g["firstPage"] = min(g["firstPage"], f["page"])
            g["lastPage"] = max(g.get("lastPage", f["page"]), f["page"])
        else:
            unnamed.append(entry)

    groups: list[dict] = list(named.values())

    # Level-reset grouping, for whatever the text never claimed.
    current: dict | None = None
    last_level = 99
    for entry in unnamed:
        lvl = entry["level"]
        if lvl <= last_level or current is None:
            if current and current["features"]:
                groups.append(current)
            current = {
                "name": None, "features": [], "firstPage": entry["page"],
                "candidateNames": [], "nameSource": "inferred",
            }
        current["features"].append(entry)
        current["lastPage"] = entry["page"]
        if SUBCLASS_HINT.search(entry["name"]):
            current["candidateNames"].append(entry["name"])
        last_level = lvl
    if current and current["features"]:
        groups.append(current)

    out = []
    for g in groups:
        if len(g["features"]) < 2:
            continue
        name = (g["name"] or (g["candidateNames"][0] if g["candidateNames"]
                              else g["features"][0]["name"]))
        joined = " ".join(f["text"] for f in g["features"])[:4000].lower()
        cls = next((c for c in CLASSES if c in joined), None)
        out.append({
            "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
            "name": name,
            "class": cls,
            "kind": "subclass",
            "ruleset": "2014",
            "features": [{
                "id": re.sub(r"[^a-z0-9]+", "-", f["name"].lower()).strip("-"),
                "name": f["name"], "level": f["level"], "text": f["text"],
                "terms": [], "costs": [], "effects": [],
                "mappingStatus": "unmapped",

            } for f in sorted(g["features"], key=lambda x: x["level"])],
            "flavor": {"eyebrow": doc_title, "subtitle": "", "quote": "", "lede": []},
            "rollTables": [], "spellTable": None, "designNotes": [],
            "pages": [g["firstPage"], g.get("lastPage", g["firstPage"])],
            "adapter": "pdf",
            "fidelity": "low",
            # Say which signal named this one. A group the document explicitly
            # labelled is a far stronger claim than one inferred from level
            # ordering, and giving both the same warning taught people to
            # ignore the warning.
            "nameSource": g.get("nameSource", "inferred"),
            "extractionWarning": (
                "Assembled from PDF text. The document names this subclass "
                f"explicitly, so its features are grouped by that name. Check "
                f"pages {g['firstPage']}-{g.get('lastPage')} for anything the "
                "text did not label."
                if g.get("nameSource") == "text" else
                "Assembled from PDF text. Nothing in the document says which "
                "subclass these features belong to, so the grouping is inferred "
                "from level ordering and may split or merge subclasses "
                f"incorrectly - check pages {g['firstPage']}-{g.get('lastPage')} "
                "against the original."
            ),
            "source": {"document": doc_title, "licenseUrl": None},

        })
    return out


# --------------------------------------------------------------------------
# selftest
# --------------------------------------------------------------------------
#
# Fixtures are rendered from the bundled SRD 5.2.1 monsters (CC-BY, ours to
# ship) - NEVER from extracted book text, which must stay out of the repo.
# Each case pins a property the pipeline holds today; a stage improvement
# lands together with the new case that proves it.


def _render_fixture(m: dict) -> str:
    """One SRD monster as conventional 2014-shaped statblock text."""
    lines = [
        f"{m['size']} {m['type']}, {m.get('alignment') or 'unaligned'}",
        f"Armor Class {m['ac']}",
        f"Hit Points {m['hp']} ({m.get('hitDice') or '1d8'})",
        f"Speed {m.get('speed') or '30 ft.'}",
        "STR DEX CON INT WIS CHA",
        " ".join(str(m["abilities"][k]["score"])
                 for k in ("str", "dex", "con", "int", "wis", "cha")),
    ]
    if m.get("skills"):
        lines.append(f"Skills {m['skills']}")
    if m.get("senses"):
        lines.append(f"Senses {m['senses']}")
    if m.get("languages"):
        lines.append(f"Languages {m['languages']}")
    lines.append(f"Challenge {m.get('crText') or m['cr']} (XP {m.get('xp') or 0})")
    for group in ("traits", "actions"):
        for entry in (m.get(group) or [])[:3]:
            lines.append(f"{entry['name']}.")
            lines.append(str(entry.get("text") or "")[:200])
    return "\n".join(lines)


def _srd_monsters(n: int = 3) -> list[dict]:
    fp = ROOT / "app" / "data" / "compendium" / "monsters.json"
    data = json.loads(fp.read_text(encoding="utf-8"))
    # Deterministic picks with traits AND actions, so fixtures have headings.
    rich = [m for m in data if (m.get("traits") and m.get("actions"))]
    return rich[:n]


def selftest() -> dict:
    """Pin the pipeline's honest properties on SRD-rendered fixtures."""
    cases = []

    def case(name: str, ok: bool, note: str = "") -> None:
        cases.append({"name": name, "ok": bool(ok), "note": note})

    mons = _srd_monsters(3)
    m0 = mons[0]

    # 1. FLIPPED from KNOWN_DEFECT_whole_statblock_shatters: a whole
    #    statblock under its name heading is now ONE classified monster
    #    carrying the creature's name. It used to shatter - every label line
    #    is heading-shaped, and the sub-60-char bodies between them were
    #    silently discarded, deleting the AC line before the stitcher could
    #    see a start signal. blocks_from now keeps every marked block and
    #    the stitcher starts on a title OR text signal and pulls the name
    #    block back in from above.
    page = f"{m0['name'].upper()}\n{_render_fixture(m0)}"
    blocks = blocks_from([page])
    monsters = [b for b in blocks if classify(b)[0] == "monster"]
    case("whole_statblock_is_one_monster",
         len(monsters) == 1
         and monsters[0]["title"].lower() == m0["name"].lower(),
         f"monsters={[b['title'] for b in monsters]}")

    # 1b. TWO statblocks on one page come out as two, each under its own
    #     name - the size line under a name heading is the boundary.
    page2 = (f"{m0['name'].upper()}\n{_render_fixture(m0)}\n"
             f"{mons[1]['name'].upper()}\n{_render_fixture(mons[1])}")
    blocks2 = blocks_from([page2])
    monsters2 = [b for b in blocks2 if classify(b)[0] == "monster"]
    case("two_statblocks_two_monsters",
         len(monsters2) == 2
         and {b["title"].lower() for b in monsters2}
         == {m0["name"].lower(), mons[1]["name"].lower()},
         f"monsters={[b['title'] for b in monsters2]}")

    # 1c. No text left behind: a page with no heading-shaped line at all
    #     still reaches the block stream (as an untitled block), so the
    #     census can count what it carries.
    plain = ("The road to the mill winds through fields of blighted wheat. "
             "Anyone searching the millhouse finds the ledger the smugglers "
             "kept, and the miller will talk if pressed politely.")
    lead_blocks = blocks_from([plain])
    case("headingless_page_survives",
         len(lead_blocks) == 1 and lead_blocks[0].get("untitled") is True
         and "ledger" in lead_blocks[0]["text"],
         f"blocks={len(lead_blocks)}")

    # 1e. The page-break case: the creature's name is the LAST line of one
    #     page and its statblock opens the next. The name is rescued off the
    #     previous block's tail; without it the statblock classifies under a
    #     label title and is refused - 209 of the Monster Manual's 216
    #     refused AC-orphans died exactly this way.
    lore = ("The old mill has stood empty for a decade, and the ferrymen "
            "refuse to moor within sight of it after dark. Those who ask "
            "in the village hear the same name whispered.")
    page_a = f"CHAPTER TWO\n{lore}\n{mons[2]['name'].upper()}"
    page_b = _render_fixture(mons[2])
    split_blocks = blocks_from([page_a, page_b])
    split_monsters = [b for b in split_blocks
                      if classify(b)[0] == "monster"]
    case("page_break_name_rescued",
         len(split_monsters) == 1
         and split_monsters[0]["title"].lower() == mons[2]["name"].lower(),
         f"monsters={[b['title'] for b in split_monsters]}")

    # 1d. Colon headings ("Quint Farm:") mark blocks - a whole adventure
    #     yielded two blocks because every heading ended with a colon.
    colon_page = ("Quint Farm:\nThe farmstead sits a mile east of the river "
                  "crossing, its barn newly burned and its well fouled.\n"
                  "Upriver:\nThe lumber camp pays double for an escort, and "
                  "the foreman knows more than he admits about the fires.")
    colon_blocks = blocks_from([colon_page])
    case("colon_headings_mark_blocks",
         len(colon_blocks) == 2
         and colon_blocks[0]["title"] == "Quint Farm"
         and colon_blocks[1]["title"] == "Upriver",
         f"titles={[b['title'] for b in colon_blocks]}")

    # 2. The stitcher rejoins a statblock fragmented at its action headings -
    #    the designed case: the run STARTS at a block whose head carries
    #    "Armor Class N".
    stat = _render_fixture(m0)
    at = stat.index("Challenge")
    head, tail = stat[:at], stat[at:]
    frag_blocks = [
        {"title": m0["name"].upper(), "text": head, "page": 1, "chars": len(head)},
        {"title": "Actions", "text": tail, "page": 1, "chars": len(tail)},
    ]
    stitched = stitch_statblocks(frag_blocks)
    case("fragmented_statblock_stitches",
         len(stitched) == 1
         and classify(stitched[0])[0] == "monster",
         f"blocks={len(stitched)}")

    # 3. Containers and label-fragments are refused, never parsed confidently
    #    from the first record inside them.
    for title in ("Spell Descriptions", "ACTIONS", "Armor Class 18",
                  "STR DEX CON INT WIS CHA"):
        k, _, _ = classify({"title": title, "text": _render_fixture(m0)})
        case(f"container_refused:{title[:20]}", k == "unclassified", k)

    # 4. Two creatures in one block is refused, not guessed at.
    two = {"title": m0["name"],
           "text": _render_fixture(mons[0]) + "\n" + _render_fixture(mons[1])}
    case("two_statblocks_refused", classify(two)[0] == "unclassified",
         classify(two)[2])

    # 5. Spells and items still classify from their own signatures.
    sp = {"title": "Mage Hand",
          "text": "Casting Time: 1 action\nRange: 30 feet\nDuration: 1 minute\n"
                  "A spectral hand appears."}
    case("spell_classifies", classify(sp)[0] == "spell", classify(sp)[2])
    it = {"title": "Cloak of Protection",
          "text": "Wondrous item, uncommon (requires attunement)\n"
                  "You gain a +1 bonus to AC and saving throws."}
    case("item_classifies", classify(it)[0] == "magic_item", classify(it)[2])

    # 6. The census regex used by tools/yield_eval.py counts rendered
    #    statblocks exactly - renderer and ruler must not drift apart.
    sys.path.insert(0, str(ROOT / "tools"))
    from yield_eval import CENSUS                        # noqa: PLC0415
    both = _render_fixture(mons[0]) + "\n" + _render_fixture(mons[1])
    case("census_counts_two", len(CENSUS.findall(both)) == 2,
         f"found={len(CENSUS.findall(both))}")

    # 7. Gutter decision on synthetic word boxes. The unbalanced case is the
    #    Monster Manual's bread and butter - art in one column, a statblock
    #    in the other - and rejecting its gutter zips the columns.
    def col(x0, x1, n, y0=50):
        return [{"x0": x0, "x1": x1, "top": y0 + i * 12} for i in range(n)]
    balanced = col(40, 280, 40) + col(320, 560, 40)
    case("gutter_balanced_two_col",
         _pick_gutter(balanced, 0, 600) is not None, "")
    lopsided = col(40, 280, 60) + col(320, 560, 9)
    case("gutter_unbalanced_two_col",
         _pick_gutter(lopsided, 0, 600) is not None,
         "art-beside-statblock layout must still split")
    # Single-column prose: words span the centre, so no zero-crossing band.
    prose = [{"x0": 40 + (i % 4) * 130, "x1": 40 + (i % 4) * 130 + 140,
              "top": 50 + i * 12} for i in range(48)]
    case("gutter_single_col_refused",
         _pick_gutter(prose, 0, 600) is None, "")

    failed = [c for c in cases if not c["ok"]]
    return {"ok": not failed, "passed": len(cases) - len(failed),
            "failed": len(failed), "cases": cases}


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------


def split(path: Path) -> dict:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", path.stem).strip("-")
    out_dir = OUT_ROOT / stem
    out_dir.mkdir(parents=True, exist_ok=True)

    pages = extract_pages(path)
    blocks = blocks_from(pages)

    buckets: dict[str, list] = {}
    for b in blocks:
        kind, conf, evidence = classify(b)
        b["kind"] = kind
        b["confidence"] = conf
        b["evidence"] = evidence
        buckets.setdefault(kind, []).append(b)

    subclasses = assemble_subclasses(
        buckets.get("subclass_feature", []), path.stem)

    written = {}
    for kind, items in sorted(buckets.items()):
        if kind == "subclass_feature":
            continue
        fp = out_dir / f"{kind}.json"
        fp.write_text(json.dumps(items, ensure_ascii=False, indent=1),
                      encoding="utf-8")
        written[kind] = len(items)

    if subclasses:
        fp = out_dir / "subclasses.json"
        fp.write_text(json.dumps(subclasses, ensure_ascii=False, indent=1),
                      encoding="utf-8")
        written["subclasses"] = len(subclasses)
        # Deliberately NOT copied into the inbox. Output landing in the folder a
        # human drops files into is exactly what buried the inbox under 118
        # generated files and made it impossible to find anything.

    report = {
        "file": path.name,
        "pages": len(pages),
        "blocks": len(blocks),
        "written": written,
        "subclasses": [

            {"name": s["name"], "class": s["class"],
             "features": len(s["features"]), "pages": s["pages"],
             # So the library can show which names the document actually gave
             # us and which we inferred - the reader needs to know which rows
             # deserve a second look before combining them.
             "nameSource": s.get("nameSource", "inferred")}
            for s in subclasses

        ],
        "unclassified": len(buckets.get("unclassified", [])),
        "outputDir": str(out_dir),

    }

    (out_dir / "_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return report


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    do_all = "--all" in sys.argv

    if "--selftest" in sys.argv:
        rep = selftest()
        for c in rep["cases"]:
            mark = "ok " if c["ok"] else "FAIL"
            print(f"  {mark} {c['name']}  {c['note']}")
        print(f"{rep['passed']} passed, {rep['failed']} failed")
        return 0 if rep["ok"] else 1

    if do_all:
        targets = sorted(SOURCE_DIR.glob("*.pdf"))
    elif args:
        targets = [Path(a) for a in args]
    else:
        print(__doc__)
        return 1

    if not targets:
        print(f"no PDFs found in {SOURCE_DIR}", file=sys.stderr)
        return 1


    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    totals: dict[str, int] = {}
    for path in targets:
        if not path.exists():
            print(f"  MISSING {path}", file=sys.stderr)
            continue
        print(f"\n{path.name}")
        try:
            rep = split(path)
        except Exception as exc:                      # noqa: BLE001
            print(f"  FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        print(f"  {rep['pages']} pages -> {rep['blocks']} blocks")
        for kind, n in sorted(rep["written"].items(), key=lambda kv: -kv[1]):
            totals[kind] = totals.get(kind, 0) + n
            print(f"    {kind:<18} {n:>4}")
        if rep["subclasses"]:
            print("    subclasses found:")
            for s in rep["subclasses"][:12]:
                cls = s["class"] or "class?"
                print(f"      {s['name'][:44]:<44} {cls:<10} "
                      f"{s['features']} feats  p{s['pages'][0]}-{s['pages'][1]}")
            if len(rep["subclasses"]) > 12:
                print(f"      ... and {len(rep['subclasses']) - 12} more")
        if rep["unclassified"]:
            print(f"    ! {rep['unclassified']} blocks unclassified "
                  f"(kept in _unclassified, not discarded)")

    print("\n" + "=" * 60)
    print("TOTAL")
    for kind, n in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"  {kind:<18} {n:>4}")
    print(f"\noutput: {OUT_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

