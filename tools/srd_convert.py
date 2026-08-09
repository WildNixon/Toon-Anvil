"""Convert the SRD 5.2.1 markdown corpus into Toon Anvil compendium JSON.

Source markdown: toon-anvil/srd_raw/  (fetched by tools/fetch_srd.py)
Output:          toon-anvil/app/data/compendium/*.json

SRD 5.2.1 is (c) Wizards of the Coast LLC, licensed CC-BY-4.0. See ATTRIBUTION.md.

Design notes
------------
Parsing is *signature-based*, not position-based. We split every file into
heading blocks at any depth, then classify each block by what its body looks
like. This matters because the corpus is not internally consistent: monsters-A-Z
puts creature names at ``###`` while animals.md puts them at ``##``, and section
depths drift between files. Matching on "the body contains an **AC** line"
survives all of that; matching on "it is an h3" does not.

Every parser reports coverage, and anything that looks like a content block but
fails to classify is written to _unparsed.json rather than silently dropped.
Coverage is a number you can read, not a vibe.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "srd_raw"
OUT = ROOT / "app" / "data" / "compendium"

CLASS_NAMES = [
    "Barbarian", "Bard", "Cleric", "Druid", "Fighter", "Monk",
    "Paladin", "Ranger", "Rogue", "Sorcerer", "Warlock", "Wizard",
]

ABILITIES = ["str", "dex", "con", "int", "wis", "cha"]

SCHOOLS = (
    "Abjuration|Conjuration|Divination|Enchantment|Evocation|"
    "Illusion|Necromancy|Transmutation"
)

MAGIC_ITEM_KINDS = (
    "Armor|Potion|Ring|Rod|Scroll|Staff|Wand|Weapon|Wondrous Item|"
    "Ammunition|Wondrous item"
)

MONSTER_SECTIONS = {
    "traits": "Traits",
    "actions": "Actions",
    "bonus actions": "Bonus Actions",
    "reactions": "Reactions",
    "legendary actions": "Legendary Actions",
}


# --------------------------------------------------------------------------
# text normalisation
# --------------------------------------------------------------------------

def norm(text: str) -> str:
    """Normalise the corpus's typographic quirks into plain ASCII-ish text."""
    text = unicodedata.normalize("NFKC", text)
    # U+2212 MINUS SIGN is used for negative modifiers throughout the stat
    # blocks. int("−1") raises; int("-1") does not.
    text = text.replace("−", "-").replace("–", "-").replace("—", "--")
    text = text.replace("&emsp;", " ").replace("&nbsp;", " ").replace("&ndash;", "-")
    text = text.replace("’", "'").replace("‘", "'")
    text = text.replace("“", '"').replace("”", '"')
    return text


def strip_html(text: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<hr\s*/?>", "", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return text


def clean(text: str) -> str:
    """Collapse a block into tidy prose, preserving paragraph breaks."""
    text = strip_html(norm(text))
    lines = [ln.strip() for ln in text.split("\n")]
    out: list[str] = []
    for ln in lines:
        if not ln:
            if out and out[-1] != "":
                out.append("")
        else:
            out.append(ln)
    return "\n".join(out).strip()


def slug(name: str) -> str:
    s = norm(name).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


# --------------------------------------------------------------------------
# structural splitting
# --------------------------------------------------------------------------

class Block:
    __slots__ = ("level", "title", "body", "line", "source")

    def __init__(self, level: int, title: str, body: str, line: int, source: str):
        self.level = level
        self.title = norm(title).strip()
        self.body = body
        self.line = line
        self.source = source

    def first_italic(self) -> str | None:
        """The ``_..._`` line directly under a heading - the type signature."""
        for ln in self.body.split("\n"):
            ln = ln.strip()
            if not ln:
                continue
            m = re.match(r"^_(.+?)_$", ln)
            return m.group(1) if m else None
        return None

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Block h{self.level} {self.title!r} @{self.source}:{self.line}>"


def split_blocks(md: str, source: str) -> list[Block]:
    """Every heading becomes a block owning the text up to the next heading."""
    md = norm(md)
    lines = md.split("\n")
    heads: list[tuple[int, int, str]] = []
    in_fence = False
    for i, ln in enumerate(lines):
        if ln.strip().startswith("```"):
            in_fence = not in_fence
        if in_fence:
            continue
        m = re.match(r"^(#{1,6})\s+(.*\S)\s*$", ln)
        if m:
            heads.append((i, len(m.group(1)), m.group(2)))

    blocks: list[Block] = []
    for idx, (line_no, level, title) in enumerate(heads):
        # A block owns everything down to the next heading at the SAME or a
        # SHALLOWER level, so a parent's body contains its children. Ending at
        # the next heading of *any* level would leave every parent empty.
        end = len(lines)
        for nxt_line, nxt_level, _ in heads[idx + 1:]:
            if nxt_level <= level:
                end = nxt_line
                break
        body = "\n".join(lines[line_no + 1:end])
        blocks.append(Block(level, title, body, line_no + 1, source))
    return blocks


def head_text(body: str) -> str:
    """The prose of a block before its first child heading, at any depth."""
    return re.split(r"^#{1,6}\s", body, maxsplit=1, flags=re.M)[0]


def subblocks(block: Block) -> list[Block]:
    """Re-split a block's own body by its child headings (all depths)."""
    return [b for b in split_blocks(block.body, block.source) if b.level > block.level]


# --------------------------------------------------------------------------
# HTML table parsing (the corpus uses raw HTML tables, not md pipes)
# --------------------------------------------------------------------------

def parse_html_tables(text: str) -> list[list[list[str]]]:
    """Return each <table> as a list of rows, each row a list of cell strings."""
    tables: list[list[list[str]]] = []
    for tbl in re.findall(r"<table.*?</table>", text, flags=re.S | re.I):
        rows: list[list[str]] = []
        for tr in re.findall(r"<tr.*?</tr>", tbl, flags=re.S | re.I):
            cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, flags=re.S | re.I)
            rows.append([clean(c) for c in cells])
        if rows:
            tables.append(rows)
    return tables


