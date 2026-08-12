#!/usr/bin/env python3
"""Grow a campaign, on purpose and reproducibly.

Every screen in this app was built and tested against a FRESH campaign. The
overnight run asks a question nobody has measured: does it still work when
the campaign is big? That needs campaign size to be an input rather than an
accident, which is what this file is for.

Two campaigns are created, deliberately. The DM's Story feed queries events
with no campaignId filter (story.js), so its headline counts are polluted by
any other campaign - a defect that is completely invisible while only one
exists. Building the condition a defect needs is the ager's job, not
something to hope for.

The growing pile of `lore` entries is a NEGATIVE CONTROL, not filler. The
Deck writes lore and nothing in the app ever reads it back, so a grader that
starts "finding" lore has started measuring its own noise.

Honesty cost, stated plainly: this ages a campaign over HTTP rather than
through the UI. Through the UI it would cost roughly thirty times the wall
clock and would itself be the thing under test. The price is that this can
write states the UI could not produce, so every finding gets a
UI-reachability re-check before it is filed, and the report labels which
states came from here.

Stdlib only. Deterministic for a given seed: same seed, same campaign.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRACTED = ROOT / "library" / "extracted"

# Log-spaced, not linear. Taps are a step function with a few breakpoints,
# so sixty daily points at n=1 buys resolution nobody can use and no error
# bars at all. Eight days x eight seeds is the same wall clock with a
# distribution behind every point.
SWEEP_DAYS = [1, 2, 4, 8, 15, 30, 60, 120]
SEEDS = [11, 23, 37, 41, 59, 67, 71, 83]
# Half the seeds pull their names and prose from the real shelf. That is
# what makes the lore control real rather than synthetic, and it is the only
# way region.note (stored by the Deck, rendered nowhere) gets a value.
BOOK_SEEDS = set(SEEDS[4:])

TERRAINS = ["forest", "hills", "swamp", "coast", "mountain", "plains", "urban"]
PIN_KINDS = ["location", "npc", "faction", "quest", "party"]

# Growth per in-world day, as 1-in-N. Tuned so day 60 lands near a campaign
# a real table would recognise: ~10 factions, ~8 clocks, ~24 pins.
EVERY = {
    "faction": 6, "clock": 8, "region": 10, "pin": 5, "lore": 4,
}
EVENTS_PER_DAY = 25


class Refused(RuntimeError):
    """The server said no. Distinct from a transport failure on purpose."""


def _req(base, path, method="GET", body=None, token=None, timeout=30, tries=3):
    """One request, retried on TRANSPORT failure only.

    The stdlib threading server drops a keep-alive socket now and then under
    a burst of large writes, which surfaces as ConnectionResetError mid-read.
    That is noise about the harness, not a fact about the app, and letting it
    exclude a cycle would quietly thin the sweep. An HTTP *refusal* is never
    retried - that IS a fact about the app.
    """
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(f"{base}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("X-Toon-Token", token)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode() or "null"
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:200]
            raise Refused(f"{method} {path} -> {e.code} {detail}") from e
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as e:
            last = e
            time.sleep(0.2 * (attempt + 1))
    raise Refused(f"{method} {path} -> transport failed {tries}x: {last}")


# ---------------------------------------------------------------- content


def _book_sections(limit=400):
    """Real prose from the shelf, for the campaigns that should feel real.

    Returns [] when the shelf is empty rather than raising: a machine
    without the books must still be able to run the night, and the caller
    RECORDS that it fell back rather than quietly pretending otherwise.

    Only titles and bodies are read here, and only into the isolated
    instance's own data dir - which is gitignored, exactly like the shelf.
    Nothing from a book reaches a report or a commit.
    """
    if not EXTRACTED.is_dir():
        return []
    out = []
    for book in sorted(EXTRACTED.iterdir()):
        if not book.is_dir():
            continue
        for name in ("unclassified.json", "monster.json", "magic_item.json"):
            f = book / name
            if not f.is_file():
                continue
            try:
                rows = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            for row in rows if isinstance(rows, list) else []:
                title = str(row.get("title") or "").strip()
                text = str(row.get("text") or "").strip()
                if len(title) < 4 or len(title) > 60:
                    continue
                out.append({"title": title, "text": text, "book": book.name})
                if len(out) >= limit:
                    return out
    return out


_SYLL_A = ["Thorn", "Grey", "Ember", "Salt", "Fen", "Iron", "Hollow", "Mist",
           "Black", "Amber", "Storm", "Quiet"]
_SYLL_B = ["vale", "march", "reach", "hold", "cross", "fen", "gate", "moor",
           "wick", "barrow", "run", "deep"]


def _synth_name(rng):
    return f"{rng.choice(_SYLL_A)}{rng.choice(_SYLL_B)}"


def _namer(rng, sections):
    """One name source, so a book seed and a synthetic seed differ in ONE way."""
    pool = list(sections)
    rng.shuffle(pool)
    used = []

    def take():
        if pool:
            s = pool.pop()
            used.append(s)
            return s["title"][:60], s["text"][:500]
        return _synth_name(rng), ""
    return take


# ---------------------------------------------------------------- world


def wipe_previous(base, token):
    """Delete every campaign and map this ager has ever made.

    Without this, cycle 30 measures a world containing twenty-nine previous
    cycles' campaigns - and the DM's Story feed queries events with NO
    campaignId filter, so the screens would get steadily slower for a reason
    that has nothing to do with the size being measured. That would be a
    degradation curve reading its own run time, which is exactly the kind of
    confident wrong answer this whole design is arranged to avoid.

    Events are append-only and have no delete route; the orchestrator
    truncates data/events.jsonl between cycles for the same reason.
    """
    removed = 0
    for kind in ("campaigns", "maps"):
        try:
            rows = _req(base, f"/api/{kind}", token=token)
        except Refused:
            continue
        for row in rows if isinstance(rows, list) else []:
            rid = str(row.get("id") or "")
            if not rid.startswith(("night-", "map-night-")):
                continue
            try:
                _req(base, f"/api/{kind}/{rid}", "DELETE", token=token)
                removed += 1
            except Refused:
                pass
    return removed


def seed_bench_world(base, token, seed, *, source="synthetic"):
    """Two campaigns and a map, at day 1. Returns the ids and the provenance."""
    wipe_previous(base, token)
    rng = random.Random(seed)
    sections = _book_sections() if source == "book" else []
    fell_back = source == "book" and not sections
    take = _namer(rng, sections)

    ids = {"seed": seed, "source": source, "fellBackToSynthetic": fell_back}
    for slot, active in (("main", True), ("other", False)):
        name, _ = take()
        cid = f"night-{seed}-{slot}"
        _req(base, f"/api/campaigns/{cid}", "PUT", {
            "id": cid, "name": f"{name} ({slot})", "active": active,
            "day": 1, "seed": seed, "currentRegionId": None,
            "regions": [], "factions": [], "clocks": [], "lore": [],
            "mapId": f"map-{cid}" if slot == "main" else None,
            "createdAt": "2026-01-01T00:00:00+00:00",
        }, token)
        ids[slot] = cid

    # A 1x1 transparent PNG: the map is a pin carrier here, not a picture.
    _req(base, f"/api/maps/map-{ids['main']}", "PUT", {
        "id": f"map-{ids['main']}", "name": "Night map",
        "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
                 "CAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "w": 1000, "h": 700, "pins": [],
    }, token)
    return ids


def reset(base, token, ids, *, source="synthetic"):
    """Back to day 1, same ids, so a cycle never inherits the last one's size."""
    return seed_bench_world(base, token, ids["seed"], source=source)


