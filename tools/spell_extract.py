"""Extract executable mechanics from SRD spell prose.

    python tools/spell_extract.py

The compendium stores spells as rules TEXT, which is a faithful conversion but
useless to a simulator: a caster whose spells do nothing contributes nothing,
and a campaign emulator would then "discover" that Fighters dominate Wizards.
That would be an artifact of the harness, not a fact about the game.

So this pulls structured mechanics out of the prose - damage dice and type,
saving throw and whether a success halves, spell attack rolls, healing, area,
projectile counts, upcast and cantrip scaling.

Two honesty rules are built in:

  * `executable` is only true when we found something we can actually RUN. A
    spell we half-understand is marked non-executable, not guessed at.
  * Coverage is reported per spell AND per class spell list, because that is
    what gates balance claims downstream. A Wizard's damage number computed from
    a 40%-working spellbook is not a measurement.

Hand-patches live in tools/spell_overrides.json - same pattern as
monster_overrides.json.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
COMPENDIUM = ROOT / "app" / "data" / "compendium"
OUT = ROOT / "app" / "data" / "spell-mechanics.json"
OVERRIDES = Path(__file__).resolve().parent / "spell_overrides.json"

ABIL = {
    "strength": "str", "dexterity": "dex", "constitution": "con",
    "intelligence": "int", "wisdom": "wis", "charisma": "cha",
}
ABIL_RE = "Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma"
DMG_RE = ("Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|"
          "Poison|Psychic|Radiant|Slashing|Thunder")
SHAPES = "Sphere|Cube|Cone|Line|Cylinder|Emanation"

NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}

CONDITIONS = [
    "Blinded", "Charmed", "Deafened", "Frightened", "Grappled", "Incapacitated",
    "Invisible", "Paralyzed", "Petrified", "Poisoned", "Prone", "Restrained",
    "Stunned", "Unconscious",
]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


# --------------------------------------------------------------------------
# individual extractors
# --------------------------------------------------------------------------

def find_damage(text: str) -> tuple[str | None, str | None, str | None]:
    """Return (dice, flat_bonus, type).

    The corpus writes damage three different ways and all three occur in spells
    a simulated caster leans on:
        "1d4 + 1 Force damage"          dice then type   (Magic Missile)
        "Force damage equal to 4d12"    type then dice   (Arcane Sword)
        "3d8 damage of the chosen type" untyped          (Chromatic Orb)
    """
    m = re.search(
        rf"(\d+d\d+)(?:\s*\+\s*(\d+))?\s+({DMG_RE})\s+damage", text, re.I,
    )
    if m:
        return m.group(1), m.group(2), m.group(3).lower()

    m = re.search(
        rf"({DMG_RE})\s+damage equal to\s+(\d+d\d+)(?:\s*\+\s*(\d+))?", text, re.I,
    )
    if m:
        return m.group(2), m.group(3), m.group(1).lower()

    # "5d8 Acid, Cold, Fire, Lightning, or Thunder damage" - a choice of types.
    # Take the first; for simulation purposes the type only matters for
    # resistance, and the caster would pick whatever the target is weak to.
    m = re.search(
        rf"(\d+d\d+)\s+((?:{DMG_RE})(?:\s*,\s*(?:{DMG_RE}))*"
        rf"(?:\s*,?\s*or\s+(?:{DMG_RE}))?)\s+damage", text, re.I,
    )
    if m:
        first = re.search(DMG_RE, m.group(2), re.I)
        return m.group(1), None, first.group(0).lower() if first else None

    # "damage of the chosen type" / "damage of a type you choose"
    m = re.search(
        r"(\d+d\d+)\s+damage of (?:the|a)\s+(?:chosen|spell'?s?|same|type)",
        text, re.I,
    )
    if m:
        return m.group(1), None, None

    # "The spell's base damage is 12d6" (Delayed Blast Fireball)
    m = re.search(r"base damage is\s+(\d+d\d+)", text, re.I)
    if m:
        return m.group(1), None, None
    return None, None, None


def find_temp_hp(text: str) -> str | None:
    """Temporary hit points, written two ways.

        "You gain 2d4 + 4 Temporary Hit Points"                    False Life
        "gains Temporary Hit Points equal to your ... modifier"     Heroism
    """
    m = re.search(
        r"gains?\s+(\d+d\d+(?:\s*\+\s*\d+)?|\d+)\s+Temporary Hit Points", text, re.I,
    )
    if m:
        return re.sub(r"\s+", "", m.group(1))
    m = re.search(
        r"Temporary Hit Points equal to\s+(\d+d\d+(?:\s*\+\s*\d+)?|\d+)", text, re.I,
    )
    if m:
        return re.sub(r"\s+", "", m.group(1))
    # "equal to your spellcasting ability modifier" - resolved at cast time.
    if re.search(r"Temporary Hit Points equal to your\s+\w+", text, re.I):
        return "mod"
    return None


def find_rider(text: str) -> dict[str, Any] | None:
    """Bonus damage added to the caster's attacks, not dealt by the spell."""
    m = re.search(
        rf"deals?\s+an extra\s+(\d+d\d+)\s+(?:({DMG_RE})\s+)?damage", text, re.I,
    )
    if m:
        return {"dice": m.group(1), "damageType": (m.group(2) or "").lower() or None}
    return None