def kv_table(text: str) -> dict[str, str]:
    """Two-column label/value tables (e.g. Core Barbarian Traits)."""
    out: dict[str, str] = {}
    for rows in parse_html_tables(text):
        for row in rows:
            if len(row) == 2 and row[0]:
                out[row[0]] = row[1]
    return out


def bold_entries(text: str) -> list[dict[str, str]]:
    """Parse ``**_Name._** body`` runs - monster traits/actions, feat benefits."""
    text = norm(text)
    pattern = re.compile(r"\*\*_(.+?)\._\*\*\s*(.*?)(?=\n\s*\*\*_|\Z)", re.S)
    entries = []
    for m in pattern.finditer(text):
        entries.append({"name": m.group(1).strip(), "text": clean(m.group(2))})
    return entries


def bold_plain_entries(text: str) -> list[dict[str, str]]:
    """Parse ``**Name.** body`` runs - mastery/weapon properties use this form,
    without the inner underscores that monster traits use."""
    text = norm(text)
    pattern = re.compile(r"\*\*([^*_\n]+?)\.\*\*\s*(.*?)(?=\n\s*\*\*[^*_\n]+?\.\*\*|\Z)", re.S)
    entries = []
    for m in pattern.finditer(text):
        name = m.group(1).strip()
        if len(name) > 60:
            continue
        entries.append({"name": name, "text": clean(m.group(2))})
    return entries


def any_entries(text: str) -> list[dict[str, str]]:
    """Try each entry convention the corpus uses, in decreasing specificity."""
    return bold_entries(text) or bold_plain_entries(text) or italic_entries(text)


def italic_entries(text: str) -> list[dict[str, str]]:
    """Parse ``_Name._ body`` runs - feat/species/background sub-benefits."""
    text = norm(text)
    pattern = re.compile(r"^_(.+?)\._\s*(.*?)(?=\n\s*_[A-Z]|\Z)", re.S | re.M)
    entries = []
    for m in pattern.finditer(text):
        name = m.group(1).strip()
        if len(name) > 80 or "\n" in name:
            continue
        entries.append({"name": name, "text": clean(m.group(2))})
    return entries


def labelled(text: str, label: str) -> str | None:
    """Pull ``**Label:** value`` or ``**Label** value`` from a block."""
    m = re.search(
        rf"\*\*{re.escape(label)}:?\*\*\s*(.+?)(?=\n\s*\*\*|\n\s*\n|<br|\Z)",
        norm(text), flags=re.S | re.I,
    )
    return clean(m.group(1)) if m else None


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------

class Report:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.unparsed: list[dict[str, Any]] = []
        self.notes: list[str] = []

    def record(self, category: str, items: Iterable[Any]) -> list[Any]:
        items = list(items)
        self.counts[category] = len(items)
        return items

    def miss(self, block: Block, why: str) -> None:
        self.unparsed.append({
            "title": block.title, "source": block.source,
            "line": block.line, "level": block.level, "why": why,
        })

    def note(self, msg: str) -> None:
        self.notes.append(msg)


REPORT = Report()


# --------------------------------------------------------------------------
# spells
# --------------------------------------------------------------------------

# Levelled spells read "Level 3 Evocation (Sorcerer, Wizard)" but cantrips put
# the school first: "Evocation Cantrip (Sorcerer, Wizard)". Both forms required.
SPELL_SIG = re.compile(
    rf"^(?:Level\s+(?P<lvl>\d+)\s+(?P<school1>{SCHOOLS})"
    rf"|(?P<school2>{SCHOOLS})\s+(?P<cantrip>Cantrip))"
    rf"\s*(?:\((?P<classes>.+?)\))?\s*$", re.I
)