def grow(base, token, ids, to_day, *, source="synthetic", quiet=True):
    """Age the main campaign to `to_day`. Idempotent for a given (seed, day).

    Deterministic: every decision comes from Random(seed), and the day loop
    starts at 1 every time, so grow(...,30) always produces the same world
    rather than one that depends on how it got there.
    """
    seed = ids["seed"]
    rng = random.Random(seed * 1009 + to_day * 7)
    sections = _book_sections() if source == "book" else []
    take = _namer(rng, sections)

    camp = _req(base, f"/api/campaigns/{ids['main']}", token=token)
    events = []
    fac_i = 0

    for day in range(1, to_day + 1):
        if day % EVERY["region"] == 1 or not camp["regions"]:
            name, note = take()
            rid = f"reg-{seed}-{day}"
            camp["regions"].append({
                "id": rid, "name": name,
                "terrain": rng.choice(TERRAINS),
                "priceMod": round(rng.uniform(0.7, 1.6), 2),
                # Stored by the Deck's ingest and rendered by NOTHING. One of
                # the things the reach grader is here to notice.
                "note": note,
            })
            camp["currentRegionId"] = rid
            events.append(_ev(day, "region_moved", {
                "regionName": name, "regionId": rid}, camp["id"]))

        if day % EVERY["faction"] == 0:
            name, agenda = take()
            fid = f"fac-{seed}-{day}"
            camp["factions"].append({
                "id": fid, "name": name, "standing": rng.randint(-4, 4),
                # The one secret field. A player must never receive it.
                "agenda": agenda or f"SECRETAGENDA-{seed}-{day}",
                "public": rng.random() < 0.5,
                "colour": "#8e2a1c",
            })
            fac_i += 1
            events.append(_ev(day, "faction_standing", {
                "factionId": fid, "value": rng.randint(-4, 4)}, camp["id"]))

        if day % EVERY["clock"] == 0:
            label, _ = take()
            camp["clocks"].append({
                "id": f"clk-{seed}-{day}", "label": label,
                "size": rng.choice([4, 6, 8]), "filled": 0,
                "public": rng.random() < 0.5,
                "advanceOnDay": rng.random() < 0.5, "factionId": None,
            })

        if day % EVERY["lore"] == 0:
            title, text = take()
            camp["lore"].append({"title": title, "text": text,
                                 "source": ids.get("source", "synthetic")})

        # Calendar clocks tick, and a clock that STRIKES is a story beat -
        # the same shape advanceDayClocks() produces client-side.
        for c in camp["clocks"]:
            if not c.get("advanceOnDay") or c["filled"] >= c["size"]:
                continue
            c["filled"] += 1
            if c["filled"] >= c["size"]:
                events.append(_ev(day, "clock_advanced", {
                    "clockId": c["id"], "public": c["public"]}, camp["id"]))

        events.append(_ev(day, "day_advanced", {"day": day}, camp["id"]))
        events.extend(_chatter(rng, day, camp["id"], EVENTS_PER_DAY))

    camp["day"] = to_day
    _req(base, f"/api/campaigns/{ids['main']}", "PUT", camp, token)

    # Pins live on the map record, not the campaign.
    pins = []
    for day in range(1, to_day + 1):
        if day % EVERY["pin"]:
            continue
        for _ in range(2):
            label, note = take()
            pins.append({
                "id": f"pin-{seed}-{day}-{len(pins)}",
                "x": rng.randint(20, 980), "y": rng.randint(20, 680),
                "kind": rng.choice(PIN_KINDS), "label": label,
                "linkId": None, "revealed": rng.random() < 0.6,
                "note": note or f"HIDDENPIN-{seed}-{day}",
            })
    mp = _req(base, f"/api/maps/map-{ids['main']}", token=token)
    mp["pins"] = pins
    _req(base, f"/api/maps/map-{ids['main']}", "PUT", mp, token)

    # Batched: three thousand single POSTs would dominate the cycle.
    for i in range(0, len(events), 250):
        _req(base, "/api/events", "POST", events[i:i + 250], token)

    if not quiet:
        print(f"  grown to day {to_day}: {len(camp['regions'])} regions, "
              f"{len(camp['factions'])} factions, {len(camp['clocks'])} clocks, "
              f"{len(pins)} pins, {len(events)} events")
    return camp