def find_save(text: str) -> dict[str, Any] | None:
    m = re.search(rf"({ABIL_RE})\s+saving throw", text, re.I)
    if not m:
        return None
    return {"ability": ABIL[m.group(1).lower()]}


def find_half_on_save(text: str) -> bool:
    return bool(re.search(
        r"half as much damage on a success|"
        r"half as much damage on a successful|"
        r"takes half damage", text, re.I,
    ))


def find_attack(text: str) -> str | None:
    m = re.search(r"(ranged|melee)\s+spell attack", text, re.I)
    if m:
        return m.group(1).lower()
    if re.search(r"spell attack roll", text, re.I):
        return "ranged"
    return None


def find_healing(text: str) -> tuple[str | None, bool]:
    """Healing amount, and whether the spellcasting modifier is added.

    Four phrasings occur, and only the first was originally handled:
        "regains Hit Points equal to 2d8 plus your ..."  (Cure Wounds)
        "regains 4d8 + 15 Hit Points"                    (Regenerate)
        "regains 70 Hit Points"                          (Heal)
        "restores 1 Hit Point"                           (Goodberry)
    """
    # "regains all its Hit Points" - Power Word Heal. Modelled as a large flat
    # number rather than a special case; nothing in the sim has 999 max HP.
    if re.search(r"regains all (?:its|their) Hit Points", text, re.I):
        return "999", False

    patterns = [
        r"regains?\s+(?:a number of\s+)?Hit Points equal to\s+(\d+d\d+(?:\s*\+\s*\d+)?|\d+)",
        r"regains?\s+(\d+d\d+(?:\s*\+\s*\d+)?)\s+Hit Points",
        r"regains?\s+(\d+)\s+Hit Points",
        r"restor(?:es?|ing)\s+(?:up to\s+)?(\d+d\d+(?:\s*\+\s*\d+)?|\d+)\s+Hit Points?",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.I)
        if m:
            tail = text[m.end():m.end() + 80]
            adds_mod = bool(
                re.search(r"plus your spellcasting ability modifier", tail, re.I),
            )
            return re.sub(r"\s+", "", m.group(1)), adds_mod
    return None, False


def find_area(text: str) -> dict[str, Any] | None:
    m = re.search(rf"(\d+)-foot(?:-radius|-wide|-long|-tall)?\s+({SHAPES})", text, re.I)
    if not m:
        return None
    return {"size": int(m.group(1)), "shape": m.group(2).lower()}


def find_projectiles(text: str) -> int | None:
    """Magic Missile's 'three glowing darts' - the total is per-dart x count."""
    m = re.search(
        r"\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+"
        r"(?:glowing\s+)?(darts?|bolts?|rays?|beams?|missiles?)\b", text, re.I,
    )
    if not m:
        return None
    raw = m.group(1).lower()
    return NUMBER_WORDS.get(raw, int(raw) if raw.isdigit() else None)