def parse_spells(blocks: list[Block]) -> list[dict[str, Any]]:
    spells = []
    for b in blocks:
        sig = b.first_italic()
        if not sig:
            continue
        m = SPELL_SIG.match(sig.strip())
        if not m:
            continue
        cantrip = m.group("cantrip")
        lvl = m.group("lvl")
        school = m.group("school1") or m.group("school2")
        classes = m.group("classes")
        body = b.body
        # Strip the signature line and the labelled header lines from the text.
        desc = re.sub(r"^\s*_.+?_\s*$", "", body, count=1, flags=re.M)
        desc = re.sub(
            r"^\s*\*\*(Casting Time|Range|Components|Duration):\*\*.*$",
            "", desc, flags=re.M | re.I,
        )
        higher = None
        hm = re.search(
            r"_Using a Higher-Level Spell Slot\._\s*(.+?)(?=\n\s*\n|\Z)",
            norm(desc), flags=re.S | re.I,
        )
        if hm:
            higher = clean(hm.group(1))
            desc = re.sub(
                r"_Using a Higher-Level Spell Slot\._.*", "", desc, flags=re.S | re.I
            )
        cm = re.search(r"_Cantrip Upgrade\._\s*(.+?)(?=\n\s*\n|\Z)",
                       norm(b.body), flags=re.S | re.I)

        components = labelled(body, "Components") or ""
        material = None
        mm = re.search(r"M\s*\((.+?)\)\s*$", components)
        if mm:
            material = mm.group(1).strip()
        duration = labelled(body, "Duration") or ""

        spells.append({
            "id": slug(b.title),
            "name": b.title,
            "level": 0 if cantrip else int(lvl),
            "school": school.capitalize(),
            "classes": [c.strip() for c in classes.split(",")] if classes else [],
            "castingTime": labelled(body, "Casting Time") or "",
            "range": labelled(body, "Range") or "",
            "components": re.sub(r"\s*\(.*", "", components).strip(),
            "material": material,
            "duration": duration,
            "concentration": "concentration" in duration.lower(),
            "ritual": "ritual" in (labelled(body, "Casting Time") or "").lower(),
            "text": clean(desc),
            "higherLevel": higher,
            "cantripUpgrade": clean(cm.group(1)) if cm else None,
            "source": "SRD 5.2.1",
        })
    return spells


# --------------------------------------------------------------------------
# monsters
# --------------------------------------------------------------------------

TYPE_SIG = re.compile(
    r"^(Tiny|Small|Medium|Large|Huge|Gargantuan)(?:\s+or\s+\w+)?\s+"
    r"([A-Za-z ]+?)(?:\s*\(([^)]*)\))?,\s*(.+)$", re.I
)


def parse_ability_table(text: str) -> dict[str, dict[str, int]] | None:
    """The 6 ability scores live in a 12-column HTML table, 2 rows of 3."""
    for rows in parse_html_tables(text):
        flat: list[str] = []
        for row in rows:
            if any(c.upper() in ("STR", "DEX", "CON", "INT", "WIS", "CHA") for c in row):
                flat.extend(row)
        if not flat:
            continue
        out: dict[str, dict[str, int]] = {}
        i = 0
        while i + 3 < len(flat) + 1:
            chunk = flat[i:i + 4]
            if len(chunk) < 4:
                break
            key = chunk[0].strip().upper()
            if key in ("STR", "DEX", "CON", "INT", "WIS", "CHA"):
                try:
                    out[key.lower()] = {
                        "score": int(re.sub(r"[^0-9-]", "", chunk[1])),
                        "mod": int(re.sub(r"[^0-9-]", "", chunk[2])),
                        "save": int(re.sub(r"[^0-9-]", "", chunk[3])),
                    }
                except ValueError:
                    pass
                i += 4
            else:
                i += 1
        if len(out) == 6:
            return out
    return None


def parse_cr(text: str) -> dict[str, Any]:
    m = re.search(r"\*\*CR\*\*\s*([\d/]+|Unknown|-)\s*(?:\(([^)]*)\))?", norm(text))
    if not m:
        return {"cr": None, "xp": None, "pb": None}
    raw = m.group(1)
    detail = m.group(2) or ""
    if "/" in raw:
        a, b = raw.split("/")
        cr: float | int | None = int(a) / int(b)
    elif raw.isdigit():
        cr = int(raw)
    else:
        cr = None
    xp = None
    xm = re.search(r"XP\s*([\d,]+)", detail)
    if xm:
        xp = int(xm.group(1).replace(",", ""))
    pb = None
    pm = re.search(r"PB\s*\+?(-?\d+)", detail)
    if pm:
        pb = int(pm.group(1))
    return {"cr": cr, "crText": raw, "xp": xp, "pb": pb}


def load_overrides() -> dict[str, dict[str, dict[str, int]]]:
    """Hand-patched ability blocks for monsters with corrupt upstream tables.

    Re-verifies mod == floor((score - 10) / 2) for every entry so a typo in the
    override file fails the build instead of shipping a wrong stat block.
    """
    path = Path(__file__).resolve().parent / "monster_overrides.json"
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, dict[str, dict[str, int]]] = {}
    for key, abilities in raw.items():
        if key.startswith("_"):
            continue
        for ab, vals in abilities.items():
            expected = (vals["score"] - 10) // 2
            if vals["mod"] != expected:
                raise SystemExit(
                    f"override {key}.{ab}: mod {vals['mod']} contradicts score "
                    f"{vals['score']} (expected {expected}) - fix "
                    f"monster_overrides.json"
                )
        out[key] = abilities
    return out


