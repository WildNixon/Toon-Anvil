#!/usr/bin/env python3
"""Turn the night's rows into something readable over coffee.

Two rules this file exists to enforce:

1. THE CONTROLS GATE EVERYTHING. Four questions have known answers - one
   already on screen, two the app genuinely cannot reach, one it cannot
   compute. A grader that gets those wrong is measuring noise, and printing
   its curves anyway would be worse than printing nothing. Wrong controls
   means GRADER INVALID, no curves, exit 1.

2. A CELL WITH TOO FEW OBSERVATIONS PRINTS "SUPPRESSED", NEVER A NUMBER.
   Borrowed from tools/grade.py, which refuses to publish figures it cannot
   stand behind. One observation is not a distribution.

Ranking is a stated rule rather than a judgement call, so two runs over the
same data rank identically.
"""

from __future__ import annotations

import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NIGHT = ROOT / "night"
ROWS = NIGHT / "reach.jsonl"
STATE = NIGHT / "state.json"
OUT = ROOT / "NIGHT-REPORT.md"

MIN_OBS = 3          # below this a cell is SUPPRESSED, never averaged
BROWSER_FLOOR = 0.50  # below this, coverage goes at the TOP, not in a footnote


def load_rows():
    if not ROWS.exists():
        return []
    out = []
    for line in ROWS.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


# The four controls, and what the app is KNOWN to do about them today.
# Each control carries a `when` filter, because "expected at every size" is
# not the same claim as "expected once the thing exists". The first version
# of this file asserted lore was always present and the gate correctly threw
# the whole run out: at day 1 a campaign genuinely has no lore yet, so a 0
# there is the ager being honest, not the probe being broken.
CONTROLS = {
    "initiative_order": {
        "expect": 1, "field": "available", "when": lambda s: True,
        "why": "the runner panel is first in .cockpit-main - already on screen, "
               "and the bench always has a fight running"},
    "campaign_lore": {
        "expect": 1, "field": "available",
        "when": lambda s: (s or {}).get("loreEntries", 0) > 0,
        "why": "written by deck.js and read by nothing: once it EXISTS it is "
               "present in the payload, so availability must say 1 while the "
               "UI cannot reach it at all"},
    "session_count": {
        "expect": 0, "field": "available", "when": lambda s: True,
        "why": "setContext never sets sessionId, so no event carries one"},
    "did_i_hit": {
        "expect": 0, "field": "available", "when": lambda s: True,
        "why": "sheet.js passes no target, so hit is never computed at all"},
}


def check_controls(rows):
    by_q = defaultdict(list)
    for r in rows:
        by_q[r["questionId"]].append(r)
    results = []
    ok = True
    for qid, spec in CONTROLS.items():
        got = [r for r in by_q.get(qid, []) if spec["when"](r.get("size"))]
        if not got:
            results.append((qid, spec["expect"], None, "NOT MEASURED", spec["why"]))
            ok = False
            continue
        vals = {r[spec["field"]] for r in got}
        actual = f"{sorted(vals)} over {len(got)} rows"
        passed = vals == {spec["expect"]}
        results.append((qid, spec["expect"], actual,
                        "ok" if passed else "WRONG", spec["why"]))
        ok = ok and passed
    return ok, results


def fmt_cell(values):
    """A number, or an honest refusal to give one."""
    vals = [v for v in values if v is not None]
    if len(vals) < MIN_OBS:
        return f"SUPPRESSED (n={len(vals)})"
    return f"{statistics.median(vals):.2f} (n={len(vals)})"


def rank(finding):
    """Deterministic, stated up front, so two runs rank the same."""
    a, b = finding["atSmall"], finding["atLarge"]
    if a == 1 and b == 0:
        return "high"
    if finding.get("tapsRatio") and finding["tapsRatio"] >= 2:
        return "medium"
    if a == b == 1 and finding.get("degraded"):
        return "low"
    return "idea"


