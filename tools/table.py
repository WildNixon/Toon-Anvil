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
            "profiles": {}, "tokens": {}, "forgeOpen": False, "grants": {},
            # The lobby latch. False while everyone is still gathering,
            # True once the DM says go - which is what lets five phones
            # leave the queue together instead of one at a time.
            "started": False,
            # What the room is playing. Before this, "which campaign" was a
            # per-browser answer (an active flag plus localStorage), so the
            # session itself never knew - and the queue could not tell a
            # player what they were queueing for. Id and display name ONLY:
            # everything else about a campaign stays behind redact_campaign.
            "campaignId": None, "campaignName": None}


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

def open_table(dm_name: str = "DM", campaign_id: str | None = None,
               campaign_name: str | None = None) -> dict:
    """Start a table. Returns the code and the DM's own token.

    The campaign is optional on purpose: a pickup one-shot with forged
    pregens is a first-class way to play, not a degraded one.
    """
    with _lock:
        data = _blank()
        data["open"] = True
        data["code"] = new_code()
        data["campaignId"] = campaign_id or None
        data["campaignName"] = (str(campaign_name).strip()[:80] or None) \
            if campaign_name else None
        # Session zero starts with the forge open: players make and rebuild
        # their characters freely until the DM closes it for the campaign.
        data["forgeOpen"] = True
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


def join(code: str, name: str) -> dict:
    """Join with a code. Returns a token bound to a NEW player profile.

    This used to accept a profile_id and hand back a token bound to it if
    the id existed. That was a back door with the lid off: "p-dm" always
    exists (open_table creates it below), so one POST carrying the code
    everybody at the table can already see returned a token with
    role="dm" - the forge, the grants, close, monster hit points, secret
    clocks, faction agendas, prepared encounters, the shelf. Measured, not
    theorised. Naming a profile is not proof you are its owner; the token
    is, and a browser that still holds one never calls join at all.

    So the code buys a seat, and only ever a player's seat. The DM's seat
    comes from open_table(), which is loopback-only - physical access to
    the machine is the anchor, exactly as it was before. Nothing in app/
    ever sent profile_id (session.js defaults it to null), so no honest
    client notices this is gone.
    """
    with _lock:
        data = read()
        if not data.get("open"):
            return {"ok": False, "error": "no table is open. Ask the DM to start one."}
        if normalise_code(code) != data.get("code"):
            # Deliberately vague: confirming which half was wrong helps guessing.
            return {"ok": False, "error": "that code does not match."}

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
    grants = data.get("grants", {}) or {}
    if me and me.get("role") == "dm":
        visible_grants = dict(grants)
    elif me:
        mine = set(me.get("characterIds", []))
        visible_grants = {k: v for k, v in grants.items() if k in mine}
    else:
        visible_grants = {}
    return {
        "open": bool(data.get("open")),
        "createdAt": data.get("createdAt"),
        # The whole gate is visible state: a player's Build appears and
        # disappears off these two fields.
        "forgeOpen": bool(data.get("forgeOpen")),
        # Public, like forgeOpen: every seat's lobby watches this to know
        # when to stop waiting. It is not a secret and it is not a permission.
        "started": bool(data.get("started")),
        # Also public: the queue tells everyone what the room is playing.
        # The NAME is already player-visible through redact_campaign; the
        # rest of the campaign record never rides the table status.
        "campaignId": data.get("campaignId"),
        "campaignName": data.get("campaignName"),
        "grants": visible_grants,
        "me": me,
        "profiles": [
            {"id": p["id"], "name": p["name"], "role": p["role"],
             "colour": p.get("colour"), "characterIds": p.get("characterIds", [])}
            for p in data.get("profiles", {}).values()
        ],
        "playerCount": sum(1 for p in data.get("profiles", {}).values()
                           if p["role"] == "player"),
    }


def set_owner(profile_id: str, character_id: str, force: bool = False) -> dict:
    """Bind a character to a profile. A claimed character is not up for grabs.

    Claiming used to be unconditional, which meant a seated player could
    POST somebody else's character id and be granted write access to their
    sheet - may_write() reports is_mine for BOTH profiles once both list
    the id. Proven: Alice claims her hero, Bob claims the same hero, Bob
    PUTs over it, and the file on disk comes back named after Bob.

    The same gap made the honest case racy - two phones tapping the same
    pregen in the claim strip both "succeeded", and the party quietly had
    one character with two owners.

    `force` is the DM's override, because handing a character to another
    player is a real thing a DM does mid-campaign. serve.py passes it only
    when the token's role is dm.
    """
    with _lock:
        data = read()
        profiles = data.get("profiles", {})
        prof = profiles.get(profile_id)
        if not prof:
            return {"ok": False, "error": "no such profile"}

        holder = next((p for p in profiles.values()
                       if p["id"] != profile_id
                       and character_id in (p.get("characterIds") or [])), None)
        if holder and not force:
            return {"ok": False,
                    "error": f"{holder['name']} is already playing that character."}
        if holder and force:
            # A handover, not a copy: one character has one player.
            holder["characterIds"] = [c for c in holder["characterIds"]
                                      if c != character_id]

        ids = set(prof.get("characterIds", []))
        ids.add(character_id)
        prof["characterIds"] = sorted(ids)
        _write(data)
        return {"ok": True, "profile": prof}