def parse_monsters(all_blocks: list[Block],
                   overrides: dict[str, dict] | None = None) -> list[dict[str, Any]]:
    overrides = overrides or {}
    monsters = []
    for b in all_blocks:
        # Anchor on the block's OWN prose. Now that a parent owns its children,
        # a wrapper like "## Animated Objects" contains its variants' stat lines
        # and would otherwise be parsed as a monster in its own right.
        header = head_text(b.body)
        if "**AC**" not in header:
            continue
        abilities = parse_ability_table(b.body)
        patched = False
        if abilities is None:
            abilities = overrides.get(slug(b.title))
            if abilities is None:
                REPORT.miss(b, "stat block found but ability table did not parse")
                continue
            patched = True
            REPORT.note(f"patched ability block from overrides: {b.title}")

        sig = b.first_italic() or ""
        size = mtype = alignment = None
        tags = None
        tm = TYPE_SIG.match(sig.strip())
        if tm:
            size, mtype, tags, alignment = tm.groups()

        ac_m = re.search(r"\*\*AC\*\*\s*(\d+)", header)
        hp_m = re.search(r"\*\*HP\*\*\s*(\d+)\s*(?:\(([^)]*)\))?", header)
        init_m = re.search(r"\*\*Initiative\*\*\s*([+-]?\d+)", norm(header))

        sections: dict[str, list[dict[str, str]]] = {}
        for sub in subblocks(b):
            key = sub.title.strip().lower()
            if key in MONSTER_SECTIONS:
                entries = bold_entries(sub.body)
                lead = re.split(r"\*\*_", norm(sub.body))[0]
                lead = clean(lead)
                sections[key.replace(" ", "_")] = entries
                if lead and key == "legendary actions":
                    sections["legendary_lead"] = lead  # type: ignore[assignment]

        monsters.append({
            "id": slug(b.title),
            "name": b.title,
            "size": size.capitalize() if size else None,
            "type": mtype.strip().lower() if mtype else None,
            "tags": tags,
            "alignment": alignment.strip() if alignment else None,
            "ac": int(ac_m.group(1)) if ac_m else None,
            "initiative": int(init_m.group(1)) if init_m else None,
            "hp": int(hp_m.group(1)) if hp_m else None,
            "hitDice": hp_m.group(2) if hp_m and hp_m.group(2) else None,
            "speed": labelled(header, "Speed"),
            "abilities": abilities,
            "skills": labelled(header, "Skills"),
            "senses": labelled(header, "Senses"),
            "languages": labelled(header, "Languages"),
            "resistances": labelled(header, "Resistances"),
            "immunities": labelled(header, "Immunities"),
            "vulnerabilities": labelled(header, "Vulnerabilities"),
            "gear": labelled(header, "Gear"),
            **parse_cr(header),
            "traits": sections.get("traits", []),
            "actions": sections.get("actions", []),
            "bonusActions": sections.get("bonus_actions", []),
            "reactions": sections.get("reactions", []),
            "legendaryActions": sections.get("legendary_actions", []),
            "legendaryLead": sections.get("legendary_lead"),
            "abilitiesPatched": patched,
            "source": "SRD 5.2.1",
        })
    return monsters


# --------------------------------------------------------------------------
# classes
# --------------------------------------------------------------------------

FEATURE_SIG = re.compile(r"^Level\s+(\d+):\s*(.+)$", re.I)