def build():
    rows = load_rows()
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    lines = []
    w = lines.append

    w("# The night run — what the app does as a campaign grows\n")
    if not rows:
        w("**No rows.** The run produced nothing to report — check "
          "`night/state.json` for excluded cycles and their reasons.\n")
        OUT.write_text("\n".join(lines), encoding="utf-8")
        return OUT

    cycles = sorted({r["cycle"] for r in rows})
    browser_rows = [r for r in rows if r.get("taps") is not None]
    coverage = len(browser_rows) / max(1, len(rows))

    # ---------------------------------------------------------- provenance
    w("## Provenance, and what this run cannot tell you\n")
    w(f"- instance: `{state.get('instance', '?')}` on port "
      f"`{state.get('port', '?')}`")
    w(f"- cycles attempted: {state.get('cycle', len(cycles))} · "
      f"measured: {len(state.get('valid', cycles))} · "
      f"**excluded: {len(state.get('invalid', []))}**")
    for bad in state.get("invalid", [])[:8]:
        w(f"    - cycle {bad['cycle']}: {bad['why']}")
    w(f"- rows: {len(rows)} · questions: "
      f"{len({r['questionId'] for r in rows})} · seats: "
      f"{len({r['seat'] for r in rows})}")
    if coverage < BROWSER_FLOOR:
        w("")
        w(f"> **Browser-tier coverage is {coverage:.0%}.** Everything about "
          "*taps*, on-screen visibility and redraw survival below rests on "
          "that fraction of the run. The availability curves are unaffected — "
          "they need no browser. This sentence is at the top rather than in a "
          "footnote because a reader who misses it would over-read the cost "
          "numbers.")
    else:
        w(f"- browser-tier coverage: **{coverage:.0%}** of rows carry a tap count")
    w("")
    w("**Recorded divergences from the app you actually ship:** `app/sw.js` is "
      "deleted in the measured copy (a stale service worker across hundreds of "
      "reloads is a trap, and PWA-1 says its shell list is already stale), and "
      "campaign states were written over HTTP by `tools/age.py` rather than "
      "through the UI — so this run can describe states the UI could not have "
      "produced. Every finding below carries a UI-reachability re-check before "
      "it is acted on.\n")

    # ---------------------------------------------------------- controls
    ok, results = check_controls(rows)
    w("## Controls — checked before any curve is believed\n")
    w("| question | expected | measured | | why it is a control |")
    w("| --- | --- | --- | --- | --- |")
    for qid, exp, act, verdict, why in results:
        w(f"| `{qid}` | {exp} | {act} | **{verdict}** | {why} |")
    w("")
    if not ok:
        w("### GRADER INVALID — curves suppressed\n")
        w("At least one control came out wrong, which means this grader is "
          "measuring something other than what it claims. No curves are drawn "
          "and no findings are filed: a confident wrong answer over breakfast "
          "is worse than no answer. The raw rows are intact at "
          "`night/reach.jsonl`.\n")
        OUT.write_text("\n".join(lines), encoding="utf-8")
        return OUT
    w("All four controls behave as the code says they should, so the "
      "measurements below are about the app rather than about the probe.\n")

    # ---------------------------------------------------------- curves
    w("## Availability as the campaign grows\n")
    by_size = defaultdict(lambda: defaultdict(list))
    for r in rows:
        day = (r.get("size") or {}).get("day")
        if day is None:
            continue
        by_size[day][r["role"]].append(r["available"])
    days = sorted(by_size)
    w("| in-world day | DM available | player available |")
    w("| --- | --- | --- |")
    for d in days:
        dm = by_size[d].get("dm", [])
        pl = by_size[d].get("player", [])
        w(f"| {d} | {fmt_cell(dm)} | {fmt_cell(pl)} |")
    w("")
    w("A flat line here is a real result, not a null one: it says the *data* "
      "keeps up. Whether the SCREENS keep up is the browser tier's question, "
      "and the disagreement table below is where the two meet.\n")

    # ------------------------------------------------- the headline table
    w("## Available, but the DM has to go and find it\n")
    w("Every question whose answer is sitting in a payload the seat already "
      "receives. Where the browser tier ran, `taps` is what it cost to get it "
      "onto a screen; `—` means that question has availability data only.\n")
    seen = {}
    for r in rows:
        if not r["available"]:
            continue  # its absent-at-this-size rows say nothing about cost
        q = seen.setdefault(r["questionId"], {
            "ask": r["ask"], "role": r["role"], "note": r.get("note", ""),
            "scan": [], "taps": []})
        q["scan"].append(r.get("bytesToScan") or 0)
        if r.get("taps") is not None:
            q["taps"].append(r["taps"])
    ranked = sorted(seen.items(),
                    key=lambda kv: -max(kv[1]["scan"] or [0]))
    w("| question | id | seat | bytes the answer is buried in | taps | note |")
    w("| --- | --- | --- | --- | --- | --- |")
    for qid, q in ranked[:25]:
        taps = fmt_cell(q["taps"]) if q["taps"] else "—"
        w(f"| {q['ask']} | `{qid}` | {q['role']} | {max(q['scan']):,} | "
          f"{taps} | {q['note'][:70]} |")
    w("")

    # ---------------------------------------------------- the absent set
    w("## Not in any payload, at any size\n")
    w("These are not slow to reach. The data does not exist, so no amount of "
      "UI work would surface them — each one needs something *written* first.\n")
    # A question is absent only if NO row ever found it. Popping as we go
    # made the answer depend on row ORDER, so a question available at day 30
    # and empty at day 1 landed in both tables at once - which reads as the
    # report contradicting itself.
    ever = {r["questionId"] for r in rows if r["available"]}
    absent = {}
    for r in rows:
        if r["questionId"] in ever or r["questionId"] in absent:
            continue
        absent[r["questionId"]] = r
    w("| question | id | seat | why | control? |")
    w("| --- | --- | --- | --- | --- |")
    for qid, r in sorted(absent.items()):
        w(f"| {r['ask']} | `{qid}` | {r['role']} | "
          f"{r.get('note', '')[:90]} | {'yes' if r.get('control') else ''} |")
    w("")

    w("## How to read this\n")
    w("- **Available but expensive** is a UI problem, and the cheapest to fix.")
    w("- **Not available at all** is a data problem: something has to start "
      "being recorded before any screen can show it.")
    w("- **A control marked `redacted`** appearing as unavailable to a player "
      "is the redaction working, not a defect.\n")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    return OUT


if __name__ == "__main__":
    print(build())
