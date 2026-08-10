"""The soak run's notebook: findings go to disk the moment they are proved.

A long unattended hunt has one failure mode that ruins it - the findings
living only in the head of whatever is doing the hunting. A crash, a
timeout, a closed session, and eight hours of work is a vague memory.

So every confirmed finding is appended to soak/findings.jsonl the instant
it is confirmed, and SOAK-REPORT.md is regenerated from that file rather
than written by hand. Stop at any moment and the to-do list on disk is
complete and current.

    python tools/soak.py add < finding.json     # append one finding
    python tools/soak.py report                 # regenerate the markdown
    python tools/soak.py list                   # one line each, for triage

Append-only on purpose, same as the event log and the gym history: a
finding that turns out to be wrong gets a superseding entry, never a
silent edit. The report shows the LAST entry for each id, so revising a
finding means re-adding it with the same id.

Stdlib only, like everything else here.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOAK = ROOT / "soak"
FINDINGS = SOAK / "findings.jsonl"
REPORT = ROOT / "SOAK-REPORT.md"

# Ordered worst-first: this is the order the report is written in, and the
# order we should read it in together.
SEVERITIES = ["critical", "high", "medium", "low", "idea"]

# What each severity means, so the labels stay honest across a long run.
SEVERITY_NOTE = {
    "critical": "A security hole or data loss. Fix before the next session.",
    "high": "Breaks a shipped feature in normal play. A DM or player hits this.",
    "medium": "Wrong or confusing, but there is a way round it.",
    "low": "Papercut, polish, or a latent trap that needs an odd setup.",
    "idea": "Not a defect - an expansion or refinement worth discussing.",
}

FIELDS = ("id", "severity", "area", "title", "evidence", "repro",
          "scenario", "proposal", "effort", "status")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def add(finding: dict) -> dict:
    """Append one finding. Returns it, stamped."""
    missing = [f for f in ("id", "severity", "title") if not finding.get(f)]
    if missing:
        raise SystemExit(f"finding needs {', '.join(missing)}")
    if finding["severity"] not in SEVERITIES:
        raise SystemExit(f"severity must be one of {', '.join(SEVERITIES)}")
    finding.setdefault("status", "confirmed")
    finding["at"] = now_iso()
    SOAK.mkdir(parents=True, exist_ok=True)
    with FINDINGS.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(finding, ensure_ascii=False) + "\n")
    return finding


def read_all() -> list[dict]:
    """Every finding, last-write-wins per id, in severity then id order."""
    if not FINDINGS.exists():
        return []
    latest: dict[str, dict] = {}
    for line in FINDINGS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            f = json.loads(line)
        except json.JSONDecodeError:
            continue  # a torn last line must not lose the rest of the run
        latest[f.get("id", "?")] = f
    def key(f):
        sev = f.get("severity", "low")
        return (SEVERITIES.index(sev) if sev in SEVERITIES else 99,
                f.get("id", ""))
    return sorted(latest.values(), key=key)


def _block(f: dict) -> list[str]:
    out = [f"### {f['id']} — {f['title']}", ""]
    bits = [f"**{f['severity'].upper()}**"]
    if f.get("area"):
        bits.append(f"area: {f['area']}")
    if f.get("effort"):
        bits.append(f"effort: {f['effort']}")
    status = f.get("status", "confirmed")
    bits.append(f"status: {status}")
    out += [" · ".join(bits), ""]
    for label, field in (("Evidence", "evidence"), ("Reproduction", "repro"),
                         ("Proposed fix", "proposal")):
        if f.get(field):
            out += [f"**{label}.** {f[field]}", ""]
    if f.get("scenario"):
        out += [f"**Gym scenario.** `{f['scenario']}`", ""]
    return out


def report() -> str:
    findings = read_all()
    counts = {s: sum(1 for f in findings if f.get("severity") == s)
              for s in SEVERITIES}
    fixed = sum(1 for f in findings if f.get("status") == "fixed")

    out = [
        "# Toon Anvil — soak run findings",
        "",
        f"Generated {now_iso()} from `soak/findings.jsonl` "
        f"({len(findings)} findings, {fixed} already fixed).",
        "",
        "Every item below was **confirmed against a running server**, not "
        "inferred from reading. Anything I could not reproduce is not here.",
        "",
        "| Severity | Count | Means |",
        "| --- | --- | --- |",
    ]
    for s in SEVERITIES:
        if counts[s]:
            out.append(f"| {s} | {counts[s]} | {SEVERITY_NOTE[s]} |")
    out.append("")

    for s in SEVERITIES:
        group = [f for f in findings if f.get("severity") == s]
        if not group:
            continue
        out += [f"## {s.capitalize()}", ""]
        for f in group:
            out += _block(f)

    text = "\n".join(out).rstrip() + "\n"
    REPORT.write_text(text, encoding="utf-8")
    return text


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "report"
    if cmd == "add":
        raw = sys.stdin.read().strip()
        if not raw:
            raise SystemExit("nothing on stdin")
        payload = json.loads(raw)
        for f in (payload if isinstance(payload, list) else [payload]):
            got = add(f)
            print(f"logged {got['id']} ({got['severity']})")
        report()
        return 0
    if cmd == "report":
        report()
        print(f"wrote {REPORT} from {len(read_all())} findings")
        return 0
    if cmd == "list":
        for f in read_all():
            mark = "x" if f.get("status") == "fixed" else " "
            print(f"[{mark}] {f['severity']:8} {f['id']:22} {f['title']}")
        return 0
    raise SystemExit("usage: soak.py [add|report|list]")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
