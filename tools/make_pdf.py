"""Render a character sheet to PDF.

Takes the JSON produced by app/homebrew/sheet.js `sheetJson()` and lays it out
with reportlab. The browser could print-to-PDF, but that requires a human at a
dialog; this makes "give me a PDF" a one-click server call, and it is the same
path the batch tooling uses.

Numbers are NOT recomputed here. Everything arrives pre-derived from derive.js,
the same engine the app plays with, so a printed sheet can never disagree with
the in-app sheet.

    python tools/make_pdf.py sheet.json out.pdf
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    KeepTogether,
)

IRON = colors.HexColor("#1c2124")
SLAG = colors.HexColor("#3a4247")
MOLTEN = colors.HexColor("#b84a16")
RULE = colors.HexColor("#d7dbd8")

ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"]


def styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=22, leading=25, textColor=IRON, alignment=0, spaceAfter=2,
        ),
        "sub": ParagraphStyle(
            "sub", parent=base["Normal"], fontName="Courier",
            fontSize=8, leading=11, textColor=SLAG, spaceAfter=10,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=10, leading=13, textColor=MOLTEN, spaceBefore=11,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "body", parent=base["Normal"], fontName="Times-Roman",
            fontSize=9, leading=12, textColor=IRON,
        ),
        "note": ParagraphStyle(
            "note", parent=base["Normal"], fontName="Courier",
            fontSize=7.5, leading=10, textColor=SLAG,
        ),
    }


def sign(n) -> str:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return str(n)
    return f"+{n}" if n >= 0 else str(n)


def grid(data, widths, st, header=False, align_mono=()):
    t = Table(data, colWidths=widths, hAlign="LEFT")
    cmds = [
        ("FONTNAME", (0, 0), (-1, -1), "Times-Roman"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("TEXTCOLOR", (0, 0), (-1, -1), IRON),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]
    if header:
        cmds += [
            ("FONTNAME", (0, 0), (-1, 0), "Courier-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 6.5),
            ("TEXTCOLOR", (0, 0), (-1, 0), SLAG),
        ]
    for col in align_mono:
        cmds.append(("FONTNAME", (col, 1 if header else 0), (col, -1), "Courier"))
    t.setStyle(TableStyle(cmds))
    return t


def stat_row(cells, st):
    """The boxed stat strip along the top."""
    data = [[Paragraph(f"<font size=6 color='#3a4247'>{k.upper()}</font><br/>"
                       f"<font size=15><b>{v}</b></font>"
                       + (f"<br/><font size=6 color='#3a4247'>{s}</font>" if s else ""),
                       st["body"]) for k, v, s in cells]]
    t = Table(data, colWidths=[(180 * mm) / len(cells)] * len(cells), hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 1.1, IRON),
        ("INNERGRID", (0, 0), (-1, -1), 1.1, IRON),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def build(sheet: dict, out_path: Path) -> Path:
    st = styles()
    doc = BaseDocTemplate(
        str(out_path), pagesize=LETTER,
        leftMargin=14 * mm, rightMargin=14 * mm,
        topMargin=13 * mm, bottomMargin=13 * mm,
        title=f"{sheet.get('name', 'Character')} — level {sheet.get('level')}",
        author="Toon Anvil",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")

    def decorate(canvas, _doc):
        canvas.saveState()
        canvas.setStrokeColor(IRON)
        canvas.setLineWidth(3)
        y = LETTER[1] - 13 * mm
        canvas.line(14 * mm, y, LETTER[0] - 14 * mm, y)
        canvas.setFont("Courier", 6.5)
        canvas.setFillColor(SLAG)
        canvas.drawRightString(LETTER[0] - 14 * mm, 8 * mm,
                               f"Toon Anvil · page {canvas.getPageNumber()}")
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=decorate)])

    flow = []
    flow.append(Paragraph(sheet.get("name", "Character"), st["title"]))
    src = sheet.get("source") or {}
    flow.append(Paragraph(
        f"{sheet.get('class', '')} &middot; level {sheet.get('level')} &middot; "
        f"D&amp;D {sheet.get('ruleset', '2024')}"
        + (f" &middot; {src.get('document')}" if src.get("document") else ""),
        st["sub"]))

    # --- abilities
    ab = sheet.get("abilities", {})
    flow.append(Paragraph("Abilities", st["h2"]))
    flow.append(stat_row([
        (k, ab.get(k, {}).get("score", "—"),
         f"{sign(ab.get(k, {}).get('mod', 0))} / sv {sign(ab.get(k, {}).get('save', 0))}")
        for k in ABILITY_ORDER
    ], st))
    flow.append(Spacer(1, 7))

    # --- core
    core = [
        ("AC", sheet.get("ac", "—"), sheet.get("acSource", "")),
        ("HP", sheet.get("hp", "—"), f"d{sheet.get('hitDie', 8)} hit dice"),
        ("Init", sign(sheet.get("initiative", 0)), ""),
        ("Speed", sheet.get("speed", 30), "feet"),
        ("Prof", sign(sheet.get("proficiencyBonus", 2)), ""),
        ("Passive", sheet.get("passivePerception", 10), "perception"),
    ]
    sc = sheet.get("spellcasting")
    if sc:
        core.append(("Spell DC", sc.get("saveDc", "—"),
                     f"{str(sc.get('ability', '')).upper()} {sign(sc.get('attackBonus', 0))} atk"))
    flow.append(Paragraph("Defence &amp; core", st["h2"]))
    flow.append(stat_row(core, st))

    subs = sheet.get("substitutions") or {}
    if subs:
        txt = "; ".join(
            f"{v['with'].upper()} replaces {v['replace'].upper()} for {k}"
            for k, v in subs.items()
        )
        flow.append(Spacer(1, 4))
        flow.append(Paragraph(f"Ability substitution: {txt}", st["note"]))

    # --- attacks
    attacks = sheet.get("attacks") or []
    if attacks:
        flow.append(Paragraph("Attacks", st["h2"]))
        rows = [["Attack", "Bonus", "Damage", "Mastery"]]
        for a in attacks:
            dmg = f"{a.get('damage', '')}"
            if a.get("damageBonus"):
                dmg += sign(a["damageBonus"])
            types = "/".join(a.get("types") or [])
            rows.append([a.get("name", ""), sign(a.get("bonus", 0)),
                         f"{dmg} {types}".strip(), a.get("mastery") or "—"])
        flow.append(grid(rows, [62 * mm, 20 * mm, 60 * mm, 34 * mm], st,
                         header=True, align_mono=(1, 2, 3)))

    riders = sheet.get("riders") or []
    if riders:
        flow.append(Paragraph(
            "Riders: " + " · ".join(
                f"+{r['dice']} {r.get('type') or ''} on {r.get('trigger')}"
                for r in riders), st["note"]))

    # --- resources and slots
    res = sheet.get("resources") or []
    if res:
        flow.append(Paragraph("Resources", st["h2"]))
        rows = [["Pool", "Max", "Recharge", "Track"]]
        for r in res:
            # ASCII checkboxes: Helvetica has no U+25A1 and reportlab
            # substitutes a FILLED square, which reads as "already spent".
            boxes = " ".join("[ ]" for _ in range(min(int(r.get("max") or 0), 12)))
            rows.append([r.get("name", ""), str(r.get("max", "")),
                         r.get("recharge", ""), boxes])
        flow.append(grid(rows, [50 * mm, 16 * mm, 26 * mm, 84 * mm], st,
                         header=True, align_mono=(1, 2, 3)))

    if sc and sc.get("slots"):
        flow.append(Paragraph("Spell slots", st["h2"]))
        rows = []
        for i, n in enumerate(sc["slots"], start=1):
            rows.append([f"Level {i}", " ".join("[ ]" for _ in range(int(n)))])
        flow.append(grid(rows, [26 * mm, 150 * mm], st, align_mono=(0, 1)))
        if sc.get("alwaysPrepared"):
            flow.append(Paragraph("Always prepared", st["h2"]))
            flow.append(Paragraph(" · ".join(sc["alwaysPrepared"]), st["body"]))

    # --- actions and stances
    actions = sheet.get("actions") or []
    if actions:
        flow.append(Paragraph("Actions", st["h2"]))
        rows = [["Name", "Action", "Cost"]]
        for a in actions:
            rows.append([a.get("name", ""), a.get("action", ""), a.get("cost") or "—"])
        flow.append(grid(rows, [86 * mm, 44 * mm, 46 * mm], st,
                         header=True, align_mono=(1, 2)))

    toggles = sheet.get("toggles") or []
    for t in toggles:
        flow.append(Paragraph(
            f"<b>{t.get('name')}:</b> {' / '.join(t.get('options') or [])} "
            f"<font size=7 color='#3a4247'>(switchable)</font>", st["body"]))

    # --- features
    feats = [f for f in (sheet.get("features") or [])
             if "Ability Score" not in f.get("name", "")]
    if feats:
        flow.append(Paragraph("Features", st["h2"]))
        rows = [["Lvl", "Feature", "From"]]
        for f in feats:
            rows.append([str(f.get("level", "")), f.get("name", ""), f.get("origin", "")])
        flow.append(grid(rows, [14 * mm, 90 * mm, 72 * mm], st,
                         header=True, align_mono=(0,)))

    # --- roll tables
    for t in sheet.get("rollTables") or []:
        rows = [[str(e["n"]), e["text"]] for e in t.get("entries", [])]
        if not rows:
            continue
        flow.append(KeepTogether([
            Paragraph(f"{t.get('name')} ({t.get('die')})", st["h2"]),
            grid(rows, [12 * mm, 164 * mm], st, align_mono=(0,)),
        ]))

    flow.append(Spacer(1, 10))
    lic = (src.get("licenseUrl") or "")
    flow.append(Paragraph(
        "Generated by Toon Anvil from the same derivation engine the app plays with. "
        + (f"Source licence: {lic}" if lic else ""), st["note"]))

    doc.build(flow)
    return out_path


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    sheet = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = build(sheet, Path(sys.argv[2]))
    print(f"wrote {out}  {out.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