def _ev(day, kind, payload, campaign_id):
    return {
        "id": f"ev-{campaign_id}-{day}-{kind}-{payload.get('clockId', '')}"
              f"{payload.get('factionId', '')}{payload.get('regionId', '')}",
        "ts": f"2026-01-01T{day % 24:02d}:00:00.000Z",
        "type": kind, "cat": "world", "campaignId": campaign_id,
        "characterId": None, "sessionId": None, "actor": None,
        "summary": "", "tags": [], "payload": dict(payload, day=day),
    }


_CHATTER = [
    ("roll", "combat"), ("attack", "combat"), ("damage_dealt", "combat"),
    ("healed", "combat"), ("spell_cast", "combat"), ("turn_done", "combat"),
    ("journal", "journal"), ("purchase", "shop"), ("npc_met", "rp"),
    ("dialogue_beat", "rp"), ("rest_short", "progression"),
]


def _chatter(rng, day, campaign_id, n):
    """The ordinary traffic of play. Typed realistically, because the Story
    feed filters by category and an untyped pile would not exercise it."""
    out = []
    for i in range(n):
        kind, cat = rng.choice(_CHATTER)
        out.append({
            "id": f"ev-{campaign_id}-{day}-c{i}",
            "ts": f"2026-01-01T{day % 24:02d}:{i % 60:02d}:00.000Z",
            "type": kind, "cat": cat, "campaignId": campaign_id,
            "characterId": f"night-pc-{rng.randint(1, 5)}",
            "sessionId": None, "actor": None, "summary": "", "tags": [],
            "payload": {"day": day, "total": rng.randint(1, 25),
                        "amount": rng.randint(1, 12)},
        })
    return out