def restyle_profile(profile_id: str, patch: dict) -> dict:
    """Carry a profile's COSMETIC fields into the table record.

    The kind file under data/profiles/ is the shelf copy; this record is
    what status() hands every seat. Only name and colour cross - role and
    character bindings are the server's own, whatever a payload claims.
    """
    with _lock:
        data = read()
        prof = data.get("profiles", {}).get(profile_id)
        if not prof:
            return {"ok": False, "error": "no such profile"}
        if isinstance(patch.get("name"), str) and patch["name"].strip():
            prof["name"] = patch["name"].strip()[:40]
        colour = patch.get("colour")
        if colour is None or (isinstance(colour, str)
                              and re.fullmatch(r"#[0-9a-fA-F]{6}", colour)):
            prof["colour"] = colour
        _write(data)
        return {"ok": True, "profile": prof}


# --------------------------------------------------------------------------
# the forge and the grants
# --------------------------------------------------------------------------

def total_level(record: dict | None) -> int:
    """A character's total level: the sum across classes. 0 for anything odd."""
    if not isinstance(record, dict):
        return 0
    total = 0
    for c in record.get("classes") or []:
        if isinstance(c, dict):
            try:
                total += int(c.get("level") or 0)
            except (TypeError, ValueError):
                pass
    return total


def set_forge(open_: bool) -> dict:
    """Open or close the forge. While open, players create and rebuild."""
    with _lock:
        data = read()
        if not data.get("open"):
            return {"ok": False, "error": "no table is open"}
        data["forgeOpen"] = bool(open_)
        _write(data)
        return {"ok": True, "forgeOpen": data["forgeOpen"]}


def set_started(started: bool) -> dict:
    """Begin the session, or send everyone back to the lobby.

    Separate from `open`: a table can be open for ten minutes while people
    pick characters and argue about names. Starting is the moment the DM
    says go, and it is what every seat is waiting on.
    """
    with _lock:
        data = read()
        if not data.get("open"):
            return {"ok": False, "error": "no table is open"}
        data["started"] = bool(started)
        _write(data)
        return {"ok": True, "started": data["started"]}


def set_grant(character_id: str, max_total_level: int) -> dict:
    """Grant a character permission to reach a total level."""
    with _lock:
        data = read()
        if not data.get("open"):
            return {"ok": False, "error": "no table is open"}
        data.setdefault("grants", {})[character_id] = int(max_total_level)
        _write(data)
        return {"ok": True, "granted": {character_id: int(max_total_level)}}


def clear_grant(character_id: str) -> bool:
    with _lock:
        data = read()
        removed = data.get("grants", {}).pop(character_id, None) is not None
        if removed:
            _write(data)
        return removed


def consume_grant(character_id: str, record: dict | None) -> bool:
    """Clear a grant once the character has reached it.

    Called after a successful write, whoever made it - the DM levelling a
    player's sheet for them consumes the grant too. One locked read-check-pop
    so two concurrent saves cannot both consume.
    """
    with _lock:
        data = read()
        grants = data.get("grants", {})
        cap = grants.get(character_id)
        if cap is None:
            return False
        if total_level(record) < int(cap):
            return False
        grants.pop(character_id, None)
        _write(data)
        return True


# --------------------------------------------------------------------------
# permissions
# --------------------------------------------------------------------------