def find_condition(text: str) -> list[str] | None:
    """Conditions applied by the spell.

    Written as both "has the X condition" and "have the X condition" depending
    on subject number, and sometimes as a choice ("the Blinded or Deafened
    condition"). Matching only "has the" loses Hold Person and Color Spray.
    """
    found = []
    pattern = re.compile(
        rf"ha(?:s|ve) the ((?:{'|'.join(CONDITIONS)})"
        rf"(?:\s+or\s+(?:{'|'.join(CONDITIONS)}))?)\s+condition", re.I,
    )
    for m in pattern.finditer(text):
        for part in re.split(r"\s+or\s+", m.group(1)):
            name = part.strip().title()
            if name in CONDITIONS and name not in found:
                found.append(name)
    return found or None


def find_modifier(text: str) -> dict[str, Any] | None:
    """Bless/Bane-style flat modifiers to d20 tests.

    These carry no damage and apply no condition, so an outcome-only test calls
    them non-executable - but they are among the most impactful combat spells in
    the game and the engine can apply them exactly.
    """
    m = re.search(
        r"adds?\s+(\d+d\d+)\s+to\s+the\s+attack roll(?:\s+or\s+(?:the\s+)?sav\w+)?",
        text, re.I,
    )
    if m:
        return {"dice": m.group(1), "sign": 1, "applies": "attack_and_save"}
    # Guidance: "adds 1d4 to any ability check using the chosen skill"
    m = re.search(r"adds?\s+(\d+d\d+)\s+to\s+(?:any|the)\s+ability check", text, re.I)
    if m:
        return {"dice": m.group(1), "sign": 1, "applies": "ability_check"}
    # Resistance: "reduces the total damage taken by 1d4"
    m = re.search(r"reduces? the total damage taken by\s+(\d+d\d+)", text, re.I)
    if m:
        return {"dice": m.group(1), "sign": -1, "applies": "damage_taken"}
    m = re.search(
        r"subtracts?\s+(\d+d\d+)\s+from\s+the\s+(?:attack roll|d20 Test)"
        r"(?:\s+or\s+(?:the\s+)?sav\w+)?",
        text, re.I,
    )
    if m:
        return {"dice": m.group(1), "sign": -1, "applies": "attack_and_save"}
    # "Hit Point maximum and current Hit Points increase by 5" (Aid)
    m = re.search(r"Hit Points? (?:maximum|maximums).{0,60}?increase by (\d+)", text, re.I)
    if m:
        return {"flat": int(m.group(1)), "sign": 1, "applies": "hp_max"}
    return None


def find_upcast(higher: str | None) -> dict[str, Any] | None:
    if not higher:
        return None
    m = re.search(r"(damage|healing)\s+increases by\s+(\d+d\d+)", higher, re.I)
    if m:
        return {"kind": m.group(1).lower(), "perLevel": m.group(2)}
    m = re.search(r"(?:creates|create)\s+(one|two|\d+)\s+more\s+(\w+)", higher, re.I)
    if m:
        raw = m.group(1).lower()
        n = NUMBER_WORDS.get(raw, int(raw) if raw.isdigit() else 1)
        return {"kind": "projectiles", "perLevel": n}
    m = re.search(r"targets?\s+(one|two|\d+)\s+additional", higher, re.I)
    if m:
        raw = m.group(1).lower()
        return {"kind": "targets", "perLevel": NUMBER_WORDS.get(raw, 1)}
    return None


def find_cantrip_scaling(upgrade: str | None) -> list[list[Any]] | None:
    """'increases by 1d10 when you reach levels 5 (2d10), 11 (3d10), 17 (4d10)'."""
    if not upgrade:
        return None
    pairs = re.findall(r"(\d+)\s*\((\d+d\d+)\)", upgrade)
    if not pairs:
        return None
    return [[int(lvl), dice] for lvl, dice in pairs]


# --------------------------------------------------------------------------
# per-spell
# --------------------------------------------------------------------------

