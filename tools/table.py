"""The table: profiles, join codes, tokens, and who may write what.

WHAT THIS IS, AND WHAT IT IS NOT
--------------------------------
A join code stops somebody on the same wifi from wandering into your game by
accident. It is NOT authentication. Anyone determined who is already on your
network can watch traffic, and nothing here is encrypted. This is a tool for a
table in a room, on a network you trust - and the UI says so in those words
rather than implying a security property the design does not have.

What it DOES guarantee is that the rules below are enforced by the server. A
player's browser can ask for anything it likes; hiding a button proves nothing.
Every mutating request is checked here.

STATE
-----
data/table.json, gitignored, holding the code, the profiles, and one token per
joined browser. Deleting the file ends the table and revokes every token.
"""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLE = ROOT / "data" / "table.json"

_lock = threading.Lock()

# Deliberately short and readable aloud: a DM says this across a table.
# No vowels that turn into words, no 0/O or 1/I confusion.
CODE_ALPHABET = "ACDEFHJKLMNPRTUVWXY34679"
CODE_WORD = "ANVIL"


def _blank() -> dict:
    return {"open": False, "code": None, "createdAt": None,
            "profiles": {}, "tokens": {}}


def read() -> dict:
    if not TABLE.exists():
        return _blank()
    try:
        data = json.loads(TABLE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else _blank()
    except (json.JSONDecodeError, OSError):
        return _blank()


def _write(data: dict) -> None:
    TABLE.parent.mkdir(parents=True, exist_ok=True)
    TABLE.write_text(json.dumps(data, ensure_ascii=False, indent=1),
                     encoding="utf-8")


def new_code() -> str:
    return f"{CODE_WORD}-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))


def normalise_code(raw: str) -> str:
    """Accept 'anvil 4471', 'ANVIL-4471', '4471' - people retype these."""
    s = re.sub(r"[^A-Za-z0-9]", "", str(raw or "")).upper()
    if s.startswith(CODE_WORD):
        s = s[len(CODE_WORD):]
    return f"{CODE_WORD}-{s}"


# --------------------------------------------------------------------------
# lifecycle
# --------------------------------------------------------------------------

def open_table(dm_name: str = "DM") -> dict:
    """Start a table. Returns the code and the DM's own token."""
    with _lock:
        data = _blank()
        data["open"] = True
        data["code"] = new_code()
        data["createdAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        dm_id = "p-dm"
        data["profiles"][dm_id] = {
            "id": dm_id, "name": dm_name or "DM", "role": "dm",
            "colour": "#b84a16", "characterIds": [],
        }
        token = secrets.token_urlsafe(24)
        data["tokens"][token] = {"profileId": dm_id, "joinedAt": data["createdAt"]}
        _write(data)
        return {"ok": True, "code": data["code"], "token": token,
                "profile": data["profiles"][dm_id]}


def close_table() -> dict:
    """End it. Every token stops working immediately."""
    with _lock:
        _write(_blank())
    return {"ok": True, "closed": True}


def join(code: str, name: str, profile_id: str | None = None) -> dict:
    """Join with a code. Returns a token bound to a profile."""
    with _lock:
        data = read()
        if not data.get("open"):
            return {"ok": False, "error": "no table is open. Ask the DM to start one."}
        if normalise_code(code) != data.get("code"):
            # Deliberately vague: confirming which half was wrong helps guessing.
            return {"ok": False, "error": "that code does not match."}

        if profile_id and profile_id in data["profiles"]:
            prof = data["profiles"][profile_id]
        else:
            clean = (name or "Player").strip()[:40] or "Player"
            pid = f"p-{re.sub(r'[^a-z0-9]+', '-', clean.lower()).strip('-') or 'player'}"
            n = 1
            while pid in data["profiles"]:
                n += 1
                pid = f"{pid}-{n}"
            prof = {"id": pid, "name": clean, "role": "player",
                    "colour": None, "characterIds": []}
            data["profiles"][pid] = prof

        token = secrets.token_urlsafe(24)
        data["tokens"][token] = {"profileId": prof["id"],
                                 "joinedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
        _write(data)
        return {"ok": True, "token": token, "profile": prof}


def revoke(token: str) -> dict:
    with _lock:
        data = read()
        removed = data["tokens"].pop(token, None) is not None
        if removed:
            _write(data)
        return {"ok": True, "revoked": removed}


def whoami(token: str | None) -> dict | None:
    """The profile behind a token, or None."""
    if not token:
        return None
    data = read()
    if not data.get("open"):
        return None
    entry = data["tokens"].get(token)
    if not entry:
        return None
    return data["profiles"].get(entry["profileId"])


def status(token: str | None = None) -> dict:
    """Safe to hand to a browser: never includes the code or any token."""
    data = read()
    me = whoami(token)
    return {
        "open": bool(data.get("open")),
        "createdAt": data.get("createdAt"),
        "me": me,
        "profiles": [
            {"id": p["id"], "name": p["name"], "role": p["role"],
             "colour": p.get("colour"), "characterIds": p.get("characterIds", [])}
            for p in data.get("profiles", {}).values()
        ],
        "playerCount": sum(1 for p in data.get("profiles", {}).values()
                           if p["role"] == "player"),
    }


def set_owner(profile_id: str, character_id: str) -> dict:
    """Bind a character to a profile."""
    with _lock:
        data = read()
        prof = data.get("profiles", {}).get(profile_id)
        if not prof:
            return {"ok": False, "error": "no such profile"}
        ids = set(prof.get("characterIds", []))
        ids.add(character_id)
        prof["characterIds"] = sorted(ids)
        _write(data)
        return {"ok": True, "profile": prof}


# --------------------------------------------------------------------------
# permissions
# --------------------------------------------------------------------------

# Kinds a player may never write, whatever they own. These change the shared
# world rather than one character.
SHARED_KINDS = {"homebrew", "campaigns", "npcs", "shops", "encounters",
                "custom-monsters", "custom-items", "custom-spells"}


# --------------------------------------------------------------------------
# what a player is allowed to SEE
# --------------------------------------------------------------------------

def hp_band(hp: float, hp_max: float) -> str:
    """How hurt something looks from across the room.

    Four bands, because that is roughly what a player can tell by looking:
    unhurt, hurt, bloodied (the half-way mark 5e already uses), and down.
    """
    if hp <= 0:
        return "down"
    frac = (hp / hp_max) if hp_max else 1.0
    if frac <= 0.5:
        return "bloodied"
    if frac < 1.0:
        return "hurt"
    return "unhurt"


def redact_encounter(record: dict, profile: dict | None) -> dict:
    """Strip monster hit points unless the DM chose to show them.

    Done HERE rather than in the renderer, for the same reason the permission
    table is enforced on the server: hiding a number in the UI leaves it in the
    payload, and a player with the network tab open would read exactly the
    number the DM decided not to show. A band goes over the wire instead, so
    there is nothing to uncover.

    Player characters keep their numbers. Everyone at a real table can see
    their own sheet and hears "I'm at 4 hit points" said out loud.
    """
    if not isinstance(record, dict):
        return record
    # No table, or the DM: nothing to hide from.
    if profile is None or profile.get("role") == "dm":
        return record
    if record.get("showMonsterHp"):
        return record

    out = dict(record)
    out["combatants"] = []
    for c in record.get("combatants") or []:
        if not isinstance(c, dict) or c.get("kind") == "pc":
            out["combatants"].append(c)
            continue
        hidden = dict(c)
        hidden["band"] = hp_band(c.get("hp") or 0, c.get("hpMax") or 0)
        hidden["hpHidden"] = True
        for key in ("hp", "hpMax", "temp"):
            hidden.pop(key, None)
        out["combatants"].append(hidden)
    return out


def may_write(profile: dict | None, kind: str, record_id: str,
              existing: dict | None = None, exists: bool = False) -> tuple[bool, str]:
    """May this profile write this record? Returns (allowed, reason).

    `existing` is the record ALREADY ON DISK, never the incoming body, and
    `exists` says whether there is one at all.

    That distinction is the whole security of this function. An earlier version
    read ownerId out of the request, which the caller controls completely: a
    player could overwrite anybody's character simply by omitting the field,
    because a missing owner looked like an unclaimed record. Ownership is a
    fact about what is stored, so it is read from what is stored.

    With NO TABLE OPEN this is never consulted - single-player must not grow a
    login, so serve.py only calls it once a table exists.
    """
    if profile is None:
        return False, ("a table is open, so this needs a join code. "
                       "Ask the DM for it.")

    if profile.get("role") == "dm":
        # Admin, deliberately: a DM applies a curse, fixes a typo'd score, or
        # hands out loot without asking the player to do it for them.
        return True, ""

    if kind in SHARED_KINDS:
        return False, f"only the DM can change {kind}."

    if kind == "characters":
        owned = set(profile.get("characterIds", []))
        if record_id in owned:
            return True, ""
        if not exists:
            # Genuinely new: whoever creates it may create it. The claim is
            # recorded separately, so this cannot be used to take one over.
            return True, ""
        stored_owner = (existing or {}).get("ownerId")
        if stored_owner == profile["id"]:
            return True, ""
        if stored_owner is None:
            # Pre-existing and unowned - a character made before the table was
            # opened. First claim wins rather than free-for-all editing.
            return False, ("that character has no owner yet. Ask the DM to "
                           "assign it to you.")
        return False, "that is somebody else's character."

    if kind == "profiles":
        if record_id == profile["id"]:
            return True, ""
        return False, "you can only change your own profile."

    return False, f"players cannot change {kind}."


def may_read(profile: dict | None, kind: str) -> tuple[bool, str]:
    """Reads are open to anyone at the table.

    A shared bestiary and a shared library are the point of playing together,
    and a player who can see another sheet is how a table already works - they
    are sitting next to each other. Secrecy lives in what the DM chooses to
    put on the shared encounter, not in hiding the compendium.
    """
    if profile is None:
        return False, "a table is open, so this needs a join code."
    return True, ""