# Kinds a player may never write, whatever they own. These change the shared
# world rather than one character.
SHARED_KINDS = {"homebrew", "campaigns", "npcs", "shops", "encounters", "maps",
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


# Fields a player may only change at the forge (or under a grant). Everything
# else - hit points, inventory, prepared spells, conditions - is PLAY, and
# play must never need the DM's permission.
FROZEN_FIELDS = ("name", "species", "background", "abilities", "abilityBonuses",
                 "abilityMethod", "classes", "skills", "expertise", "feats")


def _canon(v):
    """Order-insensitive, None == missing - so a field merely omitted from the
    payload does not read as a change."""
    return json.dumps(v, sort_keys=True, ensure_ascii=False) if v is not None else None


def may_write(profile: dict | None, kind: str, record_id: str,
              existing: dict | None = None, exists: bool = False,
              incoming: dict | None = None) -> tuple[bool, str]:
    """May this profile write this record? Returns (allowed, reason).

    `existing` is the record ALREADY ON DISK, never the incoming body, and
    `exists` says whether there is one at all.

    That distinction is the whole security of this function. An earlier version
    read ownerId out of the request, which the caller controls completely: a
    player could overwrite anybody's character simply by omitting the field,
    because a missing owner looked like an unclaimed record. Ownership is a
    fact about what is stored, so it is read from what is stored.

    `incoming` is the payload being written (None for a DELETE). It is used
    only to ask what CHANGED - the character-building gate: identity fields
    are set at the forge, and levelling up needs the DM's grant. Play-state
    fields are deliberately not checked, so damage, purchases and prepared
    spells never need permission.

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
        data = read()
        forge = bool(data.get("forgeOpen"))
        grants = data.get("grants", {}) or {}

        if not exists:
            # Creation is a forge act. With the forge open (session zero, or
            # the DM reopened it) anyone at the table may create; the claim is
            # recorded separately, so this cannot be used to take one over.
            if forge:
                return True, ""
            return False, ("the forge is closed. Ask the DM to open it "
                           "before making a new character.")

        owned = set(profile.get("characterIds", []))
        stored_owner = (existing or {}).get("ownerId")
        is_mine = record_id in owned or stored_owner == profile["id"]
        if not is_mine:
            if stored_owner is None and record_id not in owned:
                # Pre-existing and unowned - a character made before the table
                # was opened. First claim wins rather than free-for-all editing.
                return False, ("that character has no owner yet. Ask the DM to "
                               "assign it to you.")
            return False, "that is somebody else's character."

        # ---- own existing character -----------------------------------
        if incoming is None:
            # DELETE. Retiring a character is a forge act too - and it stops
            # delete-and-recreate from being a way around the level gate.
            if forge:
                return True, ""
            return False, ("retiring a character is done at the forge. "
                           "Ask the DM to open it.")

        unlocked = forge or record_id in grants
        if not unlocked:
            for f in FROZEN_FIELDS:
                if _canon(incoming.get(f)) != _canon((existing or {}).get(f)):
                    return False, (f"'{f}' is set at the forge. Ask the DM to "
                                   "open it, or to grant a level-up.")

        new_total = total_level(incoming)
        old_total = total_level(existing)
        if new_total > old_total and not forge:
            cap = int(grants.get(record_id) or 0)
            if new_total > cap:
                return False, ("levelling up needs the DM's grant. "
                               "Ask for one, then come back to Build.")
        return True, ""

    if kind == "profiles":
        if record_id == profile["id"]:
            return True, ""
        return False, "you can only change your own profile."

    return False, f"players cannot change {kind}."


def redact_campaign(record: dict, profile: dict | None) -> dict:
    """Strip the campaign's secrets for players.

    Same reasoning as redact_encounter: hiding it in the UI leaves it in the
    payload, and a player with the network tab open reads exactly what the
    DM decided not to show. Faction AGENDAS never leave the server for a
    player; factions the DM has not marked public are absent entirely; lore
    is DM prep. day/seed/regions survive on purpose - the day's weather is
    an in-world fact every player computes client-side from exactly those
    fields, and the seed predicts nothing but the sky.
    """
    if not isinstance(record, dict):
        return record
    if profile is None or profile.get("role") == "dm":
        return record
    out = dict(record)
    out["factions"] = [
        {k: v for k, v in f.items() if k != "agenda"}
        for f in (record.get("factions") or [])
        if isinstance(f, dict) and f.get("public")
    ]
    out.pop("lore", None)
    # Prepared encounters are the DM's ambush drawer. They live on the
    # campaign record precisely BECAUSE kinds are read-open to seated
    # players - a new "templates" kind would have leaked by default.
    out.pop("encounterTemplates", None)
    # Clocks: the players see the pressure the DM has chosen to show them.
    # A secret clock is ABSENT, not merely undrawn - its label alone
    # ("the ritual completes") is the spoiler.
    out["clocks"] = [
        c for c in (record.get("clocks") or [])
        if isinstance(c, dict) and c.get("public")
    ]
    return out


def redact_map(record: dict, profile: dict | None) -> dict:
    """Players see only revealed pins, and never a pin's DM note.

    The map image itself is shared - a table looks at the same map. What the
    DM has not revealed simply is not in the payload, so there is nothing
    for a curious network tab to find.
    """
    if not isinstance(record, dict):
        return record
    if profile is None or profile.get("role") == "dm":
        return record
    out = dict(record)
    out["pins"] = [
        {k: v for k, v in p.items() if k != "note"}
        for p in (record.get("pins") or [])
        if isinstance(p, dict) and p.get("revealed")
    ]
    return out


# Events the DM authors about the WORLD, which is where the prep lives. The
# rest of the log is the players' own play - their rolls, their purchases,
# their promises - and redacting that would take the Chronicle away from the
# people whose story it is.
_WORLD_ONLY = {"section_filed"}
_WORLD_GATED = {"clock_advanced": "clocks", "faction_standing": "factions"}

# What the DM alone may author. Named HERE rather than read from the event's
# own `cat` field, because that field arrives in the request body and is
# therefore worth nothing - trusting it would be the profileId mistake with
# a different spelling.
WORLD_TYPES = {
    "day_advanced", "clock_advanced", "faction_standing", "region_moved",
    "campaign_founded", "section_filed", "price_changed",
}


def _campaign_subject_is_public(campaign_id, kind, payload, cache) -> bool:
    """Is the clock/faction this event is about one the players may see?

    FAILS CLOSED. An event we cannot resolve - no campaignId, a deleted
    campaign, a label that matches nothing - is treated as secret. The cost
    of a false negative is a missing line in a log; the cost of a false
    positive is the DM's ambush on the players' screens.

    `cache` is one dict per request. Without it a party arguing in a busy
    session re-reads the same campaign file once per event.
    """
    if not campaign_id or not isinstance(payload, dict):
        return False
    if campaign_id in cache:
        record = cache[campaign_id]
    else:
        path = ROOT / "data" / "campaigns" / f"{campaign_id}.json"
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            record = None
        cache[campaign_id] = record
    if not isinstance(record, dict):
        return False

    # Prefer the id. Older events carry only the LABEL, which is exactly the
    # thing that must not travel - matching on it here is how those events
    # get judged at all, and it never puts the label back on the wire.
    want_id = payload.get("clockId") if kind == "clocks" else payload.get("factionId")
    want_name = payload.get("clock") if kind == "clocks" else payload.get("name")
    for item in (record.get(kind) or []):
        if not isinstance(item, dict):
            continue
        if want_id and item.get("id") == want_id:
            return bool(item.get("public"))
        if not want_id and want_name and item.get("label", item.get("name")) == want_name:
            return bool(item.get("public"))
    return False


def redact_events(events: list, profile: dict | None) -> list:
    """Strip the DM's prep out of the shared event log.

    The kind routes have been redacted since the beginning; this one never
    was, and it sits above them in the dispatch so it was never going to be.
    A secret clock's LABEL ("the ritual completes") is the whole spoiler, and
    deck.js wrote it into a log every seat can read - while the toggle beside
    it promised "the server strips it from what players receive". The same
    hole carried non-public faction names, lore titles, and the names of
    prepared encounters that redact_campaign pops precisely to hide.

    A secret clock STRIKING is itself the tell, so those events are absent
    rather than blanked - the same rule redact_campaign already applies to
    the clock it belongs to.

    `summary` is scrubbed alongside the payload, always. It is rendered from
    payload fields by describe(), so a fix that only cleans the payload
    leaves "The Veiled Hand: standing -3" sitting in the next field along.
    """
    if not isinstance(events, list):
        return events
    if profile is None or profile.get("role") == "dm":
        return events

    out = []
    cache: dict = {}
    for ev in events:
        if not isinstance(ev, dict):
            out.append(ev)
            continue
        kind = ev.get("type")

        if kind in _WORLD_ONLY:
            continue
        if kind in _WORLD_GATED:
            if not _campaign_subject_is_public(
                    ev.get("campaignId"), _WORLD_GATED[kind],
                    ev.get("payload"), cache):
                continue
            out.append(ev)
            continue

        # The solo tracker names the encounter and every monster in it. The
        # shared runner already logs a bare count, which is the shape both
        # should have had.
        if kind in ("encounter_start", "encounter_end"):
            payload = ev.get("payload")
            if isinstance(payload, dict) and (
                    "name" in payload or "combatants" in payload):
                clean = {k: v for k, v in payload.items()
                         if k not in ("name", "combatants")}
                if isinstance(payload.get("combatants"), list):
                    clean["combatants"] = len(payload["combatants"])
                ev = dict(ev, payload=clean)
                ev.pop("summary", None)
            out.append(ev)
            continue

        out.append(ev)
    return out


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
