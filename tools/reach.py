#!/usr/bin/env python3
"""The availability tier: is the fact in any payload this seat may fetch?

This is the half of the measurement that cannot be killed by a backgrounded
tab. It holds every seat's token, calls the server directly, and answers a
strictly weaker question than the browser tier: not "how many taps", but
"is the answer even in the data this seat is allowed to receive".

Weaker, and yet it owns the finding that matters most. Merged with the
browser tier by question id:

    reachable = available AND (taps is not null)

- available but NOT reachable -> the data is there and the UI cannot get to
  it. That is the headline class, and it is the entire reason two tiers
  exist rather than one.
- NOT available but taps reported -> the browser probe is broken, not the
  app. The disagreement is itself a finding and must never be averaged away.

It also owns redaction correctness, because it can compare what two seats
receive for the same object - something a single browser frame cannot do.

Every question id in sim/reach-catalogue.json must have a probe here. Drift
fails loudly at startup: a question implemented by neither tier would merge
as "reachable" and quietly flatter the app.

Stdlib only.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Lives under app/ because serve.py serves static files from there and
# ONLY from there - the browser tier has to be able to fetch the same
# file this one reads, or the two tiers are agreeing by coincidence.
CATALOGUE = ROOT / "app" / "sim" / "reach-catalogue.json"

# What the dice rail actually asks for (dicerail.js), so the bytes a DM would
# have to scan are the bytes a real screen really receives.
EVENT_LIMIT = 400


def _get(base, path, token=None, timeout=30, tries=3):
    """Retried on transport failure only.

    A dropped keep-alive socket is noise about the stdlib server under a
    burst, not a fact about the app - and a bundle that silently came back
    as {"_error": ...} would make every probe on it report `available: 0`,
    which is a fabricated finding rather than a missing one.
    """
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(f"{base}{path}", method="GET")
        if token:
            req.add_header("X-Toon-Token", token)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode() or "null")
        except urllib.error.HTTPError as e:
            # A refusal IS the answer for a redaction probe. Not retried.
            return {"_httpError": e.code}
        except (OSError, urllib.error.URLError, json.JSONDecodeError,
                TimeoutError) as e:
            last = e
            time.sleep(0.2 * (attempt + 1))
    return {"_error": str(last)[:120]}


def fetch_seat(base, token, ids):
    """Everything one seat can legally see, in one bundle."""
    cid = ids["main"]
    return {
        "campaign": _get(base, f"/api/campaigns/{cid}", token),
        "map": _get(base, f"/api/maps/map-{cid}", token),
        "encounter": _get(base, "/api/encounters/current", token),
        "events": _get(base, f"/api/events?limit={EVENT_LIMIT}", token),
        "characters": _get(base, "/api/characters", token),
        "table": _get(base, "/api/table", token),
    }


# ---------------------------------------------------------------- helpers


def _rows(bundle, key):
    v = bundle.get(key)
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return v.get("events") or v.get("rows") or []
    return []


def _events(bundle):
    return [e for e in _rows(bundle, "events") if isinstance(e, dict)]


def _has_event(bundle, *types):
    want = set(types)
    return any(e.get("type") in want for e in _events(bundle))


def _camp(bundle):
    c = bundle.get("campaign")
    return c if isinstance(c, dict) and "_error" not in c else {}


def _combatants(bundle):
    e = bundle.get("encounter")
    return (e or {}).get("combatants", []) if isinstance(e, dict) else []


def _nonempty(v):
    return bool(v) if not isinstance(v, (list, dict, str)) else len(v) > 0


def _size(obj):
    try:
        return len(json.dumps(obj))
    except (TypeError, ValueError):
        return 0


def A(available, route, scan=0, note=""):
    """One availability answer. `available` is 0/1, never a bare truthy."""
    return {"available": 1 if available else 0, "route": route,
            "bytesToScan": int(scan), "note": note}


# ---------------------------------------------------------------- probes
#
# Each takes (bundle, ids) and returns A(...). Keyed by the catalogue id, so
# the merge key and the implementation cannot drift apart.

def _p_ogre_hp(b, _):
    mons = [c for c in _combatants(b) if not c.get("characterId")]
    got = any("hp" in c for c in mons)
    return A(got, "/api/encounters/current", _size(b.get("encounter")),
             "monster hp is popped for players by redact_encounter")


def _p_whose_turn(b, _):
    e = b.get("encounter") or {}
    return A(isinstance(e, dict) and "turn" in e, "/api/encounters/current",
             _size(e))


def _p_initiative_order(b, _):
    return A(any("init" in c for c in _combatants(b)),
             "/api/encounters/current", _size(b.get("encounter")))


def _p_who_has_acted(b, _):
    return A(_has_event(b, "turn_done"), f"/api/events?limit={EVENT_LIMIT}",
             _size(b.get("events")),
             "only turn_done carries it; the encounter record does not")


def _p_party_ac(b, _):
    chars = _rows(b, "characters")
    return A(bool(chars), "/api/characters", _size(b.get("characters")),
             "AC is derived client-side from the character record")


_p_party_passive_perception = _p_party_ac
_p_party_saves = _p_party_ac
_p_party_resistances = _p_party_ac


def _p_party_hp_now(b, _):
    pcs = [c for c in _combatants(b) if c.get("characterId")]
    return A(any("hp" in c for c in pcs) or bool(_rows(b, "characters")),
             "/api/encounters/current + /api/characters",
             _size(b.get("encounter")))


def _p_party_wealth(b, _):
    chars = _rows(b, "characters")
    got = any(isinstance(c, dict) and c.get("currency") for c in chars)
    return A(got, "/api/characters", _size(b.get("characters")),
             "currency is on the record; derive() exposes copper")


def _p_gold_spent_by_day(b, _):
    got = any(e.get("type") == "purchase" and "day" in (e.get("payload") or {})
              for e in _events(b))
    return A(got, f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")))


def _p_gold_earned(b, _):
    return A(_has_event(b, "sale", "gold_change", "item_gained"),
             f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")))


def _p_faction_standing_now(b, _):
    return A(_nonempty(_camp(b).get("factions")), "/api/campaigns/<id>",
             _size(b.get("campaign")))


def _p_faction_standing_history(b, _):
    return A(_has_event(b, "faction_standing"),
             f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")))


def _p_faction_agenda(b, _):
    got = any((f or {}).get("agenda") for f in _camp(b).get("factions") or [])
    return A(got, "/api/campaigns/<id>", _size(b.get("campaign")),
             "redact_campaign strips agenda for players")


_p_faction_agenda_player = _p_faction_agenda


def _p_clock_state(b, _):
    return A(_nonempty(_camp(b).get("clocks")), "/api/campaigns/<id>",
             _size(b.get("campaign")))


def _p_clock_history(b, _):
    # clock_advanced is logged only when a clock STRIKES, and the manual-tap
    # path omits `day` entirely - so a rate is not recoverable from the log.
    evs = [e for e in _events(b) if e.get("type") == "clock_advanced"]
    dated = [e for e in evs if "day" in (e.get("payload") or {})]
    return A(len(dated) >= 2, f"/api/events?limit={EVENT_LIMIT}",
             _size(b.get("events")),
             "only strikes are logged; ordinary segment taps are not")


def _p_current_region(b, _):
    return A(bool(_camp(b).get("currentRegionId")), "/api/campaigns/<id>",
             _size(b.get("campaign")))


def _p_region_note(b, _):
    got = any((r or {}).get("note") for r in _camp(b).get("regions") or [])
    return A(got, "/api/campaigns/<id>", _size(b.get("campaign")),
             "stored by the Deck's ingest, rendered by nothing")


def _p_campaign_lore(b, _):
    return A(_nonempty(_camp(b).get("lore")), "/api/campaigns/<id>",
             _size(b.get("campaign")),
             "CONTROL: written by deck.js, read by nothing in the app")


def _p_npc_disposition(b, ids):
    npcs = _get(ids["_base"], "/api/npcs", ids.get("_token"))
    return A(bool(npcs) and isinstance(npcs, list), "/api/npcs", _size(npcs),
             "the npcs kind is read only by the player's RP mode")


def _p_hidden_pins(b, _):
    pins = (b.get("map") or {}).get("pins") or []
    return A(any(not p.get("revealed") for p in pins), "/api/maps/<id>",
             _size(b.get("map")), "redact_map drops unrevealed pins entirely")


_p_hidden_pin_player = _p_hidden_pins


def _p_prepared_encounters(b, _):
    return A(_nonempty(_camp(b).get("encounterTemplates")),
             "/api/campaigns/<id>", _size(b.get("campaign")),
             "redact_campaign pops encounterTemplates for players")


def _p_encounter_difficulty(b, _):
    # encounter_start carries only a combatant count (runner.js:510) - no XP,
    # no CRs, no party levels - so difficulty is not recoverable afterwards.
    starts = [e for e in _events(b) if e.get("type") == "encounter_start"]
    got = any(set(e.get("payload") or {}) - {"combatants", "day"} for e in starts)
    return A(got, f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")),
             "encounter_start logs a count and nothing else")


def _p_encounter_outcome(b, _):
    return A(_has_event(b, "encounter_end"), f"/api/events?limit={EVENT_LIMIT}",
             _size(b.get("events")),
             "the DM's runner never logs encounter_end at all")


def _p_session_count(b, _):
    got = any(e.get("sessionId") for e in _events(b))
    return A(got, f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")),
             "CONTROL: setContext never sets sessionId, so every event is null")


def _p_session_pacing(b, _):
    return _p_session_count(b, _)


def _p_damage_taken_total(b, _):
    # runner.js:751 logs PC damage as damage_dealt with no characterId, so
    # damage cannot be attributed to a player even where it is logged.
    got = any(e.get("type") == "damage_taken" and e.get("characterId")
              for e in _events(b))
    return A(got, f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")),
             "the runner logs PC damage as damage_dealt with no characterId")


def _p_spotlight_balance(b, _):
    rolls = [e for e in _events(b) if e.get("type") == "roll"]
    who = {e.get("characterId") for e in rolls if e.get("characterId")}
    return A(len(who) >= 2, f"/api/events?limit={EVENT_LIMIT}",
             _size(b.get("events")), "raw material present; no aggregate")


def _p_crit_rate(b, _):
    rolls = [e for e in _events(b) if e.get("type") == "roll"]
    return A(len(rolls) >= 2, f"/api/events?limit={EVENT_LIMIT}",
             _size(b.get("events")), "counts exist; the denominator is unused")


def _p_death_saves_made(b, _):
    return A(_has_event(b, "death_save", "downed"),
             f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")))


def _p_rest_cadence(b, _):
    return A(_has_event(b, "rest_long", "rest_short"),
             f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")))


def _p_recent_rolls(b, _):
    return A(_has_event(b, "roll"), f"/api/events?limit={EVENT_LIMIT}",
             _size(b.get("events")))


def _p_day_and_weather(b, _):
    c = _camp(b)
    return A("day" in c and "seed" in c, "/api/campaigns/<id>",
             _size(b.get("campaign")), "weather is computed from seed+day")


def _p_monster_statblock(b, ids):
    mons = _get(ids["_base"], "/api/custom-monsters", ids.get("_token"))
    # SRD monsters ship as a static compendium file, not an API kind.
    return A(True, "compendium/monsters (static)", _size(mons),
             "SRD bestiary is a bundled file, always present")


def _p_condition_meaning_dm(b, _):
    return A(True, "data/compendium/glossary.json (static)", 0,
             "the glossary ships; only the DM shell imports it")


def _p_condition_meaning_player(b, _):
    return A(True, "data/compendium/glossary.json (static)", 0,
             "ships and is service-worker cached, but NO player module reads it")


# --- player seat -------------------------------------------------------

def _p_my_turn_now(b, _):
    e = b.get("encounter") or {}
    return A(isinstance(e, dict) and "turn" in e and _combatants(b),
             "/api/encounters/current", _size(e))


def _p_roll_an_attack(b, _):
    return A(bool(_rows(b, "characters")), "/api/characters",
             _size(b.get("characters")), "attacks are derived from the record")


def _p_did_i_hit(b, _):
    # resolveAttack is called with no target (sheet.js), so hit is null and
    # no payload anywhere carries a hit/miss verdict for a player's attack.
    got = any("hit" in (e.get("payload") or {}) for e in _events(b))
    return A(got, f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")),
             "CONTROL: sheet.js passes no target, so hit is never computed")


def _p_how_much_damage(b, _):
    got = any(e.get("type") == "attack" and (e.get("payload") or {}).get("damage")
              for e in _events(b))
    return A(got, f"/api/events?limit={EVENT_LIMIT}", _size(b.get("events")))


_p_cast_a_spell = _p_roll_an_attack
_p_slots_left = _p_roll_an_attack
_p_my_hp = _p_roll_an_attack
_p_my_ac_why = _p_roll_an_attack
_p_skill_why = _p_roll_an_attack
_p_attack_bonus_why = _p_roll_an_attack
_p_my_resistances = _p_roll_an_attack
_p_spend_a_hit_die = _p_roll_an_attack
_p_my_reactions = _p_roll_an_attack


def _p_end_my_turn(b, _):
    return A(True, "POST /api/events (turn_done)", 0,
             "an ungated event write; needs no seat permission change")


def _p_spell_text(b, _):
    return A(True, "data/compendium/spells.json (static)", 0,
             "ships; the player shell renders name/level/school only")


def _p_enemy_hp_band(b, _):
    mons = [c for c in _combatants(b) if not c.get("characterId")]
    return A(any("band" in c for c in mons), "/api/encounters/current",
             _size(b.get("encounter")))


def _p_enemy_hp_number(b, _):
    mons = [c for c in _combatants(b) if not c.get("characterId")]
    return A(any("hp" in c for c in mons), "/api/encounters/current",
             _size(b.get("encounter")),
             "CONTROL: redact_encounter must pop hp for a player seat")


def _p_record_rp_beat(b, _):
    return A(True, "POST /api/events (rp)", 0, "rp writes are ungated")


def _p_record_rp_in_fight(b, _):
    # The data path is the same; what is missing is a surface. That is a
    # browser-tier fact, so availability is honestly 1 here.
    return A(True, "POST /api/events (rp)", 0,
             "same write; rp.js mounts no fight rail, so the COST is the issue")


def _p_my_party_hp(b, _):
    pcs = [c for c in _combatants(b) if c.get("characterId")]
    return A(bool(pcs) or bool(_rows(b, "characters")),
             "/api/encounters/current", _size(b.get("encounter")))


def _p_the_day(b, _):
    return A("day" in _camp(b), "/api/campaigns/<id>", _size(b.get("campaign")))


PROBES = {k[3:]: v for k, v in list(globals().items()) if k.startswith("_p_")}


# ---------------------------------------------------------------- run


def load_catalogue():
    cat = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    return cat["questions"]


def assert_no_drift(questions):
    """A question implemented by neither tier merges as reachable. Fail loud."""
    want = {q["id"] for q in questions}
    have = set(PROBES)
    missing = sorted(want - have)
    extra = sorted(have - want)
    if missing or extra:
        raise SystemExit(
            "reach catalogue drift — refusing to measure.\n"
            f"  no probe for : {missing}\n"
            f"  probe with no catalogue entry: {extra}")
    return len(want)


def measure_all(base, bench, ids, cycle, size):
    """One row per (question, seat). Rows, not scores - scoring is the report's."""
    questions = load_catalogue()
    assert_no_drift(questions)

    bundles = {}
    for seat in bench["seats"]:
        ctx = dict(ids, _base=base, _token=seat["token"])
        bundles[seat["id"]] = (fetch_seat(base, seat["token"], ids), ctx)

    rows = []
    for q in questions:
        want_role = q["seat"]
        for seat in bench["seats"]:
            if seat["role"] != want_role:
                continue
            bundle, ctx = bundles[seat["id"]]
            try:
                got = PROBES[q["id"]](bundle, ctx)
            except (KeyError, TypeError, AttributeError, ValueError) as e:
                got = A(0, "probe error", 0, f"{type(e).__name__}: {e}")
                got["probeError"] = True
            rows.append({
                "cycle": cycle, "questionId": q["id"], "seat": seat["id"],
                "role": seat["role"], "ask": q["ask"],
                "control": q.get("control"), "size": size, **got,
            })
    return rows


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Availability tier, one pass.")
    ap.add_argument("--base", default="http://127.0.0.1:7904")
    ap.add_argument("--bench", default="night/bench.json")
    ap.add_argument("--check", action="store_true",
                    help="verify the catalogue has a probe for every id, then exit")
    a = ap.parse_args()
    qs = load_catalogue()
    n = assert_no_drift(qs)
    print(f"catalogue ok: {n} questions, {n} probes, no drift")
    if a.check:
        raise SystemExit(0)
    bench = json.loads(Path(a.bench).read_text(encoding="utf-8"))
    rows = measure_all(a.base, bench, bench["ids"], 0, {})
    avail = sum(r["available"] for r in rows)
    print(f"{len(rows)} rows, {avail} available")
    for r in rows:
        if r.get("control"):
            print(f"  CONTROL {r['questionId']:26s} available={r['available']} "
                  f"({r['role']})")