def extract(spell: dict[str, Any]) -> dict[str, Any]:
    text = norm(spell.get("text", ""))
    higher = spell.get("higherLevel")
    upgrade = spell.get("cantripUpgrade")

    dice, flat, dtype = find_damage(text)
    healing, heal_mod = find_healing(text)
    save = find_save(text)
    attack = find_attack(text)
    area = find_area(text)
    projectiles = find_projectiles(text) if dice else None
    condition = find_condition(text)
    modifier = find_modifier(text)
    temp_hp = find_temp_hp(text)
    rider = find_rider(text)

    # Executable means the engine can compute an outcome for it. Anything else
    # is utility, and we say so rather than guess.
    executable = bool(
        dice or healing or temp_hp or rider or modifier or (save and condition),
    )

    kind = ("damage" if dice else "healing" if healing or temp_hp
            else "rider" if rider
            else "condition" if condition else "buff" if modifier
            else "utility")

    # Confidence reflects how much of the resolution path we pinned down, not
    # how much text we matched.
    confidence = 0.0
    if dice or healing:
        confidence = 0.6
        if save or attack or projectiles is not None:
            confidence = 0.9
        if dtype:
            confidence = min(1.0, confidence + 0.05)
        if (save and not find_half_on_save(text)
                and re.search(r"on a failed save", text, re.I)):
            confidence = min(confidence, 0.8)
    elif save and condition:
        confidence = 0.75
    elif temp_hp:
        confidence = 0.8
    elif rider:
        confidence = 0.75
    elif modifier:
        confidence = 0.7

    return {
        "kind": kind,
        "modifier": modifier,
        "tempHp": temp_hp,
        "rider": rider,
        "id": spell["id"],
        "name": spell["name"],
        "level": spell["level"],
        "executable": executable,
        "confidence": round(confidence, 2),
        "damage": dice,
        "damageFlat": int(flat) if flat else None,
        "damageType": dtype,
        "projectiles": projectiles,
        "save": save,
        "halfOnSave": find_half_on_save(text) if save else False,
        "attackRoll": attack,
        "healing": healing,
        "healingAddsMod": heal_mod,
        "area": area,
        "condition": condition,
        "concentration": bool(spell.get("concentration")),
        "ritual": bool(spell.get("ritual")),
        "upcast": find_upcast(higher),
        "cantripScaling": find_cantrip_scaling(upgrade),
        "classes": spell.get("classes", []),
        "source": "extracted",
    }


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------

