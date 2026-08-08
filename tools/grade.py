"""Grade a campaign-emulator sweep.

    python tools/grade.py [path/to/sweep.json]

Four orthogonal dimensions, deliberately NOT collapsed into a single score:

  completion   did every class/subclass reach level 20?
  correctness  invariant violations (objective; a violation is a defect)
  coverage     what actually exercised, and explicitly what never did
  balance      paired ablation deltas with bootstrap CIs, coverage-gated

The balance section refuses to publish a number it cannot stand behind: a
class whose spell coverage is below the pre-registered gate is reported as
SUPPRESSED rather than estimated, and an ablation whose CI straddles zero is
reported as "no detectable effect" rather than as its point estimate.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SIM = ROOT / "data" / "sim"
BARS = ROOT / "sim" / "bars.json"

# Effects that influence every roll continuously rather than firing discretely.
# Reporting these as "never fired" is misleading - Living Alloy's AC is applied
# on every single attack against the character, it just has no fire event.
PASSIVE_EFFECTS = {
    "ac_formula", "unarmed_strike", "ability_substitution", "resistance",
    "immunity", "condition_immunity", "speed_grant", "proficiency",
    "advantage_rule", "resource", "always_prepared_spells", "toggle",
}
ACTIVE_EFFECTS = {"trigger", "roll_table", "action_option", "reaction_option",
                  "damage_rider"}


def load_bars() -> dict:
    if BARS.exists():
        return json.loads(BARS.read_text(encoding="utf-8"))
    return {}


def bootstrap_ci(deltas: np.ndarray, iters: int = 10000, alpha: float = 0.05):
    """Percentile bootstrap CI for the mean of paired deltas."""
    if len(deltas) < 2:
        return float(deltas.mean()) if len(deltas) else 0.0, (float("nan"), float("nan"))
    rng = np.random.default_rng(12345)     # fixed: grading must be reproducible
    idx = rng.integers(0, len(deltas), size=(iters, len(deltas)))
    means = deltas[idx].mean(axis=1)
    lo, hi = np.percentile(means, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return float(deltas.mean()), (float(lo), float(hi))


def grade(payload: dict, bars: dict) -> dict:
    out = {"config": payload.get("config", {})}
    combos = payload.get("byCombo", {})

    # ---- 1. completion ---------------------------------------------------
    completion = {}
    for key, c in combos.items():
        completion[key] = {
            "name": c["name"], "kind": c["kind"], "classId": c["classId"],
            "runs": c["runs"], "completed": c["completed"],
            "rate": c["completed"] / c["runs"] if c["runs"] else 0.0,
            "deaths": c["deaths"],
            "medianDeathLevel": (
                float(np.median(c["deaths"])) if c["deaths"] else None
            ),
        }
    out["completion"] = completion
    out["completionRate"] = (
        sum(c["completed"] for c in combos.values())
        / max(1, sum(c["runs"] for c in combos.values()))
    )

    # ---- 2. correctness --------------------------------------------------
    inv = payload.get("invariants", {})
    out["correctness"] = {
        "clean": inv.get("clean", False),
        "checked": len(inv.get("checked", [])),
        "violations": inv.get("violations", {}),
        "samples": inv.get("samples", {}),
        "totalViolations": sum(inv.get("violations", {}).values()),
    }

    # ---- 3. coverage -----------------------------------------------------
    cov = payload.get("coverage", {})
    present = {
        k.replace(":present", "")
        for k in cov.get("effectTypes", {}) if k.endswith(":present")
    }
    # Firing is recorded across several buckets, not just effectTypes. Checking
    # only one bucket reports triggers as dead when the trigger bucket shows
    # them firing - a bug in the ORIGINAL neverFired computation.
    fired_any = set()
    for k in cov.get("effectTypes", {}):
        if not k.endswith(":present"):
            fired_any.add(k)
    if cov.get("triggers"):
        fired_any.add("trigger")
    if cov.get("rollTables"):
        fired_any.add("roll_table")
    if cov.get("features"):
        fired_any.add("action_option")

    never_active = sorted(
        e for e in present if e in ACTIVE_EFFECTS and e not in fired_any
    )
    passive_present = sorted(e for e in present if e in PASSIVE_EFFECTS)

    out["coverage"] = {
        "spellsCast": len(cov.get("spells", {})),
        "featuresUsed": len(cov.get("features", {})),
        "eventTypes": len(cov.get("eventTypes", {})),
        "triggersFired": sum(cov.get("triggers", {}).values()),
        "tablesRolled": sum(cov.get("rollTables", {}).values()),
        "effectsPresent": sorted(present),
        # The finding that matters: ACTIVE effects that exist but never fired.
        "activeNeverFired": never_active,
        "passiveAlwaysOn": passive_present,
        "topSpells": sorted(
            cov.get("spells", {}).items(), key=lambda kv: -kv[1],
        )[:12],
    }

    # ---- 4. balance ------------------------------------------------------
    gate = bars.get("spellCoverageGate", 0.70)
    spell_cov = payload.get("spellCoverage", {})
    suppressed = {
        cid: info for cid, info in spell_cov.items()
        if info.get("combatCoverage", 1.0) < gate
    }

    ablations = payload.get("ablations", [])
    grouped: dict[str, list] = {}
    for a in ablations:
        grouped.setdefault(a["label"], []).append(a)

    balance = []
    for label, rows in sorted(grouped.items()):
        d_dpr = np.array([r["on"]["dpr"] - r["off"]["dpr"] for r in rows], dtype=float)
        d_dtpr = np.array([r["on"]["dtpr"] - r["off"]["dtpr"] for r in rows], dtype=float)
        d_down = np.array(
            [r["on"]["downRate"] - r["off"]["downRate"] for r in rows], dtype=float,
        )
        # Control matters as much as damage for some effect types. A feature
        # action that pulls a creature or applies a condition contributes
        # exactly ZERO damage by construction, so judging it on DPA alone
        # produces a [0.00, 0.00] interval and calls it "no effect" - an
        # unfalsifiable test dressed up as a null result.
        d_cpa = np.array([r["on"].get("cpa", 0) - r["off"].get("cpa", 0)
                          for r in rows], dtype=float)

        mean_dpr, ci_dpr = bootstrap_ci(d_dpr)
        mean_dtpr, ci_dtpr = bootstrap_ci(d_dtpr)
        mean_down, ci_down = bootstrap_ci(d_down)
        mean_cpa, ci_cpa = bootstrap_ci(d_cpa)

        base = float(np.mean([r["off"]["dpr"] for r in rows])) or 1.0
        det_dpr = not (ci_dpr[0] <= 0 <= ci_dpr[1])
        det_cpa = not (ci_cpa[0] <= 0 <= ci_cpa[1])
        detectable = det_dpr or det_cpa

        # A degenerate interval means the metric cannot see this effect type at
        # all. Say so, rather than reporting it as evidence of no effect.
        degenerate_dpr = float(np.all(d_dpr == 0))

        balance.append({
            "label": label,
            "classId": rows[0]["classId"],
            "subclassId": rows[0]["subclassId"],
            "effectType": rows[0]["effectType"],
            "n": len(rows),
            "dDpr": mean_dpr, "ciDpr": ci_dpr,
            "dDprPct": 100 * mean_dpr / base if base else 0.0,
            "dDtpr": mean_dtpr, "ciDtpr": ci_dtpr,
            "dDownRate": mean_down, "ciDown": ci_down,
            "dCpa": mean_cpa, "ciCpa": ci_cpa,
            "detectableDamage": det_dpr,
            "detectableControl": det_cpa,
            # An interval containing zero is not a finding, whatever the mean is.
            "detectable": detectable,
            # True when the damage axis is structurally blind to this effect.
            "damageAxisBlind": bool(degenerate_dpr),
            "suppressed": rows[0]["classId"] in suppressed,
        })

    out["balance"] = {
        "gate": gate,
        "suppressedClasses": {
            k: v.get("combatCoverage") for k, v in suppressed.items()
        },
        "ablations": balance,
    }
    return out


def report(g: dict) -> None:
    print("=" * 74)
    print("GRIMOIRE CAMPAIGN EMULATOR - GRADE")
    print("=" * 74)
    cfg = g["config"]
    print(f"{cfg.get('combos')} combos x {cfg.get('seeds')} seeds "
          f"to level {cfg.get('maxLevel', 20)} in {cfg.get('elapsedSeconds')}s")

    print("\n--- 1. COMPLETION " + "-" * 55)
    rows = sorted(g["completion"].values(), key=lambda r: -r["rate"])
    for r in rows:
        bar = "#" * int(r["rate"] * 20)
        tag = " [brew]" if r["kind"] == "homebrew" else ""
        died = (f"  median death L{r['medianDeathLevel']:.0f}"
                if r["medianDeathLevel"] else "")
        print(f"  {r['name'][:26]:<26}{tag:<7} {r['completed']:>2}/{r['runs']:<2} "
              f"{r['rate'] * 100:>5.1f}% {bar:<20}{died}")
    print(f"\n  overall {g['completionRate'] * 100:.1f}%")

    print("\n--- 2. CORRECTNESS " + "-" * 54)
    c = g["correctness"]
    if c["clean"]:
        print(f"  CLEAN - {c['checked']} invariants held on every tick of every run")
    else:
        print(f"  {c['totalViolations']} violations across {len(c['violations'])} invariants")
        for iid, n in sorted(c["violations"].items(), key=lambda kv: -kv[1]):
            s = c["samples"].get(iid, {})
            where = s.get("where", {})
            print(f"    {iid:<28} {n:>5}  e.g. {s.get('detail')} "
                  f"@ {where.get('classId')} L{where.get('level')}")

    print("\n--- 3. COVERAGE " + "-" * 57)
    cv = g["coverage"]
    print(f"  spells cast     {cv['spellsCast']:>4} distinct")
    print(f"  features used   {cv['featuresUsed']:>4} distinct")
    print(f"  event types     {cv['eventTypes']:>4} distinct")
    print(f"  triggers fired  {cv['triggersFired']:>4}")
    print(f"  tables rolled   {cv['tablesRolled']:>4}")
    if cv["activeNeverFired"]:
        print(f"\n  ! ACTIVE effects present but NEVER fired - these are UNTESTED,")
        print(f"    not passing: {', '.join(cv['activeNeverFired'])}")
    else:
        print("\n  every active effect type fired at least once")
    print(f"  passive effects (always on, no discrete fire event): "
          f"{len(cv['passiveAlwaysOn'])}")

    print("\n--- 4. BALANCE (paired ablation) " + "-" * 40)
    b = g["balance"]
    if b["suppressedClasses"]:
        print(f"  SUPPRESSED below {b['gate']:.0%} spell coverage: "
              + ", ".join(f"{k} ({v:.0%})" for k, v in b["suppressedClasses"].items()))
    if not b["ablations"]:
        print("  no ablations in this sweep")
    else:
        print(f"  {'feature':<42} {'n':>3} {'dDPA':>7} {'95% CI':>16} "
              f"{'dCTRL':>7}  verdict")
        blind = 0
        for a in b["ablations"]:
            ci = f"[{a['ciDpr'][0]:+.2f},{a['ciDpr'][1]:+.2f}]"
            if a["suppressed"]:
                flag = "SUPPRESSED"
            elif a.get("damageAxisBlind") and not a.get("detectableControl"):
                flag = "damage-axis blind"
                blind += 1
            elif a.get("detectableControl") and not a.get("detectableDamage"):
                flag = "detectable (control)"
            elif a["detectable"]:
                flag = "detectable"
            else:
                flag = "none detected"
            print(f"  {a['label'][:42]:<42} {a['n']:>3} {a['dDpr']:>+7.2f} "
                  f"{ci:>16} {a.get('dCpa', 0):>+7.3f}  {flag}")
        if blind:
            print()
            print(f"  ! {blind} ablations are DAMAGE-AXIS BLIND: removing the")
            print("    effect changes damage by exactly zero because it never")
            print("    dealt damage. That is not evidence of no effect - it means")
            print("    this metric cannot see that effect type at all.")
    print("=" * 74)


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else SIM / "latest.json"
    if not path.exists():
        print(f"no sweep at {path} - run one from /sim/sim.html first",
              file=sys.stderr)
        return 1
    payload = json.loads(path.read_text(encoding="utf-8"))
    bars = load_bars()
    g = grade(payload, bars)
    report(g)

    out = SIM / "grade.json"
    out.write_text(json.dumps(g, indent=1, default=float), encoding="utf-8")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