def parse_classes(blocks: list[Block]) -> list[dict[str, Any]]:
    classes = []
    for b in blocks:
        if b.level != 2 or b.title not in CLASS_NAMES:
            continue
        name = b.title
        traits = kv_table(head_text(b.body))

        features: list[dict[str, Any]] = []
        subclasses: list[dict[str, Any]] = []
        progression: list[list[str]] = []
        spell_list: list[str] = []
        optional: dict[str, list[dict[str, str]]] = {}

        for sub in subblocks(b):
            title = sub.title
            if title.lower().endswith("class features"):
                for rows in parse_html_tables(head_text(sub.body)):
                    if len(rows) > 3:
                        progression = rows
                        break
                for feat in subblocks(sub):
                    fm = FEATURE_SIG.match(feat.title)
                    if fm:
                        features.append({
                            "level": int(fm.group(1)),
                            "name": fm.group(2).strip(),
                            "text": clean(feat.body),
                        })
            elif re.match(rf"^{re.escape(name)} Subclass:\s*(.+)$", title, re.I):
                sub_name = re.split(r"Subclass:\s*", title, flags=re.I)[1].strip()
                sub_feats = []
                for feat in subblocks(sub):
                    fm = FEATURE_SIG.match(feat.title)
                    if fm:
                        sub_feats.append({
                            "level": int(fm.group(1)),
                            "name": fm.group(2).strip(),
                            "text": clean(feat.body),
                        })
                subclasses.append({
                    "id": slug(sub_name),
                    "name": sub_name,
                    "class": name,
                    "intro": clean(head_text(sub.body)),
                    "features": sub_feats,
                    "source": "SRD 5.2.1",
                })
            elif title.lower().endswith("spell list"):
                # Each level is its own sub-block ("Cantrips (Level 0 Sorcerer
                # Spells)", "Level 1 Sorcerer Spells") holding a
                # Spell | School | Special table. Column 0 is the spell name;
                # reading column 1 yields the *school*, which is why an earlier
                # pass produced exactly 9 entries.
                for lvl_block in subblocks(sub):
                    lm = re.search(r"Level\s+(\d+)", lvl_block.title, re.I)
                    lvl_num = int(lm.group(1)) if lm else (
                        0 if "cantrip" in lvl_block.title.lower() else None
                    )
                    for rows in parse_html_tables(lvl_block.body):
                        for row in rows:
                            if not row or not row[0]:
                                continue
                            nm = row[0].strip()
                            if nm.lower() in ("spell", "name", "school", "special"):
                                continue
                            special = row[2] if len(row) > 2 else ""
                            spell_list.append({
                                "name": nm,
                                "level": lvl_num,
                                "school": row[1] if len(row) > 1 else None,
                                "concentration": "C" in special,
                                "ritual": "R" in special,
                            })
            elif title in ("Metamagic Options", "Eldritch Invocation Options"):
                # Each option is its own sub-block with an italic cost or
                # prerequisite line, not an inline **Name.** run.
                opts = []
                for opt in subblocks(sub):
                    meta_line = opt.first_italic()
                    opts.append({
                        "name": opt.title,
                        "cost": meta_line if meta_line and "cost" in meta_line.lower()
                                else None,
                        "prerequisite": meta_line if meta_line
                                        and "prerequisite" in meta_line.lower() else None,
                        "text": clean(re.sub(r"^\s*_.+?_\s*$", "", opt.body,
                                             count=1, flags=re.M)),
                    })
                optional[slug(title)] = opts

        hit_die = None
        hd = traits.get("Hit Point Die", "")
        hm = re.search(r"D(\d+)", hd, re.I)
        if hm:
            hit_die = int(hm.group(1))

        saves = []
        for ab_name, ab in zip(
            ["Strength", "Dexterity", "Constitution",
             "Intelligence", "Wisdom", "Charisma"], ABILITIES
        ):
            if ab_name in traits.get("Saving Throw Proficiencies", ""):
                saves.append(ab)

        classes.append({
            "id": slug(name),
            "name": name,
            "primaryAbility": traits.get("Primary Ability"),
            "hitDie": hit_die,
            "savingThrows": saves,
            "skillChoices": traits.get("Skill Proficiencies"),
            "weaponProficiencies": traits.get("Weapon Proficiencies"),
            "toolProficiencies": traits.get("Tool Proficiencies"),
            "armorTraining": traits.get("Armor Training"),
            "startingEquipment": traits.get("Starting Equipment"),
            "progression": progression,
            "features": sorted(features, key=lambda f: (f["level"], f["name"])),
            "subclasses": subclasses,
            "spellList": sorted(
                {s["name"]: s for s in spell_list}.values(),
                key=lambda s: (s["level"] if s["level"] is not None else 99, s["name"]),
            ),
            "options": optional,
            "source": "SRD 5.2.1",
        })
    return classes


# --------------------------------------------------------------------------
# feats / species / backgrounds / magic items / glossary
# --------------------------------------------------------------------------

FEAT_SIG = re.compile(r"^(Origin|General|Fighting Style|Epic Boon)\s+Feat", re.I)


def parse_feats(blocks: list[Block]) -> list[dict[str, Any]]:
    feats = []
    for b in blocks:
        sig = b.first_italic()
        if not sig or not FEAT_SIG.match(sig.strip()):
            continue
        prereq = None
        pm = re.search(r"_Prerequisite:\s*(.+?)_", norm(b.body))
        if pm:
            prereq = pm.group(1).strip()
        body = re.sub(r"^\s*_.+?_\s*$", "", b.body, count=1, flags=re.M)
        feats.append({
            "id": slug(b.title),
            "name": b.title,
            "category": FEAT_SIG.match(sig.strip()).group(1).title(),
            "prerequisite": prereq,
            "benefits": italic_entries(body),
            "text": clean(body),
            "repeatable": "repeatable" in b.body.lower(),
            "source": "SRD 5.2.1",
        })
    return feats


def parse_under(blocks: list[Block], parent_title: str) -> list[Block]:
    """Return the child blocks of the section whose heading matches exactly."""
    for b in blocks:
        if b.title.strip().lower() == parent_title.lower():
            return subblocks(b)
    return []


def parse_species(blocks: list[Block]) -> list[dict[str, Any]]:
    out = []
    for b in parse_under(blocks, "Species Descriptions"):
        if b.level > 4:
            continue
        traits = kv_table(b.body)
        out.append({
            "id": slug(b.title),
            "name": b.title,
            "creatureType": traits.get("Creature Type"),
            "size": traits.get("Size"),
            "speed": traits.get("Speed"),
            "traits": italic_entries(b.body),
            "text": clean(re.sub(r"<table.*?</table>", "", b.body, flags=re.S)),
            "source": "SRD 5.2.1",
        })
    return out