# ---------------------------------------------------------------- size


def size_of(base, token, ids):
    """The x-axis. Written onto EVERY metric row rather than inferred from a
    step index, so a cycle that was skipped or retried cannot silently be
    plotted at the wrong size."""
    camp = _req(base, f"/api/campaigns/{ids['main']}", token=token)
    try:
        mp = _req(base, f"/api/maps/map-{ids['main']}", token=token)
    except Refused:
        mp = {"pins": []}
    allc = _req(base, "/api/campaigns", token=token)
    # The server clamps this route at 2000. Past that the count is a SAMPLE,
    # and a sample that silently stops growing looks like a campaign that
    # shrank - so the cap is reported rather than hidden, and the report must
    # not plot eventsSampled as a size once it is capped.
    limit = 2000
    evs = _req(base, f"/api/events?limit={limit}", token=token)
    rows = evs if isinstance(evs, list) else (evs or {}).get("events", [])
    mine = [e for e in rows if e.get("campaignId") == ids["main"]]
    return {
        "eventsSampleCapped": len(rows) >= limit,
        "day": camp.get("day", 0),
        "factions": len(camp.get("factions") or []),
        "clocks": len(camp.get("clocks") or []),
        "regions": len(camp.get("regions") or []),
        "loreEntries": len(camp.get("lore") or []),
        "pins": len(mp.get("pins") or []),
        "campaigns": len(allc) if isinstance(allc, list) else 0,
        "eventsSampled": len(rows),
        "eventsThisCampaign": len(mine),
        # The headline x-axis: how much record the DM's screen has to carry.
        "campaignBytes": len(json.dumps(camp)),
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Grow a campaign to a given day.")
    ap.add_argument("--base", default="http://127.0.0.1:7904")
    ap.add_argument("--token", default=None)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--day", type=int, default=30)
    ap.add_argument("--source", default="synthetic", choices=["synthetic", "book"])
    a = ap.parse_args()
    world = seed_bench_world(a.base, a.token, a.seed, source=a.source)
    if world["fellBackToSynthetic"]:
        print("  NOTE: no shelf found - fell back to synthetic names")
    grow(a.base, a.token, world, a.day, source=a.source, quiet=False)
    print(json.dumps(size_of(a.base, a.token, world), indent=2))