def load(name: str):
    path = COMPENDIUM / f"{name}.json"
    if not path.exists():
        print(f"missing {path} - run tools/srd_convert.py first", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    spells = load("spells")
    classes = load("classes")

    overrides = {}
    if OVERRIDES.exists():
        raw = json.loads(OVERRIDES.read_text(encoding="utf-8"))
        overrides = {k: v for k, v in raw.items() if not k.startswith("_")}

    mechanics = {}
    patched = []
    for spell in spells:
        mech = extract(spell)
        if spell["id"] in overrides:
            mech.update(overrides[spell["id"]])
            mech["source"] = "override"
            mech["executable"] = True
            mech["confidence"] = 1.0
            patched.append(spell["name"])
        mechanics[spell["id"]] = mech

    executable = [m for m in mechanics.values() if m["executable"]]
    damaging = [m for m in executable if m["damage"]]
    healing = [m for m in executable if m["healing"]]

    # ---- per-class coverage: this is what gates balance claims (H6) --------
    by_class = {}
    for cls in classes:
        spell_list = cls.get("spellList") or []
        if not spell_list:
            continue
        ids = []
        for entry in spell_list:
            match = next((s for s in spells if s["name"] == entry["name"]), None)
            if match:
                ids.append(match["id"])
        total = len(ids)
        ok = sum(1 for i in ids if mechanics[i]["executable"])

        # Raw list coverage conflates two very different things: "the extractor
        # failed on combat spells" (a defect that invalidates simulated output)
        # and "this class has a lot of utility spells" (true of Rangers, and
        # perfectly fine). Only the first should ever block a balance claim.
        #
        # combatCandidates = spells whose PROSE looks combat-relevant at all.
        # combatCoverage   = how many of those we can actually run.
        # The denominator must not be defined by what we managed to extract, or
        # coverage becomes self-confirming. It also must not be "mentions a
        # saving throw", which sweeps in Detect Thoughts and Animal Messenger
        # and understates coverage by counting social utility as combat.
        #
        # A spell is a combat candidate if its PROSE contains dice, a spell
        # attack, or one of the 14 combat conditions. All three are independent
        # of whether extraction succeeded.
        cond_re = "|".join(CONDITIONS)
        candidates = []
        for i in ids:
            raw = next(s for s in spells if s["id"] == i)
            if re.search(rf"\d+d\d+|spell attack|(?:{cond_re})\s+condition",
                         raw["text"], re.I):
                candidates.append(i)
        covered = sum(1 for i in candidates if mechanics[i]["executable"])

        by_class[cls["id"]] = {
            "listed": total,
            "executable": ok,
            "coverage": round(ok / total, 3) if total else 0.0,
            "combatCandidates": len(candidates),
            "combatCovered": covered,
            "combatCoverage": round(covered / len(candidates), 3) if candidates else 1.0,
        }

    payload = {
        "srdVersion": "5.2.1",
        "generated": "tools/spell_extract.py",
        "counts": {
            "spells": len(spells),
            "executable": len(executable),
            "damaging": len(damaging),
            "healing": len(healing),
            "overridden": len(patched),
            "utilityNotSimulated": len(spells) - len(executable),
        },
        "coverageByClass": by_class,
        "patched": patched,
        # Named explicitly so nothing hides: these are the spells a simulated
        # caster will simply never be able to use.
        "notExecutable": sorted(
            m["name"] for m in mechanics.values() if not m["executable"]
        ),
        "mechanics": mechanics,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"wrote {OUT.name}  {OUT.stat().st_size:,} B\n")
    print("coverage")
    c = payload["counts"]
    print(f"  spells              {c['spells']:>4}")
    print(f"  executable          {c['executable']:>4}"
          f"  ({c['executable'] * 100 // c['spells']}%)")
    print(f"    damaging          {c['damaging']:>4}")
    print(f"    healing           {c['healing']:>4}")
    print(f"    hand-patched      {c['overridden']:>4}")
    print(f"  utility (not sim'd) {c['utilityNotSimulated']:>4}")
    print("\nper-class coverage       list        combat-relevant only")
    for cid, info in sorted(by_class.items()):
        bar = "#" * int(info["combatCoverage"] * 24)
        print(f"  {cid:<10} {info['executable']:>3}/{info['listed']:<3}"
              f" {info['coverage'] * 100:>5.1f}%   "
              f"{info['combatCovered']:>3}/{info['combatCandidates']:<3}"
              f" {info['combatCoverage'] * 100:>5.1f}%  {bar}")

    # ---- validation ------------------------------------------------------
    problems = []
    for name in ("Fireball", "Magic Missile", "Cure Wounds", "Fire Bolt",
                 "Guiding Bolt", "Sacred Flame", "Healing Word"):
        s = next((x for x in spells if x["name"] == name), None)
        if not s:
            problems.append(f"{name} missing from compendium")
            continue
        m = mechanics[s["id"]]
        if not m["executable"]:
            problems.append(f"{name} is not executable - a staple spell must be")

    # The gate is combat-relevant coverage, not raw list coverage. A class with
    # many utility spells is not a defect; a class whose DAMAGE spells we cannot
    # run is, because its simulated output would be systematically understated.
    low = sorted(
        (cid, i["combatCoverage"]) for cid, i in by_class.items()
        if i["combatCoverage"] < 0.70
    )
    if low:
        problems.append(
            "classes below the 70% combat-relevant coverage gate: "
            + ", ".join(f"{c} ({v:.0%})" for c, v in low)
            + " - balance claims for these will be SUPPRESSED"
        )

    print("\nvalidation")
    if problems:
        for p in problems:
            print(f"  ! {p}")
    else:
        print("  clean - staple spells resolve, every class clears the "
              "combat-coverage gate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
