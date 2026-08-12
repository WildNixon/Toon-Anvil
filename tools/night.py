#!/usr/bin/env python3
"""The overnight run: measure the app as the campaign grows, and checkpoint.

Design commitments, each one a scar from a previous run:

- A STALE STOP FILE IS CLEARED FIRST, loudly. A leftover .stop once silently
  killed a lane for two whole rounds, and the run looked healthy throughout.
- ISOLATION IS RE-ASSERTED EVERY CYCLE, not only at boot. A run that drifts
  onto the real data dir at hour three has done real damage quietly.
- CHECKPOINTS ARE ATOMIC and the row files are append-only, so a crash at
  hour six keeps everything through hour six.
- A CYCLE THAT COULD NOT BE MEASURED IS EXCLUDED, NEVER SCORED ZERO. If the
  table dies, every seat boots to the join gate and every question scores
  zero - which would draw a beautiful and entirely false cliff. That is the
  most dangerous failure mode here precisely because it is so plausible.
- THE BROWSER TIER IS OPTIONAL. The Python tier owns availability and needs
  no browser at all, so a backgrounded tab costs tap coverage and nothing
  else. Missing browser rows are reported as "availability only" and are
  never counted into a taps mean.

Usage:
    python tools/night.py --hours 8 --port 7904 --instance ../grimoire-night
    python tools/night.py --resume
    python tools/night.py --minutes 30 --dry     # the gate before the real run
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import age  # noqa: E402
import reach  # noqa: E402

NIGHT = ROOT / "night"
STOP = NIGHT / ".stop"
DONE = NIGHT / ".done"
STATE = NIGHT / "state.json"
ROWS = NIGHT / "reach.jsonl"
BENCH = NIGHT / "bench.json"


def _req(base, path, method="GET", body=None, token=None, timeout=30, tries=3):
    """Retried on transport failure, never on a refusal - see age._req."""
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(f"{base}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("X-Toon-Token", token)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode() or "null")
        except urllib.error.HTTPError:
            raise
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as e:
            last = e
            time.sleep(0.2 * (attempt + 1))
    raise ConnectionError(f"{method} {path} failed {tries}x: {last}")


def atomic_write(path: Path, text: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def append_rows(path: Path, rows):
    with path.open("a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


# ---------------------------------------------------------------- preflight


def clear_stale_stop():
    """First, and loudly. A stop file nobody remembers writing is a silent
    lane-killer, and the run looks perfectly healthy while producing nothing."""
    if STOP.exists():
        STOP.unlink()
        print("  ! cleared a STALE .stop file — the last run left it behind")
        return True
    return False


def build_instance(src: Path, dst: Path, fresh: bool):
    """Make the instance match this tree's code, without needing to delete it.

    Deliberately NOT rmtree-and-recopy: on Windows a running server holds the
    directory open, so the obvious implementation fails with WinError 32 the
    moment you try to re-run. Syncing the code and clearing only `data/` is
    what --fresh actually needs anyway - the point is a clean world, not a
    clean inode.
    """
    def ignore(d, names):
        skip = {n for n in names if n == "__pycache__"}
        if Path(d) == src:
            skip |= {".git", "data", "night", "soak"}
        return skip

    if not dst.exists():
        shutil.copytree(src, dst, ignore=ignore)
        print(f"  copied the tree to {dst}")
    else:
        for part in ("app", "tools", "sim", "data/compendium"):
            s, d = src / part, dst / part
            if not s.is_dir():
                continue
            shutil.copytree(s, d, ignore=ignore, dirs_exist_ok=True)
        for f in ("serve.py", "run.py", "index.html"):
            if (src / f).is_file():
                shutil.copy2(src / f, dst / f)
        print("  synced code into the existing instance")

    if fresh:
        # A clean WORLD, not a clean directory. Records only - never the
        # compendium, which is code-shaped and expensive to recopy.
        data = dst / "data"
        for child in data.iterdir() if data.is_dir() else []:
            if child.name == "compendium":
                continue
            try:
                shutil.rmtree(child) if child.is_dir() else child.unlink()
            except OSError as e:
                print(f"  ! could not clear {child.name}: {e}")
        print("  --fresh: cleared the instance's records")

    lib = src / "library" / "extracted"
    if lib.is_dir() and not (dst / "library" / "extracted").is_dir():
        shutil.copytree(lib, dst / "library" / "extracted")
        print("  copied library/extracted (book-sourced seeds)")
    # A stale service worker across hundreds of reloads is a trap, and PWA-1
    # says its shell list is already stale. Recorded as a divergence rather
    # than hidden: the night run does not test the offline path.
    sw = dst / "app" / "sw.js"
    if sw.exists():
        sw.unlink()
        print("  deleted app/sw.js in the copy (recorded divergence)")
    (dst / "data").mkdir(exist_ok=True)


def start_server(instance: Path, port: int):
    log = (NIGHT / "server.log").open("a", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "serve.py", "--port", str(port)],
        cwd=str(instance), stdout=log, stderr=subprocess.STDOUT)
    for _ in range(40):
        time.sleep(0.5)
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3)
            return proc
        except (urllib.error.URLError, TimeoutError):
            continue
    proc.terminate()
    raise SystemExit(f"the server on :{port} never came up")


def assert_isolated(base, instance: Path):
    """Every cycle, not only at boot. The one check that gates everything."""
    health = _req(base, "/api/health")
    data_dir = Path(health.get("dataDir", ""))
    want = (instance / "data").resolve()
    if data_dir.resolve() != want:
        raise SystemExit(
            f"ISOLATION BROKEN — refusing to continue.\n"
            f"  server reports dataDir = {data_dir}\n"
            f"  expected              = {want}")
    return str(data_dir)


def open_bench(base, players=5):
    """One DM and five players, seated for the whole night."""
    _req(base, "/api/table/close", "POST")
    opened = _req(base, "/api/table/open", "POST", {"name": "Night DM"})
    dm_token = opened["token"]
    seats = [{"id": "dm", "role": "dm", "name": "Night DM", "token": dm_token}]

    names = ["Kim", "Ash", "Rue", "Tam", "Vex"][:players]
    for i, name in enumerate(names, 1):
        cid = f"night-pc-{i}"
        _req(base, f"/api/characters/{cid}", "PUT", {
            "id": cid, "name": name,
            "classes": [{"class": "fighter", "subclass": None, "level": 5}],
            "abilities": {"str": 16, "dex": 14, "con": 14,
                          "int": 10, "wis": 12, "cha": 10},
            "inventory": [], "spells": [], "conditions": [],
        }, dm_token)
        joined = _req(base, "/api/table/join", "POST",
                      {"code": opened["code"], "name": name})
        tok = joined["token"]
        _req(base, "/api/table/claim", "POST", {"characterId": cid}, tok)
        seats.append({"id": f"p{i}", "role": "player", "name": name,
                      "token": tok, "characterId": cid})

    # A fight, running, with the party in it and a monster hurt enough to
    # have a band. Without this the encounter is empty and half the DM
    # catalogue measures a screen no table would ever be looking at - which
    # is how the initiative control came out wrong the first time.
    combatants = []
    for i, s in enumerate(seats[1:], 1):
        combatants.append({
            "id": f"c{i}", "characterId": s["characterId"], "name": s["name"],
            "init": 20 - i, "hp": 38 - i * 3, "maxHp": 38, "side": "ally",
            "conditions": [],
        })
    combatants.append({
        "id": "m1", "name": "Gym Ogre", "init": 11,
        "hp": 13, "maxHp": 59, "side": "enemy", "conditions": [],
    })
    _req(base, "/api/encounters/current", "PUT", {
        "id": "current", "started": True, "round": 3, "turn": 0,
        "showMonsterHp": False, "combatants": combatants,
    }, dm_token)
    return {"code": opened["code"], "seats": seats}


def truncate_events(instance: Path):
    """Between cycles, so cycle 30 is not measuring cycle 1's traffic.

    The event log is append-only by design and has no delete route, and the
    DM's Story feed queries it with no campaignId filter - so without this
    the screens would get steadily slower for a reason that has nothing to
    do with the size being measured. That would be a degradation curve
    reading its own run time.
    """
    f = instance / "data" / "events.jsonl"
    try:
        if f.exists():
            f.write_text("", encoding="utf-8")
            return True
    except OSError as e:
        print(f"  ! could not truncate the event log: {e}")
    return False


# ---------------------------------------------------------------- the loop


def sweep_cells():
    """Log-spaced days x seeds. Interleaved so an interrupted run still has
    a spread of sizes rather than every replicate of day 1 and nothing else."""
    cells = []
    for day in age.SWEEP_DAYS:
        for seed in age.SEEDS:
            cells.append({
                "day": day, "seed": seed,
                "source": "book" if seed in age.BOOK_SEEDS else "synthetic",
            })
    return cells


def run(args):
    NIGHT.mkdir(exist_ok=True)
    print("preflight")
    clear_stale_stop()
    if DONE.exists():
        if not args.fresh and not args.resume:
            raise SystemExit(
                "night/.done exists — a run already finished here.\n"
                "  pass --fresh to start over, or --resume to continue.")
        DONE.unlink()

    instance = (ROOT / args.instance).resolve() if not Path(args.instance).is_absolute() \
        else Path(args.instance)
    build_instance(ROOT, instance, args.fresh)
    base = f"http://127.0.0.1:{args.port}"

    proc = None
    try:
        urllib.request.urlopen(f"{base}/api/health", timeout=2)
        print(f"  reusing the server already on :{args.port}")
    except (urllib.error.URLError, TimeoutError):
        proc = start_server(instance, args.port)
        print(f"  started the server on :{args.port}")

    data_dir = assert_isolated(base, instance)
    print(f"  isolated: dataDir = {data_dir}")

    n_questions = reach.assert_no_drift(reach.load_catalogue())
    print(f"  catalogue: {n_questions} questions, {n_questions} probes")

    state = {}
    if args.resume and STATE.exists():
        state = json.loads(STATE.read_text(encoding="utf-8"))
        print(f"  resuming from cycle {state.get('cycle', 0)}")
    if not args.resume:
        ROWS.write_text("", encoding="utf-8")

    bench = open_bench(base)
    print(f"  bench: 1 DM + {len(bench['seats']) - 1} players, code {bench['code']}")

    cells = sweep_cells()
    seconds = args.minutes * 60 if args.minutes else args.hours * 3600
    deadline = time.time() + seconds
    cycle = int(state.get("cycle", 0))
    valid, invalid = list(state.get("valid", [])), list(state.get("invalid", []))
    stopping = {"now": False}

    def on_sig(*_):
        stopping["now"] = True
        print("\n  interrupt — finishing this cycle and writing the report")
    signal.signal(signal.SIGINT, on_sig)

    print(f"\nrunning until {time.strftime('%H:%M:%S', time.localtime(deadline))}"
          f" ({len(cells)} cells in the sweep)\n")

    # The availability tier is DETERMINISTIC: same seed, same day, same
    # payloads, same answers. Repeating it for eight hours would produce
    # duplicate rows and call the pile a measurement - the deterministic-band
    # trap, exactly. So a pass is compared with the one before it, and when
    # two consecutive passes agree the sweep has converged and there is
    # nothing further this tier can learn by running longer. Wall clock is
    # not evidence.
    passes = {"n": 0, "last": None, "converged_at": None}

    def pass_fingerprint():
        got = defaultdict(dict)
        for line in ROWS.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            key = (r["questionId"], r["role"], (r.get("size") or {}).get("day"))
            got[r["cycle"] // len(cells)][key] = r["available"]
        return got

    while time.time() < deadline and not stopping["now"]:
        if STOP.exists():
            print("  .stop seen — winding up")
            break

        if cycle and cycle % len(cells) == 0:
            passes["n"] += 1
            fp = pass_fingerprint()
            this, prev = fp.get(passes["n"] - 1), fp.get(passes["n"] - 2)
            if prev is not None and this == prev:
                passes["converged_at"] = cycle
                print(f"\n  the availability sweep CONVERGED after "
                      f"{passes['n']} passes — two consecutive passes agree on "
                      f"all {len(this)} cells.")
                print("  Running it longer would add duplicate rows, not "
                      "information. Stopping this tier.")
                break
            print(f"  --- pass {passes['n']} complete "
                  f"({len(this or {})} cells) ---")

        cell = cells[cycle % len(cells)]
        t0 = time.time()
        try:
            assert_isolated(base, instance)
            truncate_events(instance)
            ids = age.seed_bench_world(base, bench["seats"][0]["token"],
                                       cell["seed"], source=cell["source"])
            age.grow(base, bench["seats"][0]["token"], ids, cell["day"],
                     source=cell["source"])
            size = age.size_of(base, bench["seats"][0]["token"], ids)
            size["source"] = cell["source"]
            size["fellBackToSynthetic"] = ids.get("fellBackToSynthetic", False)

            # If the table died, every seat would report zero for everything -
            # a plausible-looking cliff that is entirely an artefact.
            table = _req(base, "/api/table", token=bench["seats"][0]["token"])
            if not table.get("open"):
                raise RuntimeError("the table is not open — seats are dead")

            rows = reach.measure_all(base, bench, ids, cycle, size)
            append_rows(ROWS, rows)
            bench["ids"] = ids
            atomic_write(BENCH, json.dumps(bench, indent=1))
            valid.append(cycle)
            print(f"  cycle {cycle:3d}  day {cell['day']:3d}  seed {cell['seed']:3d}"
                  f"  {cell['source']:9s}  {size['campaignBytes']:6d}B"
                  f"  {len(rows)} rows  {time.time() - t0:5.1f}s")
        except (RuntimeError, SystemExit, age.Refused, urllib.error.URLError,
                TimeoutError, json.JSONDecodeError, OSError) as e:
            invalid.append({"cycle": cycle, "why": f"{type(e).__name__}: {e}"[:180]})
            print(f"  cycle {cycle:3d}  EXCLUDED — {type(e).__name__}: {str(e)[:90]}")

        cycle += 1
        atomic_write(STATE, json.dumps({
            "cycle": cycle, "valid": valid, "invalid": invalid,
            "startedAt": state.get("startedAt") or time.strftime("%Y-%m-%dT%H:%M:%S"),
            "lastCycleAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "deadline": time.strftime("%Y-%m-%dT%H:%M:%S",
                                      time.localtime(deadline)),
            "cells": len(cells), "instance": str(instance), "port": args.port,
        }, indent=1))

    print(f"\n{len(valid)} cycles measured, {len(invalid)} excluded")
    DONE.touch()

    try:
        import night_report
        out = night_report.build()
        print(f"report: {out}")
    except Exception as e:                                    # noqa: BLE001
        # Money spent with no record of what it bought is the worst outcome;
        # the rows are on disk regardless, so say where they are.
        print(f"  ! the report failed ({type(e).__name__}: {e})")
        print(f"  the rows are intact at {ROWS} — rerun tools/night_report.py")
    finally:
        if proc:
            proc.terminate()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Overnight measurement run.")
    ap.add_argument("--hours", type=float, default=8)
    ap.add_argument("--minutes", type=float, default=None,
                    help="overrides --hours; use for the dry run")
    ap.add_argument("--port", type=int, default=7904)
    ap.add_argument("--instance", default="../grimoire-night")
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--dry", action="store_true",
                    help="label this run as a rehearsal in the report")
    run(ap.parse_args())