def parse_backgrounds(blocks: list[Block]) -> list[dict[str, Any]]:
    out = []
    for b in parse_under(blocks, "Background Descriptions"):
        if b.level > 4:
            continue
        text = norm(b.body)
        def grab(label: str) -> str | None:
            # The SRD writes background field labels in BOLD ("**Equipment:**
            # value to end of line"), not italics - the italic form matched
            # nothing, which silently nulled all five structured fields on
            # every background. Both forms accepted; bold value runs to EOL
            # and may itself contain italics ("_Choose A or B:_ ...").
            m = re.search(
                rf"(?:_{label}:\s*(.+?)_|\*\*{label}:\*\*\s*(.+?)\s*$)",
                text, re.M)
            if not m:
                return None
            return (m.group(1) or m.group(2) or "").strip() or None
        out.append({
            "id": slug(b.title),
            "name": b.title,
            "abilityScores": grab("Ability Scores"),
            "feat": grab("Feat"),
            "skillProficiencies": grab("Skill Proficiencies"),
            "toolProficiency": grab("Tool Proficiency"),
            "equipment": grab("Equipment"),
            "text": clean(b.body),
            "source": "SRD 5.2.1",
        })
    return out


MI_SIG = re.compile(
    rf"^({MAGIC_ITEM_KINDS})\b\s*(?:\(([^)]*)\))?,?\s*(.*?)$", re.I
)


def parse_magic_items(blocks: list[Block]) -> list[dict[str, Any]]:
    items = []
    for b in blocks:
        sig = b.first_italic()
        if not sig:
            continue
        m = MI_SIG.match(sig.strip())
        if not m:
            continue
        kind, qualifier, rest = m.groups()
        rest = (rest or "").strip(" ,")
        attune = "attunement" in sig.lower()
        rarity = None
        for r in ("Legendary", "Very Rare", "Rare", "Uncommon", "Common", "Artifact"):
            if r.lower() in rest.lower():
                rarity = r
                break
        body = re.sub(r"^\s*_.+?_\s*$", "", b.body, count=1, flags=re.M)
        items.append({
            "id": slug(b.title),
            "name": b.title,
            "kind": kind.title(),
            "qualifier": qualifier,
            "rarity": rarity,
            "attunement": attune,
            "attunementNote": (
                re.search(r"[Rr]equires [Aa]ttunement([^)]*)", sig).group(1).strip()
                if attune and re.search(r"[Rr]equires [Aa]ttunement([^)]*)", sig) else None
            ),
            "text": clean(body),
            "source": "SRD 5.2.1",
        })
    return items


TAGGED = re.compile(r"^(.*?)\s*\[(Condition|Hazard|Action|Area of Effect)\]\s*$", re.I)


def parse_glossary(blocks: list[Block]) -> tuple[list[dict], list[dict]]:
    conditions, glossary = [], []
    for b in parse_under(blocks, "Rules Definitions"):
        m = TAGGED.match(b.title)
        name = m.group(1).strip() if m else b.title
        tag = m.group(2).title() if m else None
        entry = {
            "id": slug(name),
            "name": name,
            "tag": tag,
            "text": clean(b.body),
            "source": "SRD 5.2.1",
        }
        glossary.append(entry)
        if tag == "Condition":
            conditions.append(entry)
    return conditions, glossary


# --------------------------------------------------------------------------
# equipment
# --------------------------------------------------------------------------

PRICE_TITLE = re.compile(r"^(.*?)\s*\(([^)]*)\)\s*$")


def money_to_cp(text: str) -> int | None:
    m = re.match(r"^\s*([\d,.]+)\s*(CP|SP|EP|GP|PP)\s*$", (text or "").strip(), re.I)
    if not m:
        return None
    amount = float(m.group(1).replace(",", ""))
    mult = {"cp": 1, "sp": 10, "ep": 50, "gp": 100, "pp": 1000}[m.group(2).lower()]
    return int(round(amount * mult))


