"""Render charts and an HTML report from a graded sweep.

    python tools/charts.py

matplotlib, written to PNG, assembled into data/sim/report.html. No CDN, no
network - the report opens offline like the rest of the app.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt          # noqa: E402
import numpy as np                        # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SIM = ROOT / "data" / "sim"
OUT = SIM / "charts"

IRON = "#1c2124"
MOLTEN = "#b84a16"
VERDIGRIS = "#2f6b62"
SLAG = "#3a4247"
STEEL = "#d2d6d3"
BAD = "#a3301a"
WARN = "#9a6a12"


def style(ax, title, xlabel=None, ylabel=None):
    ax.set_title(title, fontsize=12, color=IRON, weight="bold", loc="left", pad=12)
    if xlabel:
        ax.set_xlabel(xlabel, fontsize=9, color=SLAG)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=9, color=SLAG)
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color(SLAG)
    ax.tick_params(colors=SLAG, labelsize=8)
    ax.grid(axis="both", color=SLAG, alpha=0.12, linewidth=0.6)
    ax.set_axisbelow(True)


def fig(w=9, h=5):
    f, ax = plt.subplots(figsize=(w, h), dpi=130)
    f.patch.set_facecolor("white")
    ax.set_facecolor("white")
    return f, ax


def save(f, name):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    f.tight_layout()
    f.savefig(path, facecolor="white", bbox_inches="tight")
    plt.close(f)
    print(f"  {name}")
    return name


# ---------------------------------------------------------------- charts

def chart_completion(g, bar):
    rows = sorted(g["completion"].values(), key=lambda r: r["rate"])
    names = [f"{r['name']}{' *' if r['kind'] == 'homebrew' else ''}" for r in rows]
    rates = [r["rate"] * 100 for r in rows]
    colors = [MOLTEN if r["kind"] == "homebrew" else
              (VERDIGRIS if r["rate"] >= bar else BAD) for r in rows]

    f, ax = fig(9, 6)
    ax.barh(names, rates, color=colors, height=0.68)
    ax.axvline(bar * 100, color=IRON, linestyle="--", linewidth=1.2)
    ax.text(bar * 100 + 1, -0.6, f"pre-registered bar {bar:.0%}",
            fontsize=8, color=IRON)
    ax.set_xlim(0, 100)
    style(ax, "Campaign completion to level 20", "% of seeded runs completed")
    return save(f, "completion.png")


def chart_death_levels(g):
    rows = [r for r in g["completion"].values() if r["deaths"]]
    if not rows:
        return None
    rows.sort(key=lambda r: np.median(r["deaths"]))
    f, ax = fig(9, 6)
    data = [r["deaths"] for r in rows]
    labels = [r["name"] for r in rows]
    bp = ax.boxplot(data, vert=False, labels=labels, patch_artist=True,
                    widths=0.6, medianprops=dict(color=MOLTEN, linewidth=2))
    for patch, r in zip(bp["boxes"], rows):
        patch.set_facecolor(MOLTEN if r["kind"] == "homebrew" else STEEL)
        patch.set_edgecolor(SLAG)
    ax.set_xlim(0, 21)
    style(ax, "Where campaigns end (level at death)", "character level")
    return save(f, "death-levels.png")


def chart_ablations(g):
    abl = [a for a in g["balance"]["ablations"] if a["n"] >= 2]
    if not abl:
        return None
    abl.sort(key=lambda a: a["dDpr"])
    f, ax = fig(9, max(4, 0.42 * len(abl) + 1.6))

    ys = np.arange(len(abl))
    means = [a["dDpr"] for a in abl]
    los = [a["dDpr"] - a["ciDpr"][0] for a in abl]
    his = [a["ciDpr"][1] - a["dDpr"] for a in abl]
    colors = [MOLTEN if a["detectable"] else SLAG for a in abl]

    ax.errorbar(means, ys, xerr=[los, his], fmt="o", color=IRON,
                ecolor=SLAG, elinewidth=1.3, capsize=3, markersize=0)
    for y, m, c in zip(ys, means, colors):
        ax.plot(m, y, "o", color=c, markersize=7)
    ax.axvline(0, color=IRON, linewidth=1.4)
    ax.set_yticks(ys)
    ax.set_yticklabels([a["label"][:46] for a in abl], fontsize=7.5)
    style(ax, "Ablation: damage-per-action delta with feature ON vs OFF (95% CI)",
          "Δ damage per action   —   interval crossing 0 = no detectable effect")
    return save(f, "ablations.png")


def chart_coverage(g):
    cv = g["coverage"]
    f, ax = fig(9, 4.2)
    cats = ["spells cast", "features used", "event types",
            "triggers fired", "tables rolled"]
    vals = [cv["spellsCast"], cv["featuresUsed"], cv["eventTypes"],
            cv["triggersFired"], cv["tablesRolled"]]
    ax.bar(cats, vals, color=[VERDIGRIS if v > 0 else BAD for v in vals], width=0.6)
    for i, v in enumerate(vals):
        ax.text(i, v, f" {v}", ha="center", va="bottom", fontsize=9, color=IRON)
    style(ax, "What the sweep actually exercised", ylabel="count")
    if cv["activeNeverFired"]:
        ax.text(0, max(vals) * 0.86,
                "NEVER FIRED (untested): " + ", ".join(cv["activeNeverFired"]),
                fontsize=9, color=BAD, weight="bold")
    return save(f, "coverage.png")


def chart_spell_coverage(payload, gate):
    sc = payload.get("spellCoverage", {})
    if not sc:
        return None
    items = sorted(sc.items(), key=lambda kv: kv[1]["combatCoverage"])
    names = [k for k, _ in items]
    vals = [v["combatCoverage"] * 100 for _, v in items]
    f, ax = fig(9, 4.4)
    ax.barh(names, vals,
            color=[BAD if v < gate * 100 else VERDIGRIS for v in vals], height=0.62)
    ax.axvline(gate * 100, color=IRON, linestyle="--", linewidth=1.2)
    ax.text(gate * 100 + 1, -0.6, f"gate {gate:.0%}", fontsize=8, color=IRON)
    ax.set_xlim(0, 100)
    style(ax, "Executable spell coverage (combat-relevant spells only)",
          "% of a class's combat spells the engine can actually run")
    return save(f, "spell-coverage.png")


# ---------------------------------------------------------------- report

def build_report(g, payload, images, bars):
    c = g["correctness"]
    cv = g["coverage"]
    comp = g["completionRate"]
    bar = bars.get("completionTarget", 0.9)

    def card(label, value, ok):
        color = VERDIGRIS if ok else BAD
        return (f'<div class="card"><div class="k">{label}</div>'
                f'<div class="v" style="color:{color}">{value}</div></div>')

    cards = "".join([
        card("Completion", f"{comp:.0%}", comp >= bar),
        card("Invariants", "clean" if c["clean"] else f"{c['totalViolations']} viol",
             c["clean"]),
        card("Active effects untested", str(len(cv["activeNeverFired"])),
             not cv["activeNeverFired"]),
        card("Detectable ablations",
             f"{sum(1 for a in g['balance']['ablations'] if a['detectable'])}"
             f"/{len(g['balance']['ablations'])}", True),
    ])

    imgs = "".join(
        f'<figure><img src="charts/{n}" alt=""></figure>' for n in images if n
    )

    warn = ""
    if comp < bar:
        warn = (
            '<div class="warn"><strong>Completion is below the pre-registered '
            f'bar ({bar:.0%}).</strong> Classes that die early produce no '
            'high-level data, and their balance numbers are not comparable to '
            'classes that finish. Treat cross-class rankings in this report as '
            'unreliable until completion clears the bar.</div>')

    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>Toon Anvil — emulator report</title>
<style>
 body{{font-family:Georgia,serif;max-width:1000px;margin:36px auto;padding:0 20px;
      color:{IRON};line-height:1.55}}
 h1,h2{{font-family:'Arial Black',Impact,sans-serif;text-transform:uppercase;
        letter-spacing:-.01em}}
 h1{{border-bottom:6px solid {IRON};padding-bottom:8px}}
 h2{{color:{MOLTEN};margin-top:34px;font-size:18px}}
 .cards{{display:flex;gap:14px;flex-wrap:wrap;margin:20px 0}}
 .card{{flex:1;min-width:150px;background:{STEEL};border-top:4px solid {IRON};
        padding:12px}}
 .card .k{{font-family:monospace;font-size:10px;letter-spacing:.16em;
           text-transform:uppercase;color:{SLAG}}}
 .card .v{{font-family:'Arial Black',sans-serif;font-size:26px}}
 figure{{margin:22px 0}} img{{max-width:100%;border:1px solid #ddd}}
 .warn{{background:#fdf3e7;border-left:4px solid {WARN};padding:14px 16px;
        margin:18px 0}}
 code{{font-family:Consolas,monospace;font-size:.85em}}
 table{{border-collapse:collapse;width:100%;font-size:14px}}
 th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid #ddd}}
 th{{font-family:monospace;font-size:10px;letter-spacing:.12em;
     text-transform:uppercase;color:{SLAG}}}
 .muted{{color:{SLAG}}}
</style></head><body>
<h1>Campaign emulator — report</h1>
<p class="muted">{g['config'].get('combos')} class/subclass combinations ×
{g['config'].get('seeds')} seeds, level 1–20, in
{g['config'].get('elapsedSeconds')}s. Bars pre-registered in
<code>sim/bars.json</code> v{bars.get('version')}.</p>
{cards}
{warn}
<h2>Charts</h2>
{imgs}
<h2>Ablations</h2>
<p class="muted">Each row compares a character to <em>itself</em> with one
effect removed, on the same seeds. An interval crossing zero means the effect
had no measurable impact on damage per action — not that it does nothing, but
that this instrument cannot see it.</p>
<table><tr><th>Feature</th><th>n</th><th>ΔDPA</th><th>95% CI</th><th>Verdict</th></tr>
{''.join(
    f"<tr><td>{a['label']}</td><td>{a['n']}</td>"
    f"<td>{a['dDpr']:+.2f}</td>"
    f"<td>[{a['ciDpr'][0]:+.2f}, {a['ciDpr'][1]:+.2f}]</td>"
    f"<td>{'detectable' if a['detectable'] else 'none detected'}</td></tr>"
    for a in g['balance']['ablations'])}
</table>
<h2>Honest limits</h2>
<ul>
<li>One shared tactical policy is used for every class, so cross-class
comparison measures the policy as much as the class. Ablation is unaffected
because it compares a character to itself on the same seeds.</li>
<li>Damage per action counts total damage across all targets, so area casters
score far above single-target martials. That is a real advantage, but not the
20× the raw numbers suggest.</li>
<li>{len(cv['activeNeverFired'])} active effect types never fired and are
therefore <strong>untested</strong>, not passing.</li>
<li>Spell coverage gates balance claims: classes below
{g['balance']['gate']:.0%} combat-relevant coverage are suppressed rather than
estimated.</li>
</ul>
<p class="muted">Generated by <code>tools/charts.py</code>.</p>
</body></html>"""


def main() -> int:
    grade_path = SIM / "grade.json"
    sweep_path = SIM / "latest.json"
    if not grade_path.exists():
        print("run tools/grade.py first", file=sys.stderr)
        return 1
    g = json.loads(grade_path.read_text(encoding="utf-8"))
    payload = json.loads(sweep_path.read_text(encoding="utf-8"))
    bars = json.loads((ROOT / "sim" / "bars.json").read_text(encoding="utf-8"))

    print("charts:")
    images = [
        chart_completion(g, bars.get("completionTarget", 0.9)),
        chart_death_levels(g),
        chart_ablations(g),
        chart_coverage(g),
        chart_spell_coverage(payload, g["balance"]["gate"]),
    ]

    report = SIM / "report.html"
    report.write_text(build_report(g, payload, images, bars), encoding="utf-8")
    print(f"\nwrote {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