def parse_equipment(blocks: list[Block], raw: str) -> dict[str, Any]:
    weapons: list[dict[str, Any]] = []
    armor: list[dict[str, Any]] = []
    gear: list[dict[str, Any]] = []
    mastery: list[dict[str, str]] = []
    properties: list[dict[str, str]] = []

    for b in blocks:
        low = b.title.strip().lower()
        if low == "mastery properties":
            mastery = any_entries(head_text(b.body))
        elif low == "properties":
            properties = any_entries(head_text(b.body))

        if low == "weapons":
            for rows in parse_html_tables(b.body):
                header = [c.lower() for c in rows[0]]
                if not any("damage" in c for c in header):
                    continue
                category = None
                for row in rows[1:]:
                    cells = [c for c in row]
                    if len(cells) == 1:
                        category = cells[0]
                        continue
                    if len(cells) < 5:
                        continue
                    # Column order is Name | Damage | Properties | Mastery |
                    # Weight | Cost - weight precedes cost, not the reverse.
                    weapons.append({
                        "id": slug(cells[0]),
                        "name": cells[0],
                        "category": category,
                        "damage": cells[1],
                        "properties": cells[2],
                        "mastery": cells[3],
                        "weight": cells[4] if len(cells) > 4 else None,
                        "cost": cells[5] if len(cells) > 5 else None,
                        "costCp": money_to_cp(cells[5]) if len(cells) > 5 else None,
                        "kind": "weapon",
                        "source": "SRD 5.2.1",
                    })
        if low == "armor":
            for rows in parse_html_tables(b.body):
                header = [c.lower() for c in rows[0]]
                if not any("armor class" in c or c == "ac" for c in header):
                    continue
                category = None
                for row in rows[1:]:
                    if len(row) == 1:
                        category = row[0]
                        continue
                    if len(row) < 3:
                        continue
                    armor.append({
                        "id": slug(row[0]),
                        "name": row[0],
                        "category": category,
                        "ac": row[1],
                        "strength": row[2] if len(row) > 2 else None,
                        "stealth": row[3] if len(row) > 3 else None,
                        "weight": row[4] if len(row) > 4 else None,
                        "cost": row[5] if len(row) > 5 else None,
                        "costCp": money_to_cp(row[5]) if len(row) > 5 else None,
                        "kind": "armor",
                        "source": "SRD 5.2.1",
                    })

    # Adventuring gear: price lives in the heading, e.g. "#### Rope (1 GP)"
    for b in blocks:
        m = PRICE_TITLE.match(b.title)
        if not m:
            continue
        name, price = m.group(1).strip(), m.group(2).strip()
        cp = money_to_cp(price)
        if cp is None and price.lower() != "varies":
            continue
        gear.append({
            "id": slug(name),
            "name": name,
            "cost": price,
            "costCp": cp,
            "weight": labelled(b.body, "Weight"),
            "text": clean(b.body),
            "kind": "gear",
            "source": "SRD 5.2.1",
        })

    return {
        "weapons": weapons, "armor": armor, "gear": gear,
        "masteryProperties": mastery, "weaponProperties": properties,
    }


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------

def load(name: str) -> tuple[str, list[Block]]:
    path = SRC / name
    if not path.exists():
        print(f"  !! missing {name} - run tools/fetch_srd.py first", file=sys.stderr)
        return "", []
    raw = path.read_text(encoding="utf-8", errors="replace")
    return raw, split_blocks(raw, name)


def write(name: str, payload: Any) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"  wrote {name:<22} {path.stat().st_size:>9,} B")


def main() -> int:
    if not SRC.exists():
        print("srd_raw/ missing - run: python tools/fetch_srd.py", file=sys.stderr)
        return 1

    print("parsing SRD 5.2.1 ...")

    spells_raw, spell_blocks = load("spells.md")
    classes_raw, class_blocks = load("classes.md")
    mon_raw, mon_blocks = load("monsters-A-Z.md")
    ani_raw, ani_blocks = load("animals.md")
    eq_raw, eq_blocks = load("equipment.md")
    mi_raw, mi_blocks = load("magic-items.md")
    feat_raw, feat_blocks = load("feats.md")
    orig_raw, orig_blocks = load("character-origins.md")
    glos_raw, glos_blocks = load("rules-glossary.md")

    spells = REPORT.record("spells", parse_spells(spell_blocks))
    classes = REPORT.record("classes", parse_classes(class_blocks))
    subclasses = [s for c in classes for s in c["subclasses"]]
    REPORT.counts["subclasses"] = len(subclasses)
    overrides = load_overrides()
    monsters = REPORT.record(
        "monsters",
        parse_monsters(mon_blocks, overrides) + parse_monsters(ani_blocks, overrides),
    )
    equipment = parse_equipment(eq_blocks, eq_raw)
    REPORT.counts["weapons"] = len(equipment["weapons"])
    REPORT.counts["armor"] = len(equipment["armor"])
    REPORT.counts["gear"] = len(equipment["gear"])
    REPORT.counts["masteryProperties"] = len(equipment["masteryProperties"])
    magic_items = REPORT.record("magicItems", parse_magic_items(mi_blocks))
    feats = REPORT.record("feats", parse_feats(feat_blocks))
    species = REPORT.record("species", parse_species(orig_blocks))
    backgrounds = REPORT.record("backgrounds", parse_backgrounds(orig_blocks))
    conditions, glossary = parse_glossary(glos_blocks)
    REPORT.counts["conditions"] = len(conditions)
    REPORT.counts["glossary"] = len(glossary)

    print()
    write("spells.json", spells)
    write("classes.json", classes)
    write("monsters.json", monsters)
    write("equipment.json", equipment)
    write("magic-items.json", magic_items)
    write("feats.json", feats)
    write("species.json", species)
    write("backgrounds.json", backgrounds)
    write("conditions.json", conditions)
    write("glossary.json", glossary)

    # ---- validation pass -------------------------------------------------
    problems: list[str] = []

    # Cross-check parsed totals against the RAW SOURCE, not against our own
    # output. Counting what the parser produced and calling that "coverage"
    # only ever confirms the parser agrees with itself.
    src_spells = len(re.findall(
        rf"^_(?:[A-Za-z]+ Cantrip|Level \d+ (?:{SCHOOLS}))", norm(spells_raw), re.M
    ))
    if src_spells and len(spells) != src_spells:
        problems.append(
            f"spell coverage {len(spells)}/{src_spells} "
            f"({len(spells) / src_spells:.0%}) - {src_spells - len(spells)} missed"
        )
    REPORT.counts["spellsInSource"] = src_spells

    src_classes = len(re.findall(r"^## (?:" + "|".join(CLASS_NAMES) + r")\s*$",
                                 norm(classes_raw), re.M))
    if src_classes and len(classes) != src_classes:
        problems.append(f"class coverage {len(classes)}/{src_classes}")

    dupes = [n for n, c in Counter(s["id"] for s in spells).items() if c > 1]
    if dupes:
        problems.append(f"duplicate spell ids: {dupes[:5]}")
    for c in classes:
        if not c["hitDie"]:
            problems.append(f"class {c['name']}: no hit die parsed")
        if not c["features"]:
            problems.append(f"class {c['name']}: no features parsed")
        if not c["subclasses"]:
            problems.append(f"class {c['name']}: no subclass parsed")
    missing_cr = [m["name"] for m in monsters if m["cr"] is None]
    if missing_cr:
        problems.append(f"{len(missing_cr)} monsters without a numeric CR")
    # A monster with no Actions is legal (Shrieker Fungus has only a Reaction);
    # a monster with no entries in ANY section means the parse failed.
    inert = [
        m["name"] for m in monsters
        if not (m["traits"] or m["actions"] or m["bonusActions"]
                or m["reactions"] or m["legendaryActions"])
    ]
    if inert:
        problems.append(
            f"{len(inert)} monsters with no traits/actions of any kind: {inert[:5]}"
        )
    if not equipment["masteryProperties"]:
        problems.append("no weapon mastery properties parsed (2024 combat needs these)")

    # Column-order guards. The weapons table is Name|Damage|Properties|Mastery|
    # Weight|Cost; reading those last two in the wrong order yields a Greataxe
    # that costs "7 lb." and weighs "30 GP". Prices must parse as money.
    for kind in ("weapons", "armor"):
        bad = [i["name"] for i in equipment[kind] if i.get("costCp") is None]
        if bad:
            problems.append(
                f"{len(bad)} {kind} with unparseable cost (column order?): {bad[:4]}"
            )
        heavy = [i["name"] for i in equipment[kind]
                 if i.get("weight") and re.search(r"\b[CSEGP]P\b", i["weight"] or "")]
        if heavy:
            problems.append(
                f"{len(heavy)} {kind} whose weight looks like money "
                f"(cost/weight swapped): {heavy[:4]}"
            )

    cantrips = [s for s in spells if s["level"] == 0]
    if not cantrips:
        problems.append("no cantrips parsed - cantrips use 'School Cantrip' word order")

    for c in classes:
        if not c["spellList"]:
            continue
        # Half-casters (Paladin, Ranger) get spell levels 1-5 and no cantrips,
        # so a 38-entry list is correct for them and alarming for a full caster.
        half = max(s["level"] or 0 for s in c["spellList"]) <= 5
        floor_ = 25 if half else 60
        if len(c["spellList"]) < floor_:
            problems.append(
                f"class {c['name']}: spell list has only {len(c['spellList'])} "
                f"entries (reading the wrong table column?)"
            )
        for opt_key, opts in c["options"].items():
            if not opts:
                problems.append(f"class {c['name']}: '{opt_key}' parsed empty")
    no_level = [s["name"] for s in spells if s["level"] is None]
    if no_level:
        problems.append(f"{len(no_level)} spells without a level")

    meta = {
        "srdVersion": "5.2.1",
        "license": "CC-BY-4.0",
        "attribution": (
            "This work includes material from the System Reference Document 5.2.1 "
            "(\"SRD 5.2.1\") by Wizards of the Coast LLC, available at "
            "https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the "
            "Creative Commons Attribution 4.0 International License, available at "
            "https://creativecommons.org/licenses/by/4.0/legalcode."
        ),
        "counts": REPORT.counts,
        "problems": problems,
        "notes": REPORT.notes,
        "patchedMonsters": [m["name"] for m in monsters if m["abilitiesPatched"]],
        "unparsed": REPORT.unparsed,
    }
    write("_meta.json", meta)

    print("\ncoverage")
    for k, v in REPORT.counts.items():
        print(f"  {k:<20} {v:>5}")

    print("\nvalidation")
    if problems:
        for p in problems:
            print(f"  ! {p}")
    else:
        print("  clean - no structural problems detected")
    if REPORT.unparsed:
        print(f"  ! {len(REPORT.unparsed)} blocks looked like content but failed "
              f"to classify (see _meta.json)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
